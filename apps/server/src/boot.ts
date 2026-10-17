import { createDb, runMigrations, schema } from "@hekate/db";
import { createBackends, StorageConfigError } from "@hekate/storage";
import { count } from "drizzle-orm";
import { createApp } from "./app.ts";
import { createAudit } from "./audit.ts";
import { createAuth } from "./auth.ts";
import { failureOfJob, purgeErrorReports, recordFailure } from "./error-reports.ts";
import { createFlags } from "./flags.ts";
import { createJobs } from "./jobs.ts";
import { createKeyring, UnknownMasterKeyError } from "./keyring.ts";
import { createMailer } from "./mail.ts";
import { startWorkers } from "./media/workers.ts";
import { deliverDigests, deliverInstant } from "./notifications.ts";
import { playbackSecret } from "./playback.ts";
import { purgeDueProjects } from "./project-purge.ts";
import { purgeRequestLimits } from "./rate-limit.ts";
import { remindDue } from "./reminders.ts";
import { purgeDownloadTickets } from "./routes/downloads.ts";
import type { SetupGate } from "./setup-code.ts";
import { purgeAttempts } from "./sign-in.ts";
import { settingsOrExit } from "./startup.ts";
import { serveWeb } from "./static.ts";
import { createStorage } from "./storage.ts";
import { recordedReconciliation } from "./storage-usage.ts";
import { rewrapBehind, rewrapOrganisation } from "./workspace-keys.ts";
import { purgeDueWorkspaces } from "./workspace-purge.ts";

/**
 * Starts everything a configured server runs: migrations, storage, keys, the job workers and the
 * API with the web app. Exits on settings or storage that cannot work, as it always has.
 */
export async function boot(
  env: Record<string, string | undefined>,
  options: { gate: SetupGate },
): Promise<{
  app: ReturnType<typeof createApp>;
  port: number;
  publicUrl: string;
  /** No owner yet: the first workspace is still to be made. */
  needsOwner: boolean;
  stop: () => Promise<void>;
}> {
  const { config, storageConfig } = settingsOrExit(env);
  if (config.MIGRATE_ON_START) await runMigrations(config.DATABASE_URL);

  // Refuse to start with storage that is unreachable or read-only.
  const backends = await (async () => {
    try {
      const configured = createBackends(storageConfig);
      await configured.checkAll();
      return configured;
    } catch (error) {
      if (!(error instanceof StorageConfigError)) throw error;
      console.error(error.message);
      process.exit(1);
    }
  })();

  const { db, close } = createDb(config.DATABASE_URL);
  const mailer = createMailer({ smtpUrl: config.SMTP_URL, from: config.MAIL_FROM });
  const keyring = createKeyring(db, {
    current: config.MASTER_KEY,
    previous: config.MASTER_KEYS_PREVIOUS,
  });
  const auth = createAuth({
    db,
    secret: config.AUTH_SECRET,
    baseURL: config.PUBLIC_URL,
    trustedOrigins: config.TRUSTED_ORIGINS,
    mailer,
    audit: createAudit(db),
    leakCheck: config.PASSWORD_LEAK_CHECK,
    maxPasskeys: config.MAX_PASSKEYS,
    ssoTrustedOrigins: config.SSO_TRUSTED_ORIGINS,
    keyring,
  });

  // Every organisation key must open with a configured master key; keys wrapped by a
  // previous master key are re-wrapped with the current one (docs/security.md).
  try {
    const { rewrapped } = await keyring.reconcile();
    if (rewrapped > 0) {
      console.log(
        `Re-wrapped ${rewrapped} organisation key(s) with the current master key. MASTER_KEYS_PREVIOUS can now be removed.`,
      );
    }
  } catch (error) {
    if (!(error instanceof UnknownMasterKeyError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
  const storage = createStorage(db, backends, keyring);

  const audit = createAudit(db);
  const flags = createFlags(db);
  const jobs = createJobs({
    connectionString: config.DATABASE_URL,
    onFailure: async (failure) => {
      await recordFailure(db, failureOfJob(failure));
    },
    verbose: () => flags.isOn("worker.verbose"),
  });
  await jobs.start();
  if (config.WORKER) {
    await startWorkers(
      jobs,
      { db, storage, keyring, jobs, ...(config.WORK_DIR ? { workDir: config.WORK_DIR } : {}) },
      config.WORKER_CONCURRENCY,
    );
    await jobs.work("storage-reconcile", async () => {
      const reports = await recordedReconciliation(
        { db, storage, audit },
        { remove: config.STORAGE_RECONCILE === "remove" },
      );
      for (const r of reports) {
        if (r.orphanObjects + r.unreferencedBlobs + r.missingObjects + r.removed === 0) continue;
        console.log(
          `Storage ${r.backend}: ${r.orphanObjects} orphan object(s), ${r.unreferencedBlobs} unused blob(s), ${r.missingObjects} missing, ${r.removed} removed`,
        );
      }
    });
    await jobs.work("notifications-mail", async () => {
      await deliverInstant(db, mailer, config.PUBLIC_URL);
    });
    await jobs.work("notifications-digest", async () => {
      await deliverDigests(db, mailer, config.PUBLIC_URL);
    });
    await jobs.work("sign-in-attempts-purge", async () => {
      await purgeAttempts(db);
      await purgeRequestLimits(db);
      await purgeDownloadTickets(db);
      await purgeErrorReports(db);
    });
    await jobs.work("organisation-rewrap", async ({ organisationId }) => {
      const rewrapped = await rewrapOrganisation(db, keyring, organisationId);
      if (rewrapped > 0)
        console.log(`Rewrapped ${rewrapped} key(s) of workspace ${organisationId}`);
    });
    await jobs.work("workspaces-purge", async () => {
      const purged = await purgeDueWorkspaces(db, backends);
      if (purged > 0) console.log(`Purged ${purged} deleted workspace(s)`);
      // Projects whose deletion was confirmed seven days ago (#240).
      const projects = await purgeDueProjects(db, storage, audit);
      if (projects > 0) console.log(`Deleted ${projects} project(s) for good`);
      const rewrapped = await rewrapBehind(db, keyring);
      if (rewrapped > 0) console.log(`Rewrapped ${rewrapped} key(s) a rotation left behind`);
    });
    await jobs.work("reviews-remind", async () => {
      await remindDue({ db, mailer, audit, publicUrl: config.PUBLIC_URL });
    });
  }

  const app = createApp({
    db,
    auth,
    mailer,
    storage,
    audit,
    jobs,
    keyring,
    playbackSecret: playbackSecret(config.AUTH_SECRET),
    publicUrl: config.PUBLIC_URL,
    trustProxy: config.TRUST_PROXY,
    passwordLeakCheck: config.PASSWORD_LEAK_CHECK,
    requireSecondFactor: config.REQUIRE_SECOND_FACTOR,
    maxPasskeys: config.MAX_PASSKEYS,
    ssoTrustedOrigins: config.SSO_TRUSTED_ORIGINS,
    storageReconcile: config.STORAGE_RECONCILE,
    setupGate: options.gate,
    operatorSecurityKey: config.OPERATOR_SECURITY_KEY,
  });
  if (config.WEB_DIST) serveWeb(app, config.WEB_DIST, { docsUrl: config.HEKATE_DOCS_URL });

  const [owners] = await db.select({ n: count() }).from(schema.users);

  return {
    app,
    port: config.PORT,
    publicUrl: config.PUBLIC_URL,
    needsOwner: (owners?.n ?? 0) === 0,
    // Let running jobs finish (or give up at the timeout) before closing the database.
    stop: () =>
      jobs
        .stop()
        .catch((error: unknown) => console.error("Stopping the job queue failed:", error))
        .then(() => close()),
  };
}

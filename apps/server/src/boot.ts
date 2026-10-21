import { tmpdir } from "node:os";
import {
  createDb,
  DatabaseAheadError,
  DestructiveMigrationError,
  migrationState,
  runMigrations,
  schema,
} from "@hekate/db";
import { createBackends, StorageConfigError } from "@hekate/storage";
import { count } from "drizzle-orm";
import { createApp } from "./app.ts";
import { createAudit } from "./audit.ts";
import { createAuth } from "./auth.ts";
import { failureOfJob, purgeErrorReports, recordFailure } from "./error-reports.ts";
import { createFlags } from "./flags.ts";
import { createInstanceSettings } from "./instance-settings.ts";
import { createJobs, inLanes, jobDefinitions } from "./jobs.ts";
import { createKeyring, UnknownMasterKeyError } from "./keyring.ts";
import { type Role, roleOf } from "./lanes.ts";
import { purgeLogs } from "./log-retention.ts";
import { createMailer, loggedMailer } from "./mail.ts";
import { startWorkers } from "./media/workers.ts";
import { collectFromDatabase, collectQueues, countedMailer } from "./metrics/index.ts";
import { createSampler } from "./metrics/sampler.ts";
import { deliverDigests, deliverInstant } from "./notifications.ts";
import { playbackSecret } from "./playback.ts";
import { purgeDueProjects } from "./project-purge.ts";
import { purgeRequestLimits } from "./rate-limit.ts";
import { remindDue } from "./reminders.ts";
import { purgeDownloadTickets } from "./routes/downloads.ts";
import type { SetupGate } from "./setup-code.ts";
import { purgeAttempts } from "./sign-in.ts";
import { listenForSignals } from "./signals.ts";
import { schemaProblem, settingsOrExit } from "./startup.ts";
import { serveWeb } from "./static.ts";
import { createStorage } from "./storage.ts";
import { recordedReconciliation } from "./storage-usage.ts";
import { checkReleases, recordVersionRun } from "./system-info.ts";
import { remindTasksDue } from "./tasks.ts";
import { clockElapsed, fileMeasured, sweepRuns } from "./workflow-runner.ts";
import { rewrapBehind, rewrapOrganisation } from "./workspace-keys.ts";
import { purgeDueWorkspaces } from "./workspace-purge.ts";

/**
 * Brings the database to this code's schema, or explains why it will not and exits (#154):
 * migrations run only when asked to, one replica at a time, never losing data unasked; without
 * them, a database behind or ahead of the code is named before anything misreads it.
 */
async function migrateOrExit(config: {
  DATABASE_URL: string;
  DATABASE_DIRECT_URL?: string | undefined;
  MIGRATE_ON_START: boolean;
  MIGRATE_ALLOW_DESTRUCTIVE: boolean;
}) {
  // Past any transaction pooler (#412): the migration lock lasts the session.
  const sessionUrl = config.DATABASE_DIRECT_URL ?? config.DATABASE_URL;
  try {
    if (config.MIGRATE_ON_START) {
      const { applied } = await runMigrations(sessionUrl, undefined, {
        allowDestructive: config.MIGRATE_ALLOW_DESTRUCTIVE,
      });
      if (applied.length > 0) console.log(`Migrated: ${applied.join(", ")}.`);
      return;
    }
    const { db, close } = createDb(config.DATABASE_URL, { max: 1 });
    try {
      const state = await migrationState(db);
      const problem = schemaProblem(state);
      if (problem) {
        console.error(problem);
        process.exit(1);
      }
    } finally {
      await close();
    }
  } catch (error) {
    if (!(error instanceof DestructiveMigrationError || error instanceof DatabaseAheadError))
      throw error;
    console.error(error.message);
    process.exit(1);
  }
}

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
  /** What this process does (#189). */
  role: Role;
  /** Stop the jobs, giving those running `timeoutMs` to finish, and close the database. */
  stop: (timeoutMs?: number) => Promise<void>;
}> {
  const { config, storageConfig } = settingsOrExit(env);
  await migrateOrExit(config);

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

  const { db, sql: client, close } = createDb(config.DATABASE_URL);
  // Counted for Prometheus (#70) and written to the mail log (#157).
  const mailer = countedMailer(
    loggedMailer(
      db,
      createMailer({ smtpUrl: config.SMTP_URL, from: config.MAIL_FROM }),
      Boolean(config.SMTP_URL),
    ),
  );
  // Read at each scrape of /metrics (#70).
  collectFromDatabase(db);
  collectQueues(
    db,
    Object.fromEntries(Object.entries(jobDefinitions).map(([name, d]) => [name, d.lane])),
  );
  const keyring = createKeyring(db, {
    current: config.MASTER_KEY,
    previous: config.MASTER_KEYS_PREVIOUS,
  });
  const auth = createAuth({
    db,
    trustProxy: config.TRUST_PROXY,
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
  // Maintenance mode (#154): this process's workers stop taking jobs while it is on, and take
  // them up again when it is over; the queue keeps every job meanwhile.
  const settings = createInstanceSettings(db);
  const holdJobs = async () => {
    try {
      await jobs.hold((await settings.get()).maintenance.on);
    } catch (error) {
      console.error("Could not hold or resume the job workers:", error);
    }
  };
  // Held before any worker is registered, so one starting during maintenance takes nothing.
  await holdJobs();
  const holding = setInterval(holdJobs, 15_000);
  holding.unref();
  // Another replica's change heard at once (#188); the timers above stay as the fallback.
  // LISTEN needs a session of its own, past any transaction pooler (#412).
  const listening = config.DATABASE_DIRECT_URL
    ? createDb(config.DATABASE_DIRECT_URL, { max: 1 })
    : null;
  const unlisten = await listenForSignals(listening?.sql ?? client, (what) => {
    if (what === "flags") return flags.forget();
    settings.forget();
    void holdJobs();
  });

  // What this process does (#189): requests, background jobs in the lanes it takes, or both.
  const role = roleOf(config.ROLE, config.WORKER);
  if (role !== "api") {
    const taking = inLanes(jobs, config.WORKER_LANES);
    await startWorkers(
      taking,
      {
        db,
        storage,
        keyring,
        jobs,
        ...(config.WORK_DIR ? { workDir: config.WORK_DIR } : {}),
        ...(config.ADM_RENDERER_PATH ? { admRenderer: config.ADM_RENDERER_PATH } : {}),
        videoLadder: {
          rungs: config.VIDEO_LADDER,
          most: config.VIDEO_RUNGS,
          royaltyFree: config.VIDEO_ROYALTY_FREE === "off" ? null : config.VIDEO_ROYALTY_FREE,
          hardware: config.VIDEO_HARDWARE ?? null,
        },
      },
      config.WORKER_CONCURRENCY,
    );
    await taking.work("storage-reconcile", async () => {
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
    await taking.work("release-check", async () => {
      // Off, the instance asks nothing of anyone: the job finds nothing to do.
      if (config.HEKATE_UPDATE_CHECK) await checkReleases(db);
    });
    await taking.work("notifications-mail", async () => {
      await deliverInstant(db, mailer, config.PUBLIC_URL);
    });
    await taking.work("notifications-digest", async () => {
      await deliverDigests(db, mailer, config.PUBLIC_URL);
    });
    await taking.work("logs-retention", async () => {
      const purged = await purgeLogs(db, (await settings.get()).logs);
      if (purged.audit + purged.auth + purged.mail > 0)
        console.log(
          `Logs trimmed: ${purged.audit} audit, ${purged.auth} authentication, ${purged.mail} mail`,
        );
    });
    await taking.work("sign-in-attempts-purge", async () => {
      await purgeAttempts(db);
      await purgeRequestLimits(db);
      await purgeDownloadTickets(db);
      await purgeErrorReports(db);
    });
    await taking.work("organisation-rewrap", async ({ organisationId }) => {
      const rewrapped = await rewrapOrganisation(db, keyring, organisationId);
      if (rewrapped > 0)
        console.log(`Rewrapped ${rewrapped} key(s) of workspace ${organisationId}`);
    });
    await taking.work("workspaces-purge", async () => {
      const purged = await purgeDueWorkspaces(db, backends);
      if (purged > 0) console.log(`Purged ${purged} deleted workspace(s)`);
      // Projects whose deletion was confirmed seven days ago (#240).
      const projects = await purgeDueProjects(db, storage, audit);
      if (projects > 0) console.log(`Deleted ${projects} project(s) for good`);
      const rewrapped = await rewrapBehind(db, keyring);
      if (rewrapped > 0) console.log(`Rewrapped ${rewrapped} key(s) a rotation left behind`);
    });
    await taking.work("reviews-remind", async () => {
      await remindDue({ db, mailer, audit, publicUrl: config.PUBLIC_URL });
      // Tasks due today or late (#140), on the same hour.
      await remindTasksDue(db);
    });
    // A wait that ends may lead to a stage that asks for a review (#25).
    const runner = {
      db,
      jobs,
      reviews: { db, audit, mailer, publicUrl: config.PUBLIC_URL, trustProxy: false },
    };
    await taking.work("workflow-wait", async (data) => {
      await clockElapsed(runner, data);
    });
    await taking.work("workflow-checks", async (data) => {
      await fileMeasured(runner, data);
    });
    await taking.work("workflow-waits-sweep", async () => {
      await sweepRuns(runner);
    });
  }

  // The release this process runs joins the instance's history (#158).
  await recordVersionRun(db).catch((error: unknown) =>
    console.error("Could not record the release running:", error),
  );

  // The machine, measured a minute at a time for System health (#156).
  const sampler = createSampler(db);
  const stopSampling = sampler.start();

  const app = createApp({
    db,
    sampler,
    storageDescribed: storageConfig.backends.map((b) => ({
      name: b.name,
      driver: b.driver,
      where:
        b.driver === "local"
          ? b.root
          : `s3://${b.bucket}${b.prefix ? `/${b.prefix}` : ""}${b.region ? ` · ${b.region}` : ""}`,
    })),
    previousMasterKeys: config.MASTER_KEYS_PREVIOUS.length,
    modules: {
      billing: config.HEKATE_BILLING,
      support: config.HEKATE_SUPPORT,
      docsUrl: config.HEKATE_DOCS_URL,
      statusUrl: config.HEKATE_STATUS_URL ?? null,
    },
    diskPath:
      storageConfig.backends.flatMap((b) => (b.driver === "local" ? [b.root] : []))[0] ??
      config.WORK_DIR ??
      tmpdir(),
    settings,
    build: config.HEKATE_BUILD,
    updateCheck: config.HEKATE_UPDATE_CHECK,
    smtp: Boolean(config.SMTP_URL),
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
    workDir: config.WORK_DIR,
    metricsToken: config.METRICS_TOKEN,
  });
  if (config.WEB_DIST && role !== "worker")
    serveWeb(app, config.WEB_DIST, { docsUrl: config.HEKATE_DOCS_URL });

  const [owners] = await db.select({ n: count() }).from(schema.users);

  return {
    app,
    role,
    port: config.PORT,
    publicUrl: config.PUBLIC_URL,
    needsOwner: (owners?.n ?? 0) === 0,
    // Let running jobs finish (or give up at the timeout) before closing the database.
    stop: (timeoutMs?: number) =>
      Promise.resolve(clearInterval(holding))
        .then(unlisten)
        .then(() => listening?.close())
        .then(stopSampling)
        .then(() => jobs.stop(timeoutMs))
        .catch((error: unknown) => console.error("Stopping the job queue failed:", error))
        .then(() => close()),
  };
}

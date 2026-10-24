import { tmpdir } from "node:os";
import { createDb, schema } from "@hekate/db";
import { createBackends, StorageConfigError } from "@hekate/storage";
import { count } from "drizzle-orm";
import { createApp } from "./app.ts";
import { createAudit } from "./audit.ts";
import { createAuth } from "./auth.ts";
import { runDunning } from "./billing/billing.ts";
import { stripeClient } from "./billing/stripe.ts";
import { stripeGateway } from "./billing/stripe-gateway.ts";
import { brandedMailer } from "./branding.ts";
import { createSend } from "./channels.ts";
import { failureOfJob, purgeErrorReports, recordFailure } from "./error-reports.ts";
import { deliver, dispatchEvents, onEventWritten } from "./events.ts";
import { buildExport, expireExports, exportFailed } from "./export/workspace-export.ts";
import { createFlags } from "./flags.ts";
import { subdomainsOf } from "./hosts.ts";
import { createInstanceSettings } from "./instance-settings.ts";
import { createJobs, inLanes, jobDefinitions } from "./jobs.ts";
import { createKeyring, UnknownMasterKeyError } from "./keyring.ts";
import { type Role, roleOf } from "./lanes.ts";
import { createListeningHub, listenForRooms } from "./listening.ts";
import { purgeLogs } from "./log-retention.ts";
import { createMailer, loggedMailer, mailTransportOf } from "./mail.ts";
import { bounceProviderOf, instanceBouncesOf } from "./mail-bounces.ts";
import { usePdfFonts } from "./media/pdf-text.ts";
import { startWorkers } from "./media/workers.ts";
import { collectFromDatabase, collectQueues, countedMailer } from "./metrics/index.ts";
import { createSampler } from "./metrics/sampler.ts";
import { deliverDigests, deliverInstant } from "./notifications.ts";
import { purgeOAuth } from "./oauth.ts";
import { playbackSecret } from "./playback.ts";
import { purgeDueProjects } from "./project-purge.ts";
import { purgeRequestLimits } from "./rate-limit.ts";
import { remindDue } from "./reminders.ts";
import { versionFromRequest } from "./request-versions.ts";
import { purgeDownloadTickets } from "./routes/downloads.ts";
import type { SetupGate } from "./setup-code.ts";
import { purgeAttempts } from "./sign-in.ts";
import { listenForSignals } from "./signals.ts";
import { migrateOrExit, settingsOrExit } from "./startup.ts";
import { serveWeb } from "./static.ts";
import { createStorage } from "./storage.ts";
import { recordedReconciliation } from "./storage-usage.ts";
import { checkReleases, recordVersionRun } from "./system-info.ts";
import { remindTasksDue } from "./tasks.ts";
import { startTelemetry } from "./telemetry.ts";
import { refreshUsage } from "./usage.ts";
import { clockElapsed, fileMeasured, sweepRuns } from "./workflow-runner.ts";
import { rewrapBehind, rewrapOrganisation } from "./workspace-keys.ts";
import { routedMailer } from "./workspace-mail.ts";
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
  /** What this process does (#189). */
  role: Role;
  /** How it stops (#193), as its settings say. */
  shutdown: { drainMs: number; timeoutMs: number };
  /** Stop the jobs, giving those running `timeoutMs` to finish, and close the database. */
  stop: (timeoutMs?: number) => Promise<void>;
}> {
  const { config, storageConfig } = settingsOrExit(env);
  // Before anything else runs, so its spans and log lines reach the collector (#162).
  const telemetry = await startTelemetry(config);
  await migrateOrExit(config);
  // The fonts PDFs set text outside WinAnsi in (decision 238); Helvetica alone without them.
  const pdfFonts = usePdfFonts({
    regular: config.PDF_FONT,
    bold: config.PDF_FONT_BOLD,
    fallback: config.PDF_FONT_FALLBACK,
  });
  for (const problem of pdfFonts.problems) console.warn(`A PDF font was left out: ${problem}`);

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
  const mailTransport = mailTransportOf(config);
  const keyring = createKeyring(db, {
    current: config.MASTER_KEY,
    previous: config.MASTER_KEYS_PREVIOUS,
  });
  // A workspace's own mail sends what is sent for it (#161); the instance's sends the rest.
  // Either way it carries the workspace's logo and accent (#185).
  const mailer = brandedMailer(
    countedMailer(
      loggedMailer(
        db,
        routedMailer({
          db,
          keyring,
          instance: createMailer({ transport: mailTransport, from: config.MAIL_FROM }),
          trusted: config.WEBHOOK_TRUSTED_ORIGINS,
        }),
        mailTransport.kind !== "log",
      ),
    ),
    db,
    config.PUBLIC_URL,
  );
  // Read at each scrape of /metrics (#70).
  collectFromDatabase(db);
  collectQueues(
    db,
    Object.fromEntries(Object.entries(jobDefinitions).map(([name, d]) => [name, d.lane])),
  );
  // The billing gateway (#178), with HEKATE_BILLING=stripe; the settings check made sure of
  // its keys.
  const gateway =
    config.HEKATE_BILLING === "stripe" && config.STRIPE_SECRET_KEY && config.STRIPE_WEBHOOK_SECRET
      ? stripeGateway({
          stripe: stripeClient({ secretKey: config.STRIPE_SECRET_KEY }),
          webhookSecret: config.STRIPE_WEBHOOK_SECRET,
          tax: config.STRIPE_TAX,
        })
      : null;
  // Workspace subdomains (#176), where they are on.
  const subdomains = subdomainsOf(config.PUBLIC_URL, config.WORKSPACE_SUBDOMAINS);
  // What links in mail are made from: each workspace's own address with subdomains on (#437).
  const links = { publicUrl: config.PUBLIC_URL, subdomains };
  const billing = {
    db,
    gateway,
    mailer,
    ...links,
    // The rules as an operator last set them (#180), read when the job runs.
    rules: async () => (await settings.get()).billing,
  };
  const auth = createAuth({
    db,
    subdomains,
    billing: config.HEKATE_BILLING !== "off",
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
  // A listening room moved on another replica (#200) wakes this one's streams of it.
  const rooms = createListeningHub();
  const unlistenRooms = await listenForRooms(listening?.sql ?? client, rooms);

  // An event written is dispatched a moment later, once its transaction has committed (#161).
  onEventWritten(() => {
    void jobs
      .send("events-dispatch", {}, { singletonKey: "events-dispatch", startAfterSeconds: 2 })
      .catch((error: unknown) =>
        console.warn(`Could not queue the event dispatch now: ${String(error)}`),
      );
  });
  const sendToChannel = createSend(config.WEBHOOK_TRUSTED_ORIGINS);

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
      await deliverInstant(db, mailer, links);
    });
    await taking.work("notifications-digest", async () => {
      await deliverDigests(db, mailer, links);
    });
    await taking.work("events-dispatch", async () => {
      await dispatchEvents(db, jobs);
    });
    const delivering = { db, keyring, jobs, send: sendToChannel, ...links };
    await taking.work(
      "event-delivery",
      async ({ organisationId, deliveryId }) => {
        await deliver(delivering, organisationId, deliveryId);
      },
      { concurrency: 4 },
    );
    await taking.work("logs-retention", async () => {
      const purged = await purgeLogs(db, (await settings.get()).logs);
      if (purged.audit + purged.auth + purged.mail + purged.webhooks > 0)
        console.log(
          `Logs trimmed: ${purged.audit} audit, ${purged.auth} authentication, ${purged.mail} mail, ${purged.webhooks} events`,
        );
    });
    await taking.work("sign-in-attempts-purge", async () => {
      await purgeAttempts(db);
      await purgeRequestLimits(db);
      await purgeDownloadTickets(db);
      await purgeErrorReports(db);
      await purgeOAuth(db);
    });
    await taking.work("organisation-rewrap", async ({ organisationId }) => {
      const rewrapped = await rewrapOrganisation(db, keyring, organisationId);
      if (rewrapped > 0)
        console.log(`Rewrapped ${rewrapped} key(s) of workspace ${organisationId}`);
    });
    await taking.work("usage-refresh", async () => {
      await refreshUsage(db);
    });
    await taking.work("billing-dunning", async () => {
      const steps = await runDunning(billing);
      if (steps > 0) console.log(`Dunning took ${steps} step(s)`);
    });
    await taking.work("workspace-export", async ({ organisationId, exportId }, job) => {
      try {
        await buildExport({ db, storage }, organisationId, exportId, job.signal);
      } catch (error) {
        // The last attempt: its list says it failed, and the error report says why (#159).
        if (job.retryCount >= (jobDefinitions["workspace-export"].options.retryLimit ?? 0))
          await exportFailed(db, organisationId, exportId);
        throw error;
      }
    });
    await taking.work("workspaces-purge", async () => {
      const purged = await purgeDueWorkspaces(db, backends, new Date(), keyring);
      if (purged > 0) console.log(`Purged ${purged} deleted workspace(s)`);
      // Exports a week old (#186), and any whose job was lost.
      const expired = await expireExports(db, storage);
      if (expired > 0) console.log(`Removed ${expired} workspace export(s) past their week`);
      // Projects whose deletion was confirmed seven days ago (#240).
      const projects = await purgeDueProjects(db, storage, audit);
      if (projects > 0) console.log(`Deleted ${projects} project(s) for good`);
      const rewrapped = await rewrapBehind(db, keyring);
      if (rewrapped > 0) console.log(`Rewrapped ${rewrapped} key(s) a rotation left behind`);
    });
    await taking.work("reviews-remind", async () => {
      await remindDue({ db, mailer, audit, ...links });
      // Tasks due today or late (#140), on the same hour.
      await remindTasksDue(db);
    });
    // A wait that ends may lead to a stage that asks for a review (#25).
    const runner = {
      db,
      jobs,
      reviews: { db, audit, mailer, ...links, trustProxy: false },
    };
    await taking.work("workflow-wait", async (data) => {
      await clockElapsed(runner, data);
    });
    await taking.work("workflow-checks", async (data) => {
      // A file an upload request sent to a track becomes its next version now (#425), before
      // the workflows look at what was measured.
      await versionFromRequest({ ...runner, storage, mailer, ...links }, data);
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
    gateway,
    modules: {
      billing: config.HEKATE_BILLING,
      support: config.HEKATE_SUPPORT,
      supportAddress: config.HEKATE_SUPPORT_ADDRESS ?? null,
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
    mail: mailTransport.kind,
    auth,
    mailer,
    storage,
    audit,
    jobs,
    keyring,
    playbackSecret: playbackSecret(config.AUTH_SECRET),
    publicUrl: config.PUBLIC_URL,
    subdomains,
    trustProxy: config.TRUST_PROXY,
    passwordLeakCheck: config.PASSWORD_LEAK_CHECK,
    requireSecondFactor: config.REQUIRE_SECOND_FACTOR,
    maxPasskeys: config.MAX_PASSKEYS,
    ssoTrustedOrigins: config.SSO_TRUSTED_ORIGINS,
    webhookTrustedOrigins: config.WEBHOOK_TRUSTED_ORIGINS,
    instanceBounces: instanceBouncesOf(config),
    bounceProvider: bounceProviderOf(config),
    storageReconcile: config.STORAGE_RECONCILE,
    setupGate: options.gate,
    operatorSecurityKey: config.OPERATOR_SECURITY_KEY,
    workDir: config.WORK_DIR,
    metricsToken: config.METRICS_TOKEN,
    telemetry: config.OTEL_EXPORTER_OTLP_ENDPOINT,
    listening: rooms,
  });
  if (config.WEB_DIST && role !== "worker")
    serveWeb(app, config.WEB_DIST, { docsUrl: config.HEKATE_DOCS_URL });

  const [owners] = await db.select({ n: count() }).from(schema.users);

  return {
    app,
    role,
    shutdown: {
      drainMs: config.SHUTDOWN_DRAIN_SECONDS * 1000,
      timeoutMs: config.SHUTDOWN_TIMEOUT_SECONDS * 1000,
    },
    port: config.PORT,
    publicUrl: config.PUBLIC_URL,
    needsOwner: (owners?.n ?? 0) === 0,
    // Let running jobs finish (or give up at the timeout) before closing the database.
    stop: (timeoutMs?: number) =>
      Promise.resolve(clearInterval(holding))
        .then(unlisten)
        .then(unlistenRooms)
        .then(() => listening?.close())
        .then(stopSampling)
        .then(() => jobs.stop(timeoutMs))
        .catch((error: unknown) => console.error("Stopping the job queue failed:", error))
        .then(() => close())
        .then(() => telemetry.shutdown()),
  };
}

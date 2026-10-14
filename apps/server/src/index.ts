import { createDb, runMigrations } from "@hekate/db";
import { createBackends, StorageConfigError, storageConfigFromEnv } from "@hekate/storage";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { createAudit } from "./audit.ts";
import { createAuth } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { createJobs } from "./jobs.ts";
import { createKeyring, UnknownMasterKeyError } from "./keyring.ts";
import { createMailer } from "./mail.ts";
import { startMediaWorkers } from "./media/workers.ts";
import { serveWeb } from "./static.ts";
import { createStorage } from "./storage.ts";
import { version } from "./version.ts";

const config = (() => {
  try {
    return loadConfig();
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
})();
if (config.MIGRATE_ON_START) await runMigrations(config.DATABASE_URL);

// Refuse to start with storage that is misconfigured, unreachable or read-only.
const backends = await (async () => {
  try {
    const configured = createBackends(storageConfigFromEnv());
    await configured.checkAll();
    return configured;
  } catch (error) {
    if (!(error instanceof StorageConfigError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
})();

const { db, close } = createDb(config.DATABASE_URL);
const auth = createAuth({
  db,
  secret: config.AUTH_SECRET,
  baseURL: config.PUBLIC_URL,
  trustedOrigins: config.TRUSTED_ORIGINS,
});

const mailer = createMailer({ smtpUrl: config.SMTP_URL, from: config.MAIL_FROM });
const keyring = createKeyring(db, {
  current: config.MASTER_KEY,
  previous: config.MASTER_KEYS_PREVIOUS,
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

const jobs = createJobs({ connectionString: config.DATABASE_URL });
await jobs.start();
if (config.WORKER) {
  await startMediaWorkers(
    jobs,
    { db, storage, ...(config.WORK_DIR ? { workDir: config.WORK_DIR } : {}) },
    config.WORKER_CONCURRENCY,
  );
}

const audit = createAudit(db);
const app = createApp({
  db,
  auth,
  mailer,
  storage,
  audit,
  publicUrl: config.PUBLIC_URL,
  trustProxy: config.TRUST_PROXY,
});
if (config.WEB_DIST) serveWeb(app, config.WEB_DIST);

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`Hekate ${version} listening on :${info.port}`);
});

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    server.close();
    // Let running jobs finish (or give up at the timeout) before closing the database.
    void jobs
      .stop()
      .catch((error: unknown) => console.error("Stopping the job queue failed:", error))
      .then(() => close())
      .then(() => process.exit(0));
  });
}

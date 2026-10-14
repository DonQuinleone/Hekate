import { createDb, runMigrations } from "@hekate/db";
import { createBackends, StorageConfigError, storageConfigFromEnv } from "@hekate/storage";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { createMailer } from "./mail.ts";
import { serveWeb } from "./static.ts";
import { createStorage } from "./storage.ts";
import { version } from "./version.ts";

const config = loadConfig();
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
const storage = createStorage(db, backends);
const app = createApp({ db, auth, mailer, storage, publicUrl: config.PUBLIC_URL });
if (config.WEB_DIST) serveWeb(app, config.WEB_DIST);

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`Hekate ${version} listening on :${info.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    void close().then(() => process.exit(0));
  });
}

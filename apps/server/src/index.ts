import { createDb, runMigrations } from "@hekate/db";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { serveWeb } from "./static.ts";
import { version } from "./version.ts";

const config = loadConfig();
if (config.MIGRATE_ON_START) await runMigrations(config.DATABASE_URL);

const { db, close } = createDb(config.DATABASE_URL);
const auth = createAuth({
  db,
  secret: config.AUTH_SECRET,
  baseURL: config.PUBLIC_URL,
  trustedOrigins: config.TRUSTED_ORIGINS,
});

const app = createApp({ db, auth });
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

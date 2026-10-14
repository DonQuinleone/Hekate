import { createDb, runMigrations } from "@hekate/db";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { serveWeb } from "./static.ts";
import { ensureDefaultOrganisation } from "./tenancy.ts";
import { version } from "./version.ts";

const config = loadConfig();
if (config.MIGRATE_ON_START) await runMigrations(config.DATABASE_URL);

const { db, close } = createDb(config.DATABASE_URL);
let defaultOrganisation: Promise<string> | undefined;
const organisationId = () => {
  defaultOrganisation ??= ensureDefaultOrganisation(db, config.DEFAULT_ORGANISATION).catch(
    (err) => {
      defaultOrganisation = undefined;
      throw err;
    },
  );
  return defaultOrganisation;
};

const app = createApp({ db, organisationId });
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

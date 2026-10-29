// Hekate's command line, run beside the server with the same settings:
//   node src/cli.ts backup verify [--sample N]
//   node src/cli.ts migrate
//   node src/cli.ts demo seed
// In the app image: docker compose run --rm app apps/server/src/cli.ts backup verify
import { createDb } from "@hekate/db";
import { createBackends } from "@hekate/storage";
import { describeReport, verifyBackup } from "./backup-verify.ts";
import { demoSeed } from "./demo/command.ts";
import { createKeyring } from "./keyring.ts";
import { readSettingsFile, settingsPath, withSettings } from "./settings-file.ts";
import { migrateOrExit, settingsOrExit } from "./startup.ts";
import { createStorage } from "./storage.ts";

const usage = `Usage:
  cli.ts backup verify [--sample N]   check a restored database, its storage and the master
                                      key belong together (N files are read in full; 20 by default)
  cli.ts migrate                      bring the database to this version's schema, as a server
                                      started with MIGRATE_ON_START does, and stop (#190)
  cli.ts demo seed                    fill the demo (HEKATE_DEMO=1, PUBLIC_URL at localhost) with
                                      sample data through its API, and print the sign-ins`;

const [area, command, ...rest] = process.argv.slice(2);
// Migrating before the servers start (a Kubernetes Job, say), so none of them waits on it.
if (area === "migrate" && command === undefined) {
  const { config } = settingsOrExit(
    withSettings(process.env, readSettingsFile(settingsPath(process.env))),
  );
  await migrateOrExit({ ...config, MIGRATE_ON_START: true });
  console.log("The database is up to date.");
  process.exit(0);
}
// The demo's sample data (decision 265), through the running server's API.
if (area === "demo" && command === "seed") {
  const { config } = settingsOrExit(
    withSettings(process.env, readSettingsFile(settingsPath(process.env))),
  );
  process.exit(await demoSeed(config));
}
if (area !== "backup" || command !== "verify") {
  console.error(usage);
  process.exit(2);
}
const at = rest.indexOf("--sample");
const sample = at >= 0 ? Number(rest[at + 1]) : 20;
if (!Number.isInteger(sample) || sample < 0) {
  console.error("--sample takes a whole number");
  process.exit(2);
}

const { config, storageConfig } = settingsOrExit(
  withSettings(process.env, readSettingsFile(settingsPath(process.env))),
);
const { db, close } = createDb(config.DATABASE_URL);
const keyring = createKeyring(db, {
  current: config.MASTER_KEY,
  previous: config.MASTER_KEYS_PREVIOUS,
});
const storage = createStorage(db, createBackends(storageConfig), keyring);
try {
  const report = await verifyBackup({ db, storage, keyring }, { sample });
  console.log(describeReport(report));
  process.exitCode = report.ok ? 0 : 1;
} finally {
  await close();
}

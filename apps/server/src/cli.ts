// Hekate's command line, run beside the server with the same settings:
//   node src/cli.ts backup verify [--sample N]
// In the app image: docker compose run --rm app apps/server/src/cli.ts backup verify
import { createDb } from "@hekate/db";
import { createBackends } from "@hekate/storage";
import { describeReport, verifyBackup } from "./backup-verify.ts";
import { createKeyring } from "./keyring.ts";
import { settingsOrExit } from "./startup.ts";
import { createStorage } from "./storage.ts";

const usage = `Usage:
  cli.ts backup verify [--sample N]   check a restored database, its storage and the master
                                      key belong together (N files are read in full; 20 by default)`;

const [area, command, ...rest] = process.argv.slice(2);
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

const { config, storageConfig } = settingsOrExit();
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

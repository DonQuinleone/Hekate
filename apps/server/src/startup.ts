import {
  createDb,
  DatabaseAheadError,
  DestructiveMigrationError,
  migrationState,
  runMigrations,
} from "@hekate/db";
import { type StorageConfig, StorageConfigError, storageConfigFromEnv } from "@hekate/storage";
import {
  type Config,
  ConfigError,
  type ConfigProblem,
  formatProblems,
  loadConfig,
} from "./config.ts";

/**
 * Every setting checked before anything starts, configuration and storage together, with
 * every problem reported at once; exits when there are any. The server and the command line
 * both start here.
 */
export function settingsOrExit(env: Record<string, string | undefined> = process.env): {
  config: Config;
  storageConfig: StorageConfig;
} {
  const checked = settingsOrProblems(env);
  if ("problems" in checked) {
    console.error(formatProblems(checked.problems));
    process.exit(1);
  }
  return checked;
}

/** The same check, returning the problems rather than exiting: the installer reports them. */
export function settingsOrProblems(
  env: Record<string, string | undefined>,
): { config: Config; storageConfig: StorageConfig } | { problems: ConfigProblem[] } {
  const problems: ConfigProblem[] = [];
  let config: Config | undefined;
  let storageConfig: StorageConfig | undefined;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    problems.push(...error.problems);
  }
  try {
    storageConfig = storageConfigFromEnv(env);
  } catch (error) {
    if (!(error instanceof StorageConfigError)) throw error;
    for (const problem of error.problems) {
      const at = problem.indexOf(": ");
      problems.push(
        at > 0
          ? { name: problem.slice(0, at), message: problem.slice(at + 2) }
          : { name: "STORAGE", message: problem },
      );
    }
  }
  if (problems.length > 0 || !config || !storageConfig) return { problems };
  return { config, storageConfig };
}

/** What to do when the database and the code disagree, or nothing when they agree. */
export function schemaProblem(state: {
  fresh: boolean;
  pending: { tag: string }[];
  ahead: boolean;
}): string | null {
  if (state.ahead) return new DatabaseAheadError().message;
  if (state.pending.length === 0) return null;
  const which = state.fresh
    ? "The database is empty"
    : `The database is ${state.pending.length} migration${state.pending.length === 1 ? "" : "s"} behind this version (${state.pending.map((p) => p.tag).join(", ")})`;
  return (
    `${which}. Start with MIGRATE_ON_START=true (the app image's default), or run ` +
    "pnpm db:migrate, then start again."
  );
}

/**
 * Brings the database to this code's schema, or explains why it will not and exits (#154):
 * migrations run only when asked to, one replica at a time, never losing data unasked; without
 * them, a database behind or ahead of the code is named before anything misreads it.
 */
/** Said when this release starts against a newer one's database, which it can read (#421). */
const NEWER =
  "The database has a newer version's migrations, which only add to it: this version runs " +
  "alongside it, as during a rolling upgrade or after a rollback.";

export async function migrateOrExit(config: {
  DATABASE_URL: string;
  DATABASE_DIRECT_URL?: string | undefined;
  MIGRATE_ON_START: boolean;
  MIGRATE_ALLOW_DESTRUCTIVE: boolean;
}) {
  // Past any transaction pooler (#412): the migration lock lasts the session.
  const sessionUrl = config.DATABASE_DIRECT_URL ?? config.DATABASE_URL;
  try {
    if (config.MIGRATE_ON_START) {
      const { applied, newer } = await runMigrations(sessionUrl, undefined, {
        allowDestructive: config.MIGRATE_ALLOW_DESTRUCTIVE,
      });
      if (applied.length > 0) console.log(`Migrated: ${applied.join(", ")}.`);
      if (newer) console.log(NEWER);
      return;
    }
    const { db, close } = createDb(config.DATABASE_URL, { max: 1 });
    try {
      const state = await migrationState(db);
      const problem = schemaProblem(state);
      if (!problem && state.newer) console.log(NEWER);
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

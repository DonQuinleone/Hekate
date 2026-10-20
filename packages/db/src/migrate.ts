import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client.ts";

export const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/** One key for every Hekate process: two replicas starting at once migrate one after the other. */
const MIGRATION_LOCK = 0x48656b61; // "Heka"

interface JournalEntry {
  tag: string;
  /** When it was generated: drizzle records it as the migration's `created_at` once applied. */
  when: number;
}

/** The migrations this code carries, in order. */
export function journalOf(folder = migrationsFolder): JournalEntry[] {
  const journal = JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8")) as {
    entries: JournalEntry[];
  };
  return journal.entries.map(({ tag, when }) => ({ tag, when }));
}

/**
 * The statements in a migration that drop or rewrite data: tables, columns or types dropped,
 * a column's type changed, rows truncated or deleted. A backfill (`UPDATE`) fills in new data
 * and is not counted. Comments are not statements.
 */
export function destructiveStatements(text: string): string[] {
  return text
    .split(/--> statement-breakpoint|;/)
    .map((statement) =>
      statement
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((statement) =>
      [
        /^DROP (TABLE|TYPE)\b/i,
        /^ALTER TABLE .* DROP COLUMN\b/i,
        /^ALTER TABLE .* ALTER COLUMN .* (SET DATA )?TYPE\b/i,
        /^TRUNCATE\b/i,
        /^DELETE FROM\b/i,
      ].some((pattern) => pattern.test(statement)),
    );
}

export interface MigrationState {
  /** None applied: a new, empty database. */
  fresh: boolean;
  /** This code's migrations the database has not had yet. */
  pending: JournalEntry[];
  /** The database has had migrations this code does not know: it is newer than the code. */
  ahead: boolean;
}

/** Where a database stands against this code's migrations. */
export async function migrationState(
  db: ReturnType<typeof createDb>["db"],
  folder = migrationsFolder,
): Promise<MigrationState> {
  const journal = journalOf(folder);
  const [found] = await db.execute<{ exists: boolean }>(
    sql`select to_regclass('drizzle.__drizzle_migrations') is not null as exists`,
  );
  const last = found?.exists
    ? Number(
        (
          await db.execute<{ last: string | null }>(
            sql`select max(created_at) as last from drizzle.__drizzle_migrations`,
          )
        )[0]?.last ?? Number.NaN,
      )
    : Number.NaN;
  if (Number.isNaN(last)) return { fresh: true, pending: journal, ahead: false };
  return {
    fresh: false,
    pending: journal.filter((entry) => entry.when > last),
    ahead: last > (journal.at(-1)?.when ?? 0),
  };
}

/** A migration that would lose data, refused until the operator says so. */
export class DestructiveMigrationError extends Error {}

/** The database is newer than this code: running would misread it. */
export class DatabaseAheadError extends Error {
  constructor() {
    super(
      "The database has migrations this version of Hekate does not know: it was used by a " +
        "newer version. Run that version again, or restore the backup taken before upgrading.",
    );
  }
}

/**
 * Applies the pending migrations, one process at a time (a session advisory lock on the one
 * connection). Refuses a pending migration that drops or rewrites data unless allowed; a new,
 * empty database has nothing to lose, so its first migrations are never refused.
 */
export async function runMigrations(
  url: string,
  folder = migrationsFolder,
  options: { allowDestructive?: boolean } = {},
): Promise<{ applied: string[] }> {
  const { db, close } = createDb(url, { max: 1 });
  try {
    await db.execute(sql`select pg_advisory_lock(${MIGRATION_LOCK})`);
    try {
      // Read under the lock: another replica may have migrated while this one waited.
      const state = await migrationState(db, folder);
      if (state.ahead) throw new DatabaseAheadError();
      if (!state.fresh && !options.allowDestructive) {
        const losing = state.pending.flatMap((entry) =>
          destructiveStatements(readFileSync(join(folder, `${entry.tag}.sql`), "utf8")).map(
            (statement) => `  ${entry.tag}: ${statement}`,
          ),
        );
        if (losing.length > 0)
          throw new DestructiveMigrationError(
            "This upgrade drops or rewrites data:\n" +
              `${losing.join("\n")}\n` +
              "Take a backup (docs/backup.md), read the upgrade notes in CHANGELOG.md, then " +
              "start once with MIGRATE_ALLOW_DESTRUCTIVE=true.",
          );
      }
      await migrate(db, { migrationsFolder: folder });
      return { applied: state.pending.map((entry) => entry.tag) };
    } finally {
      await db.execute(sql`select pg_advisory_unlock(${MIGRATION_LOCK})`);
    }
  } finally {
    await close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { applied } = await runMigrations(url, migrationsFolder, {
    allowDestructive: process.env.MIGRATE_ALLOW_DESTRUCTIVE === "true",
  });
  console.log(applied.length > 0 ? `Applied ${applied.join(", ")}.` : "Up to date.");
}

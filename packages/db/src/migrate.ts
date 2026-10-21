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

/** Where a database records which of its migrations older code must know (#421). */
const READABLE_FROM = sql`drizzle.hekate_readable_from`;

/** SQL without its block comments, each a space: one pass over the text. */
function withoutBlockComments(text: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const open = text.indexOf("/*", from);
    if (open < 0) return out + text.slice(from);
    out += `${text.slice(from, open)} `;
    const close = text.indexOf("*/", open + 2);
    if (close < 0) return out;
    from = close + 2;
  }
}

/**
 * The statements in a migration that drop or rewrite data: tables, columns or types dropped,
 * a column's type changed, rows truncated or deleted. A backfill (`UPDATE`) fills in new data
 * and is not counted. Comments, line or block, are not statements.
 */
export function destructiveStatements(text: string): string[] {
  return statementsOf(text).filter((statement) =>
    [
      /^DROP (TABLE|TYPE)\b/i,
      /^ALTER TABLE .* DROP COLUMN\b/i,
      /^ALTER TABLE .* ALTER COLUMN .* (SET DATA )?TYPE\b/i,
      /^TRUNCATE\b/i,
      /^DELETE FROM\b/i,
    ].some((pattern) => pattern.test(statement)),
  );
}

/** A migration's statements, one line each, without comments. */
function statementsOf(text: string): string[] {
  // Block comments go first: one may hold a semicolon, or stand before a statement.
  return withoutBlockComments(text)
    .split(/--> statement-breakpoint|;/)
    .map((statement) =>
      statement
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((statement) => statement.length > 0);
}

/** The table a statement creates, if it creates one. */
const createdTable = (statement: string) =>
  /^CREATE TABLE (?:IF NOT EXISTS )?("?[\w.]+"?(?:\."?\w+"?)?)/i.exec(statement)?.[1];

/**
 * The statements in a migration that the release before it may not run against (#421): those
 * that lose data, and those that tighten or rename what older code reads and writes. A column
 * made required, a required column added without a default, a uniqueness, check or foreign
 * key constraint or a unique index on a table older code knows, a table or column renamed. Constraints and
 * indexes on a table the same migration creates are not counted, as older code never touches
 * it. A migration can also say so itself, with a line `-- hekate: contracts`.
 */
export function contractingStatements(text: string): string[] {
  const statements = statementsOf(text);
  const created = new Set(statements.map(createdTable).filter((name) => name !== undefined));
  const onNewTable = (statement: string) => {
    const table =
      /^(?:ALTER TABLE (?:ONLY )?|CREATE UNIQUE INDEX .* ON (?:ONLY )?)("?[\w.]+"?(?:\."?\w+"?)?)/i.exec(
        statement,
      )?.[1];
    return table !== undefined && created.has(table);
  };
  const marked = /^\s*-- hekate: contracts\b/im.test(text) ? ["-- hekate: contracts"] : [];
  return [
    ...marked,
    ...destructiveStatements(text),
    ...statements.filter(
      (statement) =>
        !onNewTable(statement) &&
        [
          /^ALTER TABLE .* ALTER COLUMN .* SET NOT NULL\b/i,
          /^ALTER TABLE .* ADD COLUMN (?!.*\bDEFAULT\b).*\bNOT NULL\b/i,
          /^ALTER TABLE .* ADD CONSTRAINT .* (UNIQUE|CHECK|PRIMARY KEY|FOREIGN KEY)\b/i,
          /^CREATE UNIQUE INDEX\b/i,
          /^ALTER TABLE .* RENAME\b/i,
        ].some((pattern) => pattern.test(statement)),
    ),
  ];
}

/**
 * The migration older code must know to read a database this journal has migrated: the latest
 * that contracts the schema (`contractingStatements`). Code that knows it runs against the
 * database, as every migration after it only expands; code that does not is refused. Without
 * one, the first migration.
 */
export function readableFrom(folder = migrationsFolder): number {
  const journal = journalOf(folder);
  const contracting = journal.filter(
    (entry) =>
      contractingStatements(readFileSync(join(folder, `${entry.tag}.sql`), "utf8")).length > 0,
  );
  return (contracting.at(-1) ?? journal[0])?.when ?? 0;
}

export interface MigrationState {
  /** None applied: a new, empty database. */
  fresh: boolean;
  /** This code's migrations the database has not had yet. */
  pending: JournalEntry[];
  /**
   * The database has had migrations this code does not know, and at least one of them contracts
   * the schema: this code would misread it, and is refused.
   */
  ahead: boolean;
  /**
   * The database has had migrations this code does not know, all of which only expand the
   * schema: a newer release's, which this one runs alongside (#421).
   */
  newer: boolean;
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
  if (Number.isNaN(last)) return { fresh: true, pending: journal, ahead: false, newer: false };
  const known = journal.at(-1)?.when ?? 0;
  const pending = journal.filter((entry) => entry.when > last);
  if (last <= known) return { fresh: false, pending, ahead: false, newer: false };
  // Newer than this code: readable only if the newer release recorded that every migration
  // this code lacks expands. A database migrated before it recorded anything is not readable.
  const [recorded] = await db.execute<{ exists: boolean }>(
    sql`select to_regclass('drizzle.hekate_readable_from') is not null as exists`,
  );
  const from = recorded?.exists
    ? Number(
        (
          await db.execute<{ migration: string }>(
            sql`select migration from ${READABLE_FROM} limit 1`,
          )
        )[0]?.migration ?? Number.NaN,
      )
    : Number.NaN;
  const readable = !Number.isNaN(from) && from <= known;
  return { fresh: false, pending, ahead: !readable, newer: readable };
}

/** A migration that would lose data, refused until the operator says so. */
export class DestructiveMigrationError extends Error {}

/** The database is newer than this code: running would misread it. */
export class DatabaseAheadError extends Error {
  constructor() {
    super(
      "The database has migrations this version of Hekate does not know, and some of them " +
        "change what this version reads: it was used by a newer version. Run that version " +
        "again, or restore the backup taken before upgrading.",
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
): Promise<{ applied: string[]; newer: boolean }> {
  const { db, close } = createDb(url, { max: 1 });
  try {
    await db.execute(sql`select pg_advisory_lock(${MIGRATION_LOCK})`);
    try {
      // Read under the lock: another replica may have migrated while this one waited.
      const state = await migrationState(db, folder);
      if (state.ahead) throw new DatabaseAheadError();
      // A newer release's database, readable by this one: nothing here to apply or record.
      if (state.newer) return { applied: [], newer: true };
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
      // Which releases may still run against it: those that know its latest contraction.
      // Recorded first, so the database never holds a migration with a looser cutoff than
      // it needs: a release that starts while this one migrates, or after it fails half way,
      // reads the stricter one (#421).
      await db.execute(sql`create schema if not exists drizzle`);
      await db.execute(
        sql`create table if not exists ${READABLE_FROM} (id boolean primary key default true check (id), migration bigint not null)`,
      );
      await db.execute(
        sql`insert into ${READABLE_FROM} (migration) values (${readableFrom(folder)}) on conflict (id) do update set migration = excluded.migration`,
      );
      await migrate(db, { migrationsFolder: folder });
      return { applied: state.pending.map((entry) => entry.tag), newer: false };
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

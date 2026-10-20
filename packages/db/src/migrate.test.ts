import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "./client.ts";
import {
  DatabaseAheadError,
  DestructiveMigrationError,
  destructiveStatements,
  journalOf,
  migrationState,
  migrationsFolder,
  runMigrations,
} from "./migrate.ts";

describe("destructive statements", () => {
  it("finds drops, type changes, truncates and deletes, but not backfills or comments", () => {
    const found = destructiveStatements(
      [
        'ALTER TABLE "files" DROP COLUMN "storage_key";--> statement-breakpoint',
        'ALTER TABLE "files" ADD COLUMN "size" bigint;--> statement-breakpoint',
        'UPDATE "files" SET "size" = 0;--> statement-breakpoint',
        "-- TRUNCATE skips row triggers, so refuse it separately.",
        'CREATE TRIGGER "x" BEFORE TRUNCATE ON "y" FOR EACH STATEMENT EXECUTE FUNCTION z();',
        'ALTER TABLE "takes" ALTER COLUMN "number" SET DATA TYPE text;',
        'DELETE FROM "takes";',
        'DROP TABLE "old";',
        'TRUNCATE "old";',
      ].join("\n"),
    );
    expect(found).toEqual([
      'ALTER TABLE "files" DROP COLUMN "storage_key"',
      'ALTER TABLE "takes" ALTER COLUMN "number" SET DATA TYPE text',
      'DELETE FROM "takes"',
      'DROP TABLE "old"',
      'TRUNCATE "old"',
    ]);
  });

  // A migration that loses data needs upgrade notes in its pull request and the changelog
  // (AGENTS.md); listing it here is the reminder.
  it("are only in the migrations known to need upgrade notes", () => {
    const losing = journalOf()
      .filter(
        (entry) =>
          destructiveStatements(readFileSync(join(migrationsFolder, `${entry.tag}.sql`), "utf8"))
            .length > 0,
      )
      .map((entry) => entry.tag);
    expect(losing).toEqual(["0003_storage", "0063_takes_on_tracks", "0083_tasks"]);
  });
});

const base = process.env.DATABASE_URL;

describe.runIf(base)("running migrations", () => {
  const made: string[] = [];
  const folders: string[] = [];
  const admin = createDb(base ?? "", { max: 1 });
  afterAll(async () => {
    for (const name of made) await admin.db.execute(sql.raw(`drop database if exists ${name}`));
    await admin.close();
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  });
  const database = async () => {
    const name = `hekate_migrate_${made.length}_${Date.now()}`;
    made.push(name);
    await admin.db.execute(sql.raw(`create database ${name}`));
    const url = new URL(base ?? "");
    url.pathname = `/${name}`;
    return url.toString();
  };
  /** This code's migrations, then those given, each a later one. */
  const folderWith = (extra: { tag: string; sql: string }[], drop = 0) => {
    const folder = mkdtempSync(join(tmpdir(), "hekate-migrate-"));
    folders.push(folder);
    cpSync(migrationsFolder, folder, { recursive: true });
    const path = join(folder, "meta/_journal.json");
    const journal = JSON.parse(readFileSync(path, "utf8")) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    journal.entries = journal.entries.slice(0, journal.entries.length - drop);
    for (const [i, migration] of extra.entries()) {
      const last = journal.entries.at(-1);
      journal.entries.push({
        ...(last as object),
        idx: (last?.idx ?? 0) + 1,
        when: (last?.when ?? 0) + 1000 * (i + 1),
        tag: migration.tag,
      } as (typeof journal.entries)[number]);
      writeFileSync(join(folder, `${migration.tag}.sql`), migration.sql);
    }
    writeFileSync(path, JSON.stringify(journal));
    return folder;
  };

  it("migrates a new database whole, though old migrations dropped columns", async () => {
    const url = await database();
    const { applied } = await runMigrations(url);
    expect(applied).toEqual(journalOf().map((entry) => entry.tag));
    const { db, close } = createDb(url, { max: 1 });
    expect(await migrationState(db)).toEqual({ fresh: false, pending: [], ahead: false });
    await close();
    expect((await runMigrations(url)).applied).toEqual([]);
  }, 120_000);

  it("refuses an upgrade that loses data until allowed, and keeps the database as it was", async () => {
    const url = await database();
    await runMigrations(url);
    const folder = folderWith([
      { tag: "9000_add", sql: 'ALTER TABLE "venues" ADD COLUMN "phone" text;' },
      { tag: "9001_drop", sql: 'ALTER TABLE "venues" DROP COLUMN "notes";' },
    ]);
    const refused = await runMigrations(url, folder).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DestructiveMigrationError);
    expect((refused as Error).message).toContain('9001_drop: ALTER TABLE "venues" DROP COLUMN');
    const { db, close } = createDb(url, { max: 1 });
    expect((await migrationState(db, folder)).pending.map((p) => p.tag)).toEqual([
      "9000_add",
      "9001_drop",
    ]);
    expect((await runMigrations(url, folder, { allowDestructive: true })).applied).toEqual([
      "9000_add",
      "9001_drop",
    ]);
    expect((await migrationState(db, folder)).pending).toEqual([]);
    await close();
  }, 120_000);

  it("lets two replicas start at once, migrating once", async () => {
    const url = await database();
    const [a, b] = await Promise.all([runMigrations(url), runMigrations(url)]);
    expect([a.applied.length > 0, b.applied.length > 0].sort()).toEqual([false, true]);
  }, 120_000);

  it("refuses a database a newer version has migrated", async () => {
    const url = await database();
    await runMigrations(url);
    const older = folderWith([], 1);
    await expect(runMigrations(url, older)).rejects.toBeInstanceOf(DatabaseAheadError);
    const { db, close } = createDb(url, { max: 1 });
    expect((await migrationState(db, older)).ahead).toBe(true);
    await close();
  }, 120_000);
});

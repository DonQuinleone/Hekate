import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "./client.ts";
import {
  contractingStatements,
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
        '/* a note; with a semicolon */ ALTER TABLE "venues" DROP COLUMN "notes";',
        "/* a note */",
      ].join("\n"),
    );
    expect(found).toEqual([
      'ALTER TABLE "files" DROP COLUMN "storage_key"',
      'ALTER TABLE "takes" ALTER COLUMN "number" SET DATA TYPE text',
      'DELETE FROM "takes"',
      'DROP TABLE "old"',
      'TRUNCATE "old"',
      'ALTER TABLE "venues" DROP COLUMN "notes"',
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

describe("contracting statements (#421)", () => {
  it("finds what the release before cannot run against, but not what only expands", () => {
    const found = contractingStatements(
      [
        'ALTER TABLE "files" ADD COLUMN "size" bigint;',
        'ALTER TABLE "files" ADD COLUMN "kind" text DEFAULT \'audio\' NOT NULL;',
        'ALTER TABLE "files" ADD COLUMN "blob_id" uuid NOT NULL;',
        'ALTER TABLE "files" ALTER COLUMN "name" SET NOT NULL;',
        'ALTER TABLE "files" RENAME COLUMN "peaks_status" TO "analysis_status";',
        'ALTER TABLE "folders" ADD CONSTRAINT "folders_name" UNIQUE("project_id","name");',
        'ALTER TABLE "reviews" ADD CONSTRAINT "reviews_share" CHECK ("reviews"."share" > 0);',
        'ALTER TABLE "files" ADD CONSTRAINT "files_blob_fk" FOREIGN KEY ("blob_id") REFERENCES "blobs"("id");',
        'CREATE UNIQUE INDEX "takes_number_idx" ON "takes" USING btree ("track_id","number");',
        'CREATE INDEX "takes_track_idx" ON "takes" USING btree ("track_id");',
        'ALTER TABLE "venues" DROP COLUMN "notes";',
      ].join("\n"),
    );
    expect(found).toEqual([
      'ALTER TABLE "venues" DROP COLUMN "notes"',
      'ALTER TABLE "files" ADD COLUMN "blob_id" uuid NOT NULL',
      'ALTER TABLE "files" ALTER COLUMN "name" SET NOT NULL',
      'ALTER TABLE "files" RENAME COLUMN "peaks_status" TO "analysis_status"',
      'ALTER TABLE "folders" ADD CONSTRAINT "folders_name" UNIQUE("project_id","name")',
      'ALTER TABLE "reviews" ADD CONSTRAINT "reviews_share" CHECK ("reviews"."share" > 0)',
      'ALTER TABLE "files" ADD CONSTRAINT "files_blob_fk" FOREIGN KEY ("blob_id") REFERENCES "blobs"("id")',
      'CREATE UNIQUE INDEX "takes_number_idx" ON "takes" USING btree ("track_id","number")',
    ]);
  });

  it("leaves alone a table the same migration creates, which older code never touches", () => {
    expect(
      contractingStatements(
        [
          'CREATE TABLE "marks" ("id" uuid PRIMARY KEY NOT NULL, "page" integer NOT NULL);',
          'ALTER TABLE "marks" ADD CONSTRAINT "marks_page" CHECK ("marks"."page" >= 1);',
          'CREATE UNIQUE INDEX "marks_page_idx" ON "marks" USING btree ("page");',
          'ALTER TABLE "marks" ADD CONSTRAINT "marks_file_fk" FOREIGN KEY ("file_id") REFERENCES "files"("id");',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("leaves the release before able to run against file chains, spectrogram variants, events, workspace mail, suppressions, trace ids, usage, plans, billing, upload requests to a track, API tokens, workspace export, support, OAuth, ticket notifications, listening rooms, caption tracks and forensic marks, the recorder driving a session, workspace categories and sign-in methods, error reports marked known, a project's default board, and its asset policy, tool exceptions and workflow notices, corrected metadata, and variants beside variations", () => {
    for (const name of [
      "0116_file_chains",
      "0117_spectrogram_variants",
      "0118_events_and_channels",
      "0119_workspace_mail",
      "0120_mail_suppressions",
      "0121_error_trace_ids",
      "0122_workspace_usage",
      "0123_plans",
      "0124_billing",
      "0125_invoice_descriptions",
      "0126_promo_codes",
      "0127_cancels_and_pdfs",
      "0128_upload_versions",
      "0129_api_tokens",
      "0130_workspace_export",
      "0131_support",
      "0132_credits",
      "0133_incidents",
      "0134_branding",
      "0135_oauth",
      "0136_inbox",
      "0137_listening",
      "0138_captions",
      "0139_forensic",
      "0141_recorders",
      "0143_workspace_settings",
      "0144_instance-ops",
      "0145_files_rows",
      "0146_project_settings",
      "0147_gaps_two",
      "0148_metadata_editor",
      "0149_variants",
      "0150_comment_assignment",
      "0151_review_scope",
    ]) {
      const text = readFileSync(join(migrationsFolder, `${name}.sql`), "utf8");
      expect(contractingStatements(text)).toEqual([]);
    }
  });

  it("leaves out a constraint on columns the same migration adds, but not on older ones", () => {
    const added = [
      'ALTER TABLE "sessions" ADD COLUMN "recorder_by" text;--> statement-breakpoint',
      'ALTER TABLE "sessions" ADD CONSTRAINT "sessions_recorder_by_users_id_fk" FOREIGN KEY ("recorder_by") REFERENCES "public"."users"("id") ON DELETE set null;',
    ].join("\n");
    expect(contractingStatements(added)).toEqual([]);
    const older =
      'ALTER TABLE "files" ADD CONSTRAINT "files_previous_file_id_files_id_fk" FOREIGN KEY ("previous_file_id") REFERENCES "public"."files"("id");';
    expect(contractingStatements(older)).toHaveLength(1);
  });

  it("takes a migration's own word that it contracts", () => {
    expect(
      contractingStatements('-- hekate: contracts\nUPDATE "files" SET "kind" = \'audio\';'),
    ).toEqual(["-- hekate: contracts"]);
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
    expect(await migrationState(db)).toEqual({
      fresh: false,
      pending: [],
      ahead: false,
      newer: false,
    });
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

  it("runs against a newer release's database whose new migrations only expand it (#421)", async () => {
    const url = await database();
    const newer = folderWith([
      { tag: "9000_phone", sql: 'ALTER TABLE "venues" ADD COLUMN "phone" text;' },
      { tag: "9001_index", sql: 'CREATE INDEX "venues_phone_idx" ON "venues" ("phone");' },
    ]);
    await runMigrations(url, newer);
    // This code is the release before: it knows neither migration, and needs neither.
    expect((await runMigrations(url)).applied).toEqual([]);
    const { db, close } = createDb(url, { max: 1 });
    expect(await migrationState(db)).toMatchObject({ ahead: false, newer: true, pending: [] });
    await close();
  }, 120_000);

  it("refuses a newer release's database once one of its migrations contracts", async () => {
    const url = await database();
    const newer = folderWith([
      { tag: "9000_phone", sql: 'ALTER TABLE "venues" ADD COLUMN "phone" text;' },
      { tag: "9001_required", sql: 'ALTER TABLE "venues" ALTER COLUMN "phone" SET NOT NULL;' },
    ]);
    await runMigrations(url, newer);
    await expect(runMigrations(url)).rejects.toBeInstanceOf(DatabaseAheadError);
    const { db, close } = createDb(url, { max: 1 });
    expect(await migrationState(db)).toMatchObject({ ahead: true, newer: false });
    await close();
  }, 120_000);

  it("records the stricter cutoff before migrating, so a failed migration never leaves a looser one", async () => {
    const url = await database();
    await runMigrations(url);
    const failing = folderWith([
      { tag: "9000_phone", sql: 'ALTER TABLE "venues" ADD COLUMN "phone" text;' },
      { tag: "9001_required", sql: 'ALTER TABLE "venues" ALTER COLUMN "no_such" SET NOT NULL;' },
    ]);
    await expect(runMigrations(url, failing)).rejects.toThrow();
    const { db, close } = createDb(url, { max: 1 });
    const [row] = await db.execute<{ migration: string }>(
      sql`select migration from drizzle.hekate_readable_from`,
    );
    expect(Number(row?.migration)).toBe(journalOf(failing).at(-1)?.when);
    await close();
  }, 120_000);

  it("refuses a newer database that recorded nothing, as releases before #421 left it", async () => {
    const url = await database();
    await runMigrations(url);
    const { db, close } = createDb(url, { max: 1 });
    await db.execute(sql`drop table drizzle.hekate_readable_from`);
    const older = folderWith([], 1);
    await expect(runMigrations(url, older)).rejects.toBeInstanceOf(DatabaseAheadError);
    expect((await migrationState(db, older)).ahead).toBe(true);
    await close();
  }, 120_000);
});

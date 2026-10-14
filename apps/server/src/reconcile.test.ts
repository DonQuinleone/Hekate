import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, schema, uuidv7 } from "@hekate/db";
import { createBackends, storageConfigFromEnv } from "@hekate/storage";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAudit } from "./audit.ts";
import { createKeyring } from "./keyring.ts";
import { diffKeys, ownerOf, reconcileStorage } from "./reconcile.ts";
import { createStorage } from "./storage.ts";

describe("reconciliation helpers", () => {
  it("reads the organisation from a key and nothing else", () => {
    const org = "0190a6f0-0000-7000-8000-00000000000a";
    expect(ownerOf(`org/${org}/0190a6f0-0000-7000-8000-00000000000b`)).toBe(org);
    expect(ownerOf("org/not-a-uuid/x")).toBeNull();
    expect(ownerOf(`org/${org}/a/b`)).toBeNull();
  });

  it("finds what is stored but not recorded, and recorded but not stored", () => {
    expect(diffKeys(["a", "b", "c"], ["b", "c", "d"])).toEqual({ orphans: ["a"], missing: ["d"] });
  });
});

const url = process.env.DATABASE_URL;

describe.runIf(url)("storage reconciliation", () => {
  const { db, close } = createDb(url ?? "", { max: 3 });
  const root = mkdtempSync(join(tmpdir(), "hekate-reconcile-"));
  const backends = createBackends(storageConfigFromEnv({ STORAGE_LOCAL_PATH: root }));
  const keyring = createKeyring(db, { current: Buffer.alloc(32, 7), previous: [] });
  const storage = createStorage(db, backends, keyring);
  const audit = createAudit(db);
  const local = backends.get("local");
  const hours = (n: number) => new Date(Date.now() + n * 60 * 60 * 1000);

  beforeAll(async () => {
    await runMigrations(url ?? "");
  });
  afterAll(async () => {
    await close();
    rmSync(root, { recursive: true, force: true });
  });

  it("removes what nothing uses on a second sighting, and only reports missing bytes", async () => {
    const [org] = await db
      .insert(schema.organisations)
      .values({ name: "Reconcile", slug: `reconcile-${Date.now()}` })
      .returning();
    const organisationId = org?.id ?? "";
    const [project] = await db
      .insert(schema.projects)
      .values({ organisationId, name: "Rags", profile: "music" })
      .returning();

    // In use: a file's bytes.
    const used = await storage.put(organisationId, Buffer.from("a mix"));
    await db.insert(schema.files).values({
      organisationId,
      projectId: project?.id ?? "",
      name: "Mix.wav",
      kind: "audio",
      blobId: used.id,
      contentType: "audio/wav",
      byteSize: used.byteSize,
    });
    // A blob nothing uses, and one whose bytes have gone.
    const unused = await storage.put(organisationId, Buffer.from("left behind"));
    const lost = await storage.put(organisationId, Buffer.from("lost"));
    await local.delete(lost.key);
    // Bytes no row accounts for: one in this organisation, one of an organisation long gone,
    // and one that will disappear on its own before the second run.
    const stray = `org/${organisationId}/${uuidv7()}`;
    const departed = uuidv7();
    const ghost = `org/${departed}/${uuidv7()}`;
    const fleeting = `org/${organisationId}/${uuidv7()}`;
    for (const key of [stray, ghost, fleeting]) await local.put(key, Buffer.from("stray"));

    const open = () =>
      db
        .select()
        .from(schema.storageFindings)
        .where(
          and(
            isNull(schema.storageFindings.resolvedAt),
            inArray(schema.storageFindings.ownerOrganisationId, [organisationId, departed]),
          ),
        );
    const events = async (action: "storage.remove" | "storage.missing") =>
      (await audit.query(organisationId, { action, limit: 50 })).events;

    // First run, a day on: everything is found, nothing is removed yet.
    const [first] = await reconcileStorage(
      { db, storage, audit },
      { now: hours(25), organisations: [organisationId, departed] },
    );
    expect(first).toMatchObject({
      orphanObjects: 3,
      unreferencedBlobs: 1,
      missingObjects: 1,
      removed: 0,
    });
    expect((await open()).map((f) => f.kind).sort()).toEqual([
      "missing_object",
      "orphan_object",
      "orphan_object",
      "orphan_object",
      "unreferenced_blob",
    ]);
    expect(await events("storage.missing")).toHaveLength(1);
    expect(await local.head(stray)).not.toBeNull();

    // A report-only run a day later changes nothing in storage.
    await local.delete(fleeting);
    const [reportOnly] = await reconcileStorage(
      { db, storage, audit },
      { now: hours(50), remove: false, organisations: [organisationId, departed] },
    );
    expect(reportOnly?.removed).toBe(0);
    expect(await local.head(stray)).not.toBeNull();

    // The next run removes what is still unused; the missing blob stays for a person.
    const [second] = await reconcileStorage(
      { db, storage, audit },
      { now: hours(75), organisations: [organisationId, departed] },
    );
    expect(second?.removed).toBe(3);
    expect(await local.head(stray)).toBeNull();
    expect(await local.head(ghost)).toBeNull();
    expect(await db.select().from(schema.blobs).where(eq(schema.blobs.id, unused.id))).toHaveLength(
      0,
    );
    expect(await local.head(used.key)).not.toBeNull();
    expect((await open()).map((f) => f.kind)).toEqual(["missing_object"]);
    // Removals in a living organisation are in its access log; the missing blob is reported once.
    expect(await events("storage.remove")).toHaveLength(2);
    expect(await events("storage.missing")).toHaveLength(1);
    const gone = await db
      .select({ resolution: schema.storageFindings.resolution })
      .from(schema.storageFindings)
      .where(eq(schema.storageFindings.key, fleeting));
    expect(gone.map((g) => g.resolution)).toEqual(["gone"]);
  });
});

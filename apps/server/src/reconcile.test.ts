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

  it("survives two runs at once, and a targeted run lists only its own workspace", async () => {
    const make = async (name: string) =>
      (
        await db
          .insert(schema.organisations)
          .values({ name, slug: `${name.toLowerCase()}-${Date.now()}` })
          .returning()
      )[0]?.id ?? "";
    const mine = await make("Mine");
    const theirs = await make("Theirs");
    const stray = `org/${mine}/${uuidv7()}`;
    await local.put(stray, Buffer.from("stray"));

    // The nightly run and an admin's, together: one finding, no error.
    const [a, b] = await Promise.all([
      reconcileStorage({ db, storage, audit }, { remove: false, organisations: [mine] }),
      reconcileStorage({ db, storage, audit }, { remove: false }),
    ]);
    expect(a[0]?.orphanObjects).toBe(1);
    expect(b.length).toBeGreaterThan(0);
    const findings = await db
      .select()
      .from(schema.storageFindings)
      .where(and(eq(schema.storageFindings.key, stray), isNull(schema.storageFindings.resolvedAt)));
    expect(findings).toHaveLength(1);

    // Asked for one workspace, the backend is listed under that workspace's keys alone.
    const listed: string[] = [];
    const list = local.list.bind(local);
    local.list = (prefix: string) => {
      listed.push(prefix);
      return list(prefix);
    };
    try {
      await reconcileStorage({ db, storage, audit }, { remove: false, organisations: [theirs] });
    } finally {
      local.list = list;
    }
    expect(listed).toEqual([`org/${theirs}/`]);
  });

  it("leaves unfinished uploads alone, and retries a report the access log missed", async () => {
    const [org] = await db
      .insert(schema.organisations)
      .values({ name: "Uploads", slug: `reconcile-uploads-${Date.now()}` })
      .returning();
    const organisationId = org?.id ?? "";
    const [project] = await db
      .insert(schema.projects)
      .values({ organisationId, name: "Sessions", profile: "music" })
      .returning();
    const upload = (status: "open" | "completing", blobId: string, key: string) => ({
      organisationId,
      projectId: project?.id ?? "",
      name: "Take.wav",
      contentType: "audio/wav",
      byteSize: 5,
      status,
      blobId,
      backend: "local",
      key,
      backendUploadId: uuidv7(),
      wrappedKey: "x",
      keyVersion: 1,
      noncePrefix: "x",
      expiresAt: hours(200),
    });
    // An open upload's bytes, with no blob yet; and a completing upload's blob, with no file yet.
    const writing = `org/${organisationId}/${uuidv7()}`;
    await local.put(writing, Buffer.from("part"));
    const finishing = await storage.put(organisationId, Buffer.from("done"));
    await db
      .insert(schema.uploads)
      .values([
        upload("open", uuidv7(), writing),
        upload("completing", finishing.id, finishing.key),
      ]);
    const lost = await storage.put(organisationId, Buffer.from("lost"));
    await local.delete(lost.key);

    const missingEvents = async () =>
      (await audit.query(organisationId, { action: "storage.missing", limit: 50 })).events;
    // The access log is down for the first run: the run fails, and nothing is marked reported.
    const failing = {
      ...audit,
      record: async () => {
        throw new Error("access log unavailable");
      },
    };
    await expect(
      reconcileStorage(
        { db, storage, audit: failing },
        { now: hours(25), organisations: [organisationId] },
      ),
    ).rejects.toThrow("access log unavailable");
    expect(await missingEvents()).toHaveLength(0);

    for (const at of [50, 75]) {
      const [report] = await reconcileStorage(
        { db, storage, audit },
        { now: hours(at), organisations: [organisationId] },
      );
      expect(report).toMatchObject({
        orphanObjects: 0,
        unreferencedBlobs: 0,
        missingObjects: 1,
        removed: 0,
      });
    }
    // Reported by the first run that could log it, and only once.
    expect(await missingEvents()).toHaveLength(1);
    expect(await local.head(writing)).not.toBeNull();
    expect(await local.head(finishing.key)).not.toBeNull();
  });
});

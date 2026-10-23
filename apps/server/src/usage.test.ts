import { randomBytes } from "node:crypto";
import { createDb, runMigrations, schema, uuidv7 } from "@hekate/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provision } from "./sso.ts";
import { firstIdAt, refreshUsage, storageInUse, workspaceUsageOf } from "./usage.ts";

/** An id as one made at `at` would be: the generator only moves forward, so not uuidv7(at). */
const idAt = (at: Date) => `${firstIdAt(at).slice(0, 24)}${randomBytes(6).toString("hex")}`;

describe("usage metering (#175)", () => {
  it("bounds a month's access events by the first id its start can have", () => {
    const start = new Date("2026-10-01T00:00:00Z");
    const bound = firstIdAt(start);
    expect(bound).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7000-8000-000000000000$/);
    expect(idAt(start) >= bound).toBe(true);
    expect(idAt(new Date(start.getTime() - 1)) < bound).toBe(true);
    // An id made now sorts between the bounds either side of it.
    const now = Date.now();
    const made = uuidv7();
    expect(made > firstIdAt(new Date(now - 1000))).toBe(true);
    expect(made < firstIdAt(new Date(now + 1000))).toBe(true);
  });
});

const url = process.env.DATABASE_URL;

describe.runIf(url)("a workspace's month (#175)", () => {
  const { db, close } = createDb(url ?? "", { max: 3 });

  beforeAll(async () => {
    await runMigrations(url ?? "");
  });
  afterAll(async () => {
    await close();
  });

  const workspace = async () => {
    const [org] = await db
      .insert(schema.organisations)
      .values({ name: "Endless Hall Records", slug: `usage-${uuidv7()}` })
      .returning();
    return org?.id ?? "";
  };
  const blob = (organisationId: string, byteSize: number) =>
    db.insert(schema.blobs).values({
      organisationId,
      backend: "local",
      key: `${organisationId}/${uuidv7()}`,
      byteSize,
      wrappedKey: "wrapped",
      keyVersion: 1,
    });
  const happened = (organisationId: string, action: "stream.session" | "download", at: Date) =>
    db.insert(schema.accessEvents).values({
      id: idAt(at),
      organisationId,
      occurredAt: at,
      action,
      actorType: "member",
      actorLabel: "Mira Solberg <mira@example.test>",
    });

  it("counts storage at its peak, and plays and downloads once each, within the month", async () => {
    const id = await workspace();
    const other = await workspace();
    await blob(id, 4000);
    await blob(other, 9000);
    const now = new Date("2026-10-23T10:00:00Z");
    await happened(id, "stream.session", new Date("2026-09-30T23:59:59Z"));
    await happened(id, "stream.session", new Date("2026-10-02T09:00:00Z"));
    await happened(id, "download", new Date("2026-10-03T09:00:00Z"));
    await happened(other, "download", new Date("2026-10-03T09:00:00Z"));

    await refreshUsage(db, now);
    let usage = await workspaceUsageOf(db, id, now);
    expect(usage).toMatchObject({ storageBytes: 4000, members: 0, guests: 0, projects: 0 });
    expect(usage.month).toMatchObject({
      month: "2026-10-01",
      storagePeak: 4000,
      plays: 1,
      downloads: 1,
    });

    // Counting an hour later counts only what is new; the peak stays when storage falls.
    const later = new Date("2026-10-23T11:00:00Z");
    await happened(id, "stream.session", new Date("2026-10-23T10:05:00Z"));
    await db.delete(schema.blobs).where(eq(schema.blobs.organisationId, id));
    await blob(id, 1000);
    await refreshUsage(db, later);
    usage = await workspaceUsageOf(db, id, later);
    expect(usage.storageBytes).toBe(1000);
    expect(usage.month).toMatchObject({ storagePeak: 4000, plays: 2, downloads: 1 });

    // Another workspace's are its own.
    expect((await workspaceUsageOf(db, other, now)).month).toMatchObject({
      storagePeak: 9000,
      plays: 0,
      downloads: 1,
    });

    // A new month starts afresh.
    const next = new Date("2026-11-01T01:00:00Z");
    await refreshUsage(db, next);
    expect((await workspaceUsageOf(db, id, next)).month).toMatchObject({
      month: "2026-11-01",
      storagePeak: 1000,
      plays: 0,
      downloads: 0,
    });
  });

  it("counts an event that lands late, and a month to its end", async () => {
    const id = await workspace();
    const now = new Date("2026-10-31T23:58:00Z");
    // Made five minutes ago, its transaction still open, say: not counted yet.
    await happened(id, "download", new Date(now.getTime() - 5 * 60_000));
    await refreshUsage(db, now);
    expect((await workspaceUsageOf(db, id, now)).month).toMatchObject({ downloads: 0 });
    // Made earlier still, and landing only now: counted all the same.
    await happened(id, "stream.session", new Date(now.getTime() - 10 * 60_000));
    // The month is counted to its end by the first count of the next.
    const next = new Date("2026-11-01T01:00:00Z");
    await refreshUsage(db, next);
    expect((await workspaceUsageOf(db, id, now)).month).toMatchObject({
      plays: 1,
      downloads: 1,
    });
    expect((await workspaceUsageOf(db, id, next)).month).toMatchObject({
      plays: 0,
      downloads: 0,
    });
    // Counting again counts nothing twice.
    await refreshUsage(db, new Date("2026-11-01T02:00:00Z"));
    expect((await workspaceUsageOf(db, id, now)).month).toMatchObject({
      plays: 1,
      downloads: 1,
    });
  });

  it("counts the uploads still arriving against the quota, and not those that ended", async () => {
    const id = await workspace();
    const [project] = await db
      .insert(schema.projects)
      .values({ organisationId: id, name: "Joplin Rags", profile: "music" })
      .returning();
    const upload = (byteSize: number, status: "open" | "aborted", expiresAt: Date) =>
      db.insert(schema.uploads).values({
        organisationId: id,
        projectId: project?.id ?? "",
        name: "Bethena.wav",
        contentType: "audio/wav",
        noncePrefix: "nonce",
        byteSize,
        status,
        backend: "local",
        key: `${id}/${uuidv7()}`,
        backendUploadId: "u",
        blobId: uuidv7(),
        wrappedKey: "wrapped",
        keyVersion: 1,
        expiresAt,
      });
    await blob(id, 100);
    await upload(50, "open", new Date(Date.now() + 60_000));
    await upload(70, "aborted", new Date(Date.now() + 60_000));
    await upload(90, "open", new Date(Date.now() - 60_000));
    expect(await storageInUse(db, id)).toBe(150);
  });

  it("joins someone signing in through the workspace's provider only while there is room", async () => {
    const id = await workspace();
    await db
      .update(schema.organisations)
      .set({ memberLimit: 1 })
      .where(eq(schema.organisations.id, id));
    const person = async (email: string) => {
      const userId = uuidv7();
      await db.insert(schema.users).values({ id: userId, name: email, email });
      return userId;
    };
    const first = await person(`mira-${uuidv7()}@example.test`);
    await db.insert(schema.members).values({ organisationId: id, userId: first, role: "owner" });
    const providerId = `sso-${uuidv7()}`;
    await db
      .insert(schema.ssoProviders)
      .values({ organisationId: id, providerId, issuer: "https://id.example.test" });
    const second = await person(`tomas-${uuidv7()}@example.test`);
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      await provision(db, undefined, { userId: second, providerId, groups: [] });
    } finally {
      console.warn = warn;
    }
    const memberships = () =>
      db.select().from(schema.members).where(eq(schema.members.userId, second));
    expect(await memberships()).toEqual([]);
    // An invitation waiting takes the place the higher limit would give.
    await db
      .update(schema.organisations)
      .set({ memberLimit: 2 })
      .where(eq(schema.organisations.id, id));
    await db.insert(schema.invitations).values({
      organisationId: id,
      email: "ines@example.test",
      tokenHash: `hash-${uuidv7()}`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    console.warn = () => undefined;
    try {
      await provision(db, undefined, { userId: second, providerId, groups: [] });
    } finally {
      console.warn = warn;
    }
    expect(await memberships()).toEqual([]);
    await db
      .update(schema.organisations)
      .set({ memberLimit: 3 })
      .where(eq(schema.organisations.id, id));
    await provision(db, undefined, { userId: second, providerId, groups: [] });
    expect(await memberships()).toHaveLength(1);
  });
});

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, inOrg, runMigrations, schema, withAuditPurge } from "@hekate/db";
import { type CroomImported, type CroomPreview, defaultProjectRoles } from "@hekate/shared";
import { createBackends, storageConfigFromEnv } from "@hekate/storage";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createAudit } from "../audit.ts";
import { createAuth } from "../auth.ts";
import { createKeyring } from "../keyring.ts";
import { memoryMailer } from "../mail.ts";
import { playbackSecret } from "../playback.ts";
import { createStorage } from "../storage.ts";
import { commitImport } from "./commit.ts";
import { croomFixtureBytes } from "./fixture.ts";
import { withCroom } from "./reader.ts";

const url = process.env.DATABASE_URL;

describe.runIf(url)("ControlRoom import (#57)", () => {
  const { db, close } = createDb(url ?? "", { max: 4 });
  const mailer = memoryMailer();
  const audit = createAudit(db);
  const keyring = createKeyring(db, { current: Buffer.alloc(32, 7), previous: [] });
  const auth = createAuth({
    db,
    secret: "test-secret-test-secret-test-secret-0",
    baseURL: "http://localhost:3000",
    testing: true,
    mailer,
    audit,
    keyring,
  });
  const storageRoot = mkdtempSync(join(tmpdir(), "hekate-croom-storage-"));
  const workDir = mkdtempSync(join(tmpdir(), "hekate-croom-work-"));
  const storage = createStorage(
    db,
    createBackends(storageConfigFromEnv({ STORAGE_LOCAL_PATH: storageRoot })),
    keyring,
  );
  const sent: { name: string; data: unknown }[] = [];
  const jobs = {
    send: async (name: string, data: unknown) => {
      sent.push({ name, data });
      return "job";
    },
  };
  const app = createApp({
    db,
    auth,
    mailer,
    storage,
    audit,
    jobs,
    keyring,
    playbackSecret: playbackSecret("test-secret-test-secret-test-secret-0"),
    trustProxy: true,
    publicUrl: "http://localhost:3000",
    log: false,
    workDir,
  });

  const json = (body: unknown, cookie?: string, method = "POST") => ({
    method,
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const cookieOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  const get = (path: string, cookie: string) => app.request(path, { headers: { cookie } });
  const post = (path: string, body: unknown, cookie: string) =>
    app.request(path, json(body, cookie));
  const idOf = async (cookie: string) =>
    ((await (await get("/api/me", cookie)).json()) as { user: { id: string } }).user.id;
  const organisationOf = async (cookie: string) =>
    ((await (await get("/api/me", cookie)).json()) as { activeOrganisationId: string })
      .activeOrganisationId;

  /** Sends a `.croom` file, as the import page does: the bytes as the body. */
  const send = (path: string, bytes: Uint8Array, cookie: string) =>
    app.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        origin: "http://localhost:3000",
        cookie,
      },
      body: new Uint8Array(bytes),
    });

  const setup = async () =>
    cookieOf(
      await app.request(
        "/api/setup",
        json({
          name: "Mira Solberg",
          email: "mira@endlesshall.example",
          password: "correct horse battery",
          organisation: "Endless Hall Records",
        }),
      ),
    );
  const joinAs = async (owner: string, email: string, name: string) => {
    const invited = await post("/api/organisation/invitations", { email, role: "member" }, owner);
    const { link } = (await invited.json()) as { link: string };
    const res = await app.request(
      `/api/invitations/${link.split("/invite/")[1]}/accept`,
      json({ name, password: "correct horse battery" }),
    );
    expect(res.status).toBe(201);
    return cookieOf(res);
  };
  const grantRole = async (owner: string, projectId: string, holder: string, name: string) => {
    const listed = (await (await get(`/api/projects/${projectId}/roles`, owner)).json()) as {
      roles: { id: string; name: string }[];
    };
    let role = listed.roles.find((r) => r.name === name);
    if (!role) {
      const permissions = defaultProjectRoles.find((r) => r.name === name)?.permissions ?? [];
      const made = await post(`/api/projects/${projectId}/roles`, { name, permissions }, owner);
      role = ((await made.json()) as { role: { id: string; name: string } }).role;
    }
    const res = await app.request(
      `/api/projects/${projectId}/members/${await idOf(holder)}`,
      json({ roleId: role.id }, owner, "PUT"),
    );
    expect(res.status).toBe(204);
  };
  const project = async (cookie: string, name = "Joplin Rags") => {
    const res = await post("/api/projects", { name, profile: "music" }, cookie);
    expect(res.status).toBe(201);
    return ((await res.json()) as { project: { id: string } }).project.id;
  };

  /** How many rows of each production table a workspace holds. */
  const rowsIn = async (organisationId: string) => {
    const tables = {
      works: schema.works,
      tracks: schema.tracks,
      files: schema.files,
      blobs: schema.blobs,
      venues: schema.venues,
      personnel: schema.personnel,
      sessions: schema.sessions,
      takes: schema.takes,
      scoreMarks: schema.scoreMarks,
      scheduleDays: schema.scheduleDays,
      scheduleRows: schema.scheduleRows,
      stagePlans: schema.stagePlans,
      stageItems: schema.stageItems,
      stageBoxes: schema.stageBoxes,
      patchRows: schema.patchRows,
      sessionTodos: schema.sessionTodos,
    };
    const out: Record<string, number> = {};
    for (const [name, table] of Object.entries(tables)) {
      const [row] = await db
        .select({ n: count() })
        .from(table)
        .where(eq(table.organisationId, organisationId));
      out[name] = row?.n ?? 0;
    }
    return out;
  };

  beforeAll(async () => {
    await runMigrations(url ?? "");
  });
  beforeEach(async () => {
    sent.length = 0;
    await withAuditPurge(db, (tx) =>
      tx.execute(sql`truncate ${schema.organisations}, ${schema.users} cascade`),
    );
    await db.execute(sql`truncate ${schema.requestLimits}`);
  });
  afterAll(async () => {
    await withAuditPurge(db, (tx) =>
      tx.execute(sql`truncate ${schema.organisations}, ${schema.users} cascade`),
    );
    await close();
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  it("previews a file without writing anything, and leaves no scratch file behind", async () => {
    const owner = await setup();
    const organisationId = await organisationOf(owner);
    const projectId = await project(owner);
    const before = await rowsIn(organisationId);
    const res = await send(`/api/projects/${projectId}/croom/preview`, croomFixtureBytes(), owner);
    expect(res.status).toBe(200);
    const { preview } = (await res.json()) as { preview: CroomPreview };
    expect(preview).toMatchObject({ schemaVersion: 1, events: { undone: 3 } });
    expect(Object.fromEntries(preview.counts.map((c) => [c.kind, c.create]))).toMatchObject({
      work: 2,
      track: 3,
      file: 2,
      take: 4,
      todo: 2,
      "score-mark": 9,
      "stage-item": 8,
    });
    expect(preview.report.unknownEvents).toEqual([{ type: "frobnicate_widget", count: 1 }]);
    expect(preview.names.find((n) => n.kind === "work")?.names).toEqual(["Rags", "Opening titles"]);
    expect(await rowsIn(organisationId)).toEqual(before);
    expect(sent).toEqual([]);
    expect(readdirSync(workDir)).toEqual([]);
  });

  it("imports everything in the file into the project, the score stored encrypted", async () => {
    const owner = await setup();
    const organisationId = await organisationOf(owner);
    const projectId = await project(owner);
    const res = await send(`/api/projects/${projectId}/croom/import`, croomFixtureBytes(), owner);
    expect(res.status).toBe(201);
    const { imported } = (await res.json()) as { imported: CroomImported };
    expect(imported.report.unknownFields).toEqual([
      { type: "update_venue", field: "postcode", count: 1 },
    ]);
    // Two scores, an attached photo and the stage plan's underlay.
    expect(await rowsIn(organisationId)).toEqual({
      works: 2,
      tracks: 3,
      files: 4,
      blobs: 4,
      venues: 2,
      personnel: 5,
      sessions: 1,
      takes: 4,
      scoreMarks: 9,
      scheduleDays: 1,
      scheduleRows: 5,
      stagePlans: 1,
      stageItems: 8,
      stageBoxes: 1,
      patchRows: 3,
      sessionTodos: 2,
    });
    expect(readdirSync(workDir)).toEqual([]);

    // The work, its tracks in order on its score, and the score as a document of the project.
    const repertoire = (await (
      await get(`/api/projects/${projectId}/repertoire`, owner)
    ).json()) as {
      works: {
        title: string;
        scoreFileId: string | null;
        tracks: { name: string; number: string }[];
      }[];
    };
    const rags = repertoire.works.find((w) => w.title === "Rags");
    expect(rags?.tracks.map((t) => [t.name, t.number])).toEqual([
      ["Maple Leaf Rag", "1"],
      ["The Entertainer", "2"],
    ]);
    const importedFiles = await db
      .select()
      .from(schema.files)
      .where(inOrg(schema.files, organisationId, eq(schema.files.projectId, projectId)));
    expect(importedFiles.map((f) => [f.name, f.kind, f.contentType]).sort()).toEqual([
      ["Endless Hall floor plan.png", "image", "image/png"],
      ["Joplin Rags - Score.pdf", "document", "application/pdf"],
      ["Opening titles.pdf", "document", "application/pdf"],
      ["mic-setup.png", "image", "image/png"],
    ]);
    const score = importedFiles.find((f) => f.name === "Joplin Rags - Score.pdf");
    expect(score).toMatchObject({ kind: "document", streamStatus: "pending" });
    expect(rags?.scoreFileId).toBe(score?.id);
    const { stream } = await storage.open(organisationId, score?.blobId ?? "");
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).subarray(0, 5).toString()).toBe("%PDF-");
    // What is stored on disk is ciphertext only.
    const [blob] = await db
      .select()
      .from(schema.blobs)
      .where(eq(schema.blobs.id, score?.blobId ?? ""));
    const { readFileSync } = await import("node:fs");
    const onDisk = readFileSync(join(storageRoot, blob?.key ?? ""));
    expect(onDisk.includes(Buffer.from("%PDF-"))).toBe(false);
    // Each is drawn as any document or picture is.
    expect(sent.map((s) => s.name)).toEqual([
      "document-render",
      "document-render",
      "document-render",
      "document-render",
    ]);

    // Takes on their tracks, numbered, rated and in their session.
    const takes = await db
      .select({
        track: schema.tracks.name,
        number: schema.takes.number,
        rating: schema.takes.rating,
        falseStarts: schema.takes.falseStarts,
        sessionId: schema.takes.sessionId,
      })
      .from(schema.takes)
      .innerJoin(schema.tracks, eq(schema.tracks.id, schema.takes.trackId))
      .where(eq(schema.takes.organisationId, organisationId))
      .orderBy(asc(schema.tracks.name), asc(schema.takes.number));
    expect(takes.map((t) => [t.track, t.number, t.rating, t.falseStarts])).toEqual([
      ["Maple Leaf Rag", 1, 3, 0],
      ["Maple Leaf Rag", 2, 5, 1],
      ["Opening titles", 1, 0, 0],
      ["The Entertainer", 1, 0, 0],
    ]);
    // All in the one session the file is, with its to-dos in the file's order.
    expect(new Set(takes.map((t) => t.sessionId)).size).toBe(1);
    expect(takes.every((t) => t.sessionId !== null)).toBe(true);
    const [session] = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.organisationId, organisationId));
    expect(session).toMatchObject({
      name: "Joplin Rags",
      numbering: "per-track",
      recordedOn: "2026-09-12",
    });
    const todos = await db
      .select({ text: schema.sessionTodos.text, done: schema.sessionTodos.done })
      .from(schema.sessionTodos)
      .where(eq(schema.sessionTodos.organisationId, organisationId))
      .orderBy(asc(schema.sessionTodos.createdAt));
    expect(todos).toEqual([
      { text: "Send the edit list to Tomas", done: false },
      { text: "Check the piano's tuning", done: true },
    ]);
    // The T-edit, and the issue in its category, marked when ControlRoom marked it.
    const marks = await db
      .select()
      .from(schema.scoreMarks)
      .where(eq(schema.scoreMarks.organisationId, organisationId));
    expect(marks.find((m) => m.kind === "edit" && m.fromTake === 1)).toMatchObject({ toTake: 2 });
    const issue = marks.find((m) => m.kind === "issue");
    expect(issue?.categoryId).not.toBeNull();
    expect(issue?.createdAt.toISOString().slice(0, 10)).toBe("2026-09-12");
    expect(issue?.resolvedAt).not.toBeNull();
    // The floor plan under the stage, 400 pixels at 3 cm a pixel.
    const [plan] = await db
      .select()
      .from(schema.stagePlans)
      .where(eq(schema.stagePlans.organisationId, organisationId));
    expect(plan?.underlayFileId).toBe(importedFiles.find((f) => f.name.includes("floor plan"))?.id);
    expect(plan?.underlayWidth).toBe(12);
    // The microphone plugged into Box A's first input, the performer standing for the pianist.
    const items = await db
      .select()
      .from(schema.stageItems)
      .where(eq(schema.stageItems.organisationId, organisationId));
    expect(items.find((i) => i.kind === "mic")?.patchRowId).not.toBeNull();
    expect(items.find((i) => i.kind === "performer")?.personnelId).not.toBeNull();
    // The import, and the score's arrival, are in the access log.
    const logged = await db
      .select({ action: schema.accessEvents.action })
      .from(schema.accessEvents)
      .where(
        and(
          eq(schema.accessEvents.organisationId, organisationId),
          eq(schema.accessEvents.projectId, projectId),
        ),
      );
    expect(logged.map((l) => l.action)).toEqual(
      expect.arrayContaining(["file.upload", "project.croom_import"]),
    );
  });

  it("merges a second import into what the first made, or adds beside it", async () => {
    const owner = await setup();
    const organisationId = await organisationOf(owner);
    const projectId = await project(owner);
    expect(
      (await send(`/api/projects/${projectId}/croom/import`, croomFixtureBytes(), owner)).status,
    ).toBe(201);
    const preview = (await (
      await send(
        `/api/projects/${projectId}/croom/preview?conflicts=merge`,
        croomFixtureBytes(),
        owner,
      )
    ).json()) as { preview: CroomPreview };
    expect(preview.preview.conflicts.map((c) => c.kind)).toEqual(
      expect.arrayContaining(["work", "venue", "stage-plan", "stage-box"]),
    );
    expect(preview.preview.counts.find((c) => c.kind === "work")).toMatchObject({
      create: 0,
      merge: 2,
    });
    expect(
      (
        await send(
          `/api/projects/${projectId}/croom/import?conflicts=merge`,
          croomFixtureBytes(),
          owner,
        )
      ).status,
    ).toBe(201);
    const merged = await rowsIn(organisationId);
    expect(merged).toMatchObject({ works: 2, tracks: 3, venues: 2, takes: 4, stagePlans: 1 });
    expect(
      (
        await send(
          `/api/projects/${projectId}/croom/import?conflicts=new`,
          croomFixtureBytes(),
          owner,
        )
      ).status,
    ).toBe(201);
    const added = await db
      .select({ name: schema.venues.name })
      .from(schema.venues)
      .where(eq(schema.venues.organisationId, organisationId))
      .orderBy(asc(schema.venues.position));
    expect(added.map((v) => v.name)).toContain("Endless Hall (2)");
    expect((await rowsIn(organisationId)).works).toBe(4);
  });

  it("plugs a new plan's microphone into the channel a merged box already had", async () => {
    const owner = await setup();
    const organisationId = await organisationOf(owner);
    const projectId = await project(owner);
    expect(
      (await send(`/api/projects/${projectId}/croom/import`, croomFixtureBytes(), owner)).status,
    ).toBe(201);
    // The first plan renamed, so the second import's plan is new while its box merges.
    await db
      .update(schema.stagePlans)
      .set({ name: "Endless Hall, last year" })
      .where(eq(schema.stagePlans.organisationId, organisationId));
    const before = await db
      .select({ id: schema.patchRows.id })
      .from(schema.patchRows)
      .where(eq(schema.patchRows.organisationId, organisationId));
    expect(
      (
        await send(
          `/api/projects/${projectId}/croom/import?conflicts=merge`,
          croomFixtureBytes(),
          owner,
        )
      ).status,
    ).toBe(201);
    const mics = await db
      .select({ patchRowId: schema.stageItems.patchRowId })
      .from(schema.stageItems)
      .where(
        and(
          eq(schema.stageItems.organisationId, organisationId),
          eq(schema.stageItems.kind, "mic"),
        ),
      );
    expect(mics).toHaveLength(2);
    const held = new Set(before.map((r) => r.id));
    expect(mics.every((m) => m.patchRowId !== null && held.has(m.patchRowId))).toBe(true);
  });

  it("refuses a lesser role, another workspace, and a file that is not a project", async () => {
    const owner = await setup();
    const organisationId = await organisationOf(owner);
    const projectId = await project(owner);
    const engineer = await joinAs(owner, "tomas@endlesshall.example", "Tomas Varga");
    await grantRole(owner, projectId, engineer, "Engineer");
    for (const step of ["preview", "import"])
      expect(
        (await send(`/api/projects/${projectId}/croom/${step}`, croomFixtureBytes(), engineer))
          .status,
      ).toBe(403);
    // A producer manages the project, so may.
    const producer = await joinAs(owner, "ines@endlesshall.example", "Ines Arlow");
    await grantRole(owner, projectId, producer, "Producer");
    expect(
      (await send(`/api/projects/${projectId}/croom/preview`, croomFixtureBytes(), producer))
        .status,
    ).toBe(200);

    // The owner of another workspace finds no such project.
    const outsider = await joinAs(owner, "alex@saltmarsh.example", "Alex Rivera");
    const outsiderId = await idOf(outsider);
    const [elsewhere] = await db
      .insert(schema.organisations)
      .values({ name: "Saltmarsh Films", slug: "saltmarsh" })
      .returning({ id: schema.organisations.id });
    await db.delete(schema.members).where(eq(schema.members.userId, outsiderId));
    await db
      .insert(schema.members)
      .values({ organisationId: elsewhere?.id ?? "", userId: outsiderId, role: "owner" });
    await db
      .update(schema.authSessions)
      .set({ activeOrganisationId: elsewhere?.id ?? "" })
      .where(eq(schema.authSessions.userId, outsiderId));
    expect(await organisationOf(outsider)).toBe(elsewhere?.id);
    for (const step of ["preview", "import"])
      expect(
        (await send(`/api/projects/${projectId}/croom/${step}`, croomFixtureBytes(), outsider))
          .status,
      ).toBe(404);

    // Not a project file: refused, saying why.
    const junk = await send(
      `/api/projects/${projectId}/croom/preview`,
      new TextEncoder().encode("certainly not SQLite"),
      owner,
    );
    expect(junk.status).toBe(422);
    expect(await junk.json()).toMatchObject({ error: { code: "invalid_croom" } });
    const noTable = await send(
      `/api/projects/${projectId}/croom/import`,
      croomFixtureBytes({ without: "blobs" }),
      owner,
    );
    expect(noTable.status).toBe(422);
    expect((await rowsIn(organisationId)).works).toBe(0);
    expect(readdirSync(workDir)).toEqual([]);
  });

  it("writes nothing if any part of the import fails, and takes the stored score back", async () => {
    const owner = await setup();
    const organisationId = await organisationOf(owner);
    const projectId = await project(owner);
    const userId = await idOf(owner);
    const before = await rowsIn(organisationId);
    const storedFiles = () =>
      readdirSync(storageRoot, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => join(e.parentPath, e.name))
        .sort();
    const storedBefore = storedFiles();
    await expect(
      withCroom(workDir, croomFixtureBytes(), 10_000_000, (source) =>
        commitImport({ db, storage, audit, jobs }, source, {
          organisationId,
          projectId,
          userId,
          actor: { type: "member", userId, label: "Mira Solberg" },
          choice: "merge",
          beforeCommit: async (tx) => {
            // Everything is written by now: prove it, then fail.
            const [made] = await tx
              .select({ n: count() })
              .from(schema.takes)
              .where(eq(schema.takes.organisationId, organisationId));
            expect(made?.n).toBe(4);
            throw new Error("the disk filled up");
          },
        }),
      ),
    ).rejects.toThrow("the disk filled up");
    expect(await rowsIn(organisationId)).toEqual(before);
    // No bytes left in storage either.
    expect(storedFiles()).toEqual(storedBefore);
    expect(sent).toEqual([]);
  });

  it("refuses an archived project", async () => {
    const owner = await setup();
    const projectId = await project(owner);
    await db
      .update(schema.projects)
      .set({ archivedAt: new Date() })
      .where(eq(schema.projects.id, projectId));
    // Archived, a project keeps only the permissions that look.
    expect(
      (await send(`/api/projects/${projectId}/croom/import`, croomFixtureBytes(), owner)).status,
    ).toBe(403);
  });
});

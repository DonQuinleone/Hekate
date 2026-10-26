import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, inOrg, runMigrations, schema, withAuditPurge } from "@hekate/db";
import { defaultProjectRoles, defaultReviewerPermissions } from "@hekate/shared";
import { createBackends, storageConfigFromEnv } from "@hekate/storage";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { waveBytes } from "../../../packages/shared/src/fixtures/wave.ts";
import { createApp } from "./app.ts";
import { createAudit } from "./audit.ts";
import { createAuth } from "./auth.ts";
import { issueGuestLink } from "./guests.ts";
import { createKeyring } from "./keyring.ts";
import { memoryMailer } from "./mail.ts";
import { probe } from "./media/ffmpeg.ts";
import { playbackSecret } from "./playback.ts";
import { createStorage } from "./storage.ts";

const url = process.env.DATABASE_URL;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

/**
 * Correcting a recording's embedded metadata (decision 264): for those who organise its files
 * and have the QA tool, in their own workspace; kept as Hekate's record, read by the checks,
 * logged, and written into the original only as it leaves.
 */
describe.runIf(url)("the metadata editor", () => {
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
  const storageRoot = mkdtempSync(join(tmpdir(), "hekate-metadata-storage-"));
  const work = mkdtempSync(join(tmpdir(), "hekate-metadata-work-"));
  const dir = mkdtempSync(join(tmpdir(), "hekate-metadata-files-"));
  const storage = createStorage(
    db,
    createBackends(storageConfigFromEnv({ STORAGE_LOCAL_PATH: storageRoot })),
    keyring,
  );
  const app = createApp({
    db,
    auth,
    mailer,
    storage,
    audit,
    jobs: { send: async () => "job" },
    keyring,
    playbackSecret: playbackSecret("test-secret-test-secret-test-secret-0"),
    trustProxy: true,
    publicUrl: "http://localhost:3000",
    log: false,
    workDir: work,
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
  const edit = (fileId: string, changes: Record<string, string | null>, cookie: string) =>
    app.request(`/api/files/${fileId}/metadata`, json({ changes }, cookie, "PUT"));
  const idOf = async (cookie: string) =>
    ((await (await get("/api/me", cookie)).json()) as { user: { id: string } }).user.id;

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
  const grantRole = async (
    owner: string,
    projectId: string,
    holder: string,
    name: string,
    own?: { permissions: string[]; tools: string[] },
  ) => {
    const listed = (await (await get(`/api/projects/${projectId}/roles`, owner)).json()) as {
      roles: { id: string; name: string }[];
    };
    let role = listed.roles.find((r) => r.name === name);
    if (!role) {
      const permissions =
        own?.permissions ?? defaultProjectRoles.find((r) => r.name === name)?.permissions ?? [];
      const made = await post(
        `/api/projects/${projectId}/roles`,
        { name, permissions, ...(own ? { tools: own.tools } : {}) },
        owner,
      );
      role = ((await made.json()) as { role: { id: string; name: string } }).role;
    }
    const res = await app.request(
      `/api/projects/${projectId}/members/${await idOf(holder)}`,
      json({ roleId: role.id }, owner, "PUT"),
    );
    expect(res.status).toBe(204);
  };

  /** A recording as Broadcast Wave: bext, iXML, and half a second of silence. */
  const recording = Buffer.from(
    waveBytes({
      channels: 2,
      seconds: 0.5,
      description: "Maple Leaf Rag, V2 dry",
      day: "2026-10-14",
      ixml: { scene: "12", take: "3", rate: "25/1" },
    }),
  );

  /** A workspace's owner, a project with the recording, and an engineer and a reviewer on it. */
  const studio = async () => {
    const owner = await setup();
    const organisationId = (
      (await (await get("/api/me", owner)).json()) as { activeOrganisationId: string }
    ).activeOrganisationId;
    const made = await post("/api/projects", { name: "Joplin Rags", profile: "music" }, owner);
    const projectId = ((await made.json()) as { project: { id: string } }).project.id;
    const engineer = await joinAs(owner, "ines@endlesshall.example", "Ines Arlow");
    const reviewer = await joinAs(owner, "alex@endlesshall.example", "Alex Rivera");
    const archivist = await joinAs(owner, "tomas@endlesshall.example", "Tomas Varga");
    await grantRole(owner, projectId, engineer, "Engineer");
    await grantRole(owner, projectId, reviewer, "Reviewer");
    // Organises files, but has no QA.
    await grantRole(owner, projectId, archivist, "Archivist", {
      permissions: ["view", "upload", "organise"],
      tools: ["score"],
    });
    const blob = await storage.put(organisationId, recording);
    writeFileSync(join(dir, "probe.wav"), recording);
    const mediaInfo = hasFfmpeg
      ? await probe(join(dir, "probe.wav"))
      : {
          format: "wav",
          duration: 0.5,
          audio: { codec: "pcm_s24le", channels: 2, sampleRate: 48_000 },
          metadata: {
            bext: { description: "Maple Leaf Rag, V2 dry", originationDate: "2026-10-14" },
            ixml: { bytes: 120, scene: "12", take: "3", timecodeRate: "25/1" },
            tags: {},
          },
        };
    const [file] = await db
      .insert(schema.files)
      .values({
        organisationId,
        projectId,
        name: "Maple Leaf Rag - V2 dry.wav",
        kind: "audio",
        blobId: blob.id,
        contentType: "audio/wav",
        byteSize: blob.byteSize,
        mediaInfo,
      })
      .returning();
    return {
      owner,
      engineer,
      reviewer,
      archivist,
      organisationId,
      projectId,
      fileId: file?.id ?? "",
    };
  };

  /** A download, asked for and taken. */
  const download = async (fileId: string, cookie: string) => {
    const asked = await post(`/api/files/${fileId}/downloads`, { kind: "original" }, cookie);
    expect(asked.status).toBe(201);
    const { url: link } = (await asked.json()) as { url: string };
    return get(link, cookie);
  };

  beforeAll(async () => {
    await runMigrations(url ?? "");
  });
  beforeEach(async () => {
    await withAuditPurge(db, (tx) =>
      tx.execute(sql`truncate ${schema.organisations}, ${schema.users} cascade`),
    );
    await db.execute(sql`truncate ${schema.requestLimits}`);
  });
  afterAll(async () => {
    await close();
    for (const path of [storageRoot, work, dir]) rmSync(path, { recursive: true, force: true });
  });

  it("keeps a correction as Hekate's record, logs it, and lets the checks read it", async () => {
    const s = await studio();
    const before = (await (await get(`/api/files/${s.fileId}/metadata`, s.engineer)).json()) as {
      format: string;
      fields: string[];
      editable: boolean;
    };
    expect(before.format).toBe("wave");
    expect(before.editable).toBe(true);
    expect(before.fields).toContain("isrc");
    expect(before.fields).toContain("scene");

    // A rule of the project's asks for an ISRC: the file has none.
    const rule = {
      id: "0192f3a1-0000-7000-8000-000000000001",
      name: "ISRC filled in",
      appliesTo: "any",
      measure: "isrc",
      operator: "matches",
      value: "?*",
      severity: "fail",
      on: true,
    };
    await db
      .update(schema.projects)
      .set({ qaSettings: { delivery: true, checks: {}, rules: [rule] } as never })
      .where(eq(schema.projects.id, s.projectId));
    const ruled = async () =>
      (
        (await (await get(`/api/files/${s.fileId}/qa`, s.engineer)).json()) as {
          findings: { check: string; severity: string }[];
        }
      ).findings.find((f) => f.check === "custom")?.severity;
    expect(await ruled()).toBe("fail");

    const saved = await edit(
      s.fileId,
      { isrc: "GB-ABC-26-00001", scene: "14", originator: "Endless Hall Records" },
      s.engineer,
    );
    expect(saved.status).toBe(200);
    const body = (await saved.json()) as {
      corrections: Record<string, { value: string; read: string | null }>;
    };
    expect(body.corrections).toEqual({
      isrc: { value: "GB-ABC-26-00001", read: null },
      scene: { value: "14", read: "12" },
      originator: { value: "Endless Hall Records", read: null },
    });
    // The file reads as corrected wherever its metadata is read, the checks among them.
    const [row] = await db
      .select({ mediaInfo: schema.files.mediaInfo, blobId: schema.files.blobId })
      .from(schema.files)
      .where(inOrg(schema.files, s.organisationId, eq(schema.files.id, s.fileId)));
    expect(row?.mediaInfo?.metadata?.tags.isrc).toBe("GB-ABC-26-00001");
    expect(row?.mediaInfo?.metadata?.ixml?.scene).toBe("14");
    expect(await ruled()).toBe("pass");
    // The stored original is untouched.
    const { stream } = await storage.open(s.organisationId, row?.blobId ?? "");
    expect(Buffer.concat(await stream.toArray()).equals(recording)).toBe(true);

    // Every edit is logged, with what each field said and now says.
    await edit(s.fileId, { scene: null }, s.engineer);
    const logged = await db
      .select({ details: schema.accessEvents.details, fileId: schema.accessEvents.fileId })
      .from(schema.accessEvents)
      .where(
        and(
          inOrg(schema.accessEvents, s.organisationId),
          eq(schema.accessEvents.action, "file.metadata_edit"),
        ),
      )
      .orderBy(schema.accessEvents.id);
    expect(logged).toEqual([
      {
        fileId: s.fileId,
        details: {
          changes: [
            { field: "isrc", from: null, to: "GB-ABC-26-00001" },
            { field: "scene", from: "12", to: "14" },
            { field: "originator", from: null, to: "Endless Hall Records" },
          ],
        },
      },
      { fileId: s.fileId, details: { changes: [{ field: "scene", from: "14", to: "12" }] } },
    ]);
    // Nothing changed is nothing logged.
    expect((await edit(s.fileId, { scene: "12" }, s.engineer)).status).toBe(200);
    const after = await db
      .select({ id: schema.accessEvents.id })
      .from(schema.accessEvents)
      .where(eq(schema.accessEvents.action, "file.metadata_edit"));
    expect(after).toHaveLength(2);
  }, 60_000);

  it("refuses a lesser role, a role without QA, a guest and another workspace", async () => {
    const s = await studio();
    // A reviewer has neither organising nor QA; an archivist organises but has no QA.
    expect((await edit(s.fileId, { isrc: "GBABC2600001" }, s.reviewer)).status).toBe(403);
    expect((await edit(s.fileId, { isrc: "GBABC2600001" }, s.archivist)).status).toBe(403);
    expect((await get(`/api/files/${s.fileId}/metadata`, s.archivist)).status).toBe(403);
    // A value its field cannot hold, or a field the format has no place for.
    expect((await edit(s.fileId, { isrc: "none" }, s.engineer)).status).toBe(400);
    expect((await edit(s.fileId, { composer: "Scott Joplin" }, s.engineer)).status).toBe(422);

    // A guest of a review with every tool still cannot.
    const [guest] = await db
      .insert(schema.guests)
      .values({ organisationId: s.organisationId, name: "Alex Rivera", email: "a@guest.example" })
      .returning();
    const [review] = await db
      .insert(schema.reviews)
      .values({
        organisationId: s.organisationId,
        projectId: s.projectId,
        kind: "feedback",
        title: "First listen",
      })
      .returning();
    await db.insert(schema.reviewItems).values({
      organisationId: s.organisationId,
      reviewId: review?.id ?? "",
      fileId: s.fileId,
    });
    await db.insert(schema.reviewReviewers).values({
      organisationId: s.organisationId,
      reviewId: review?.id ?? "",
      guestId: guest?.id ?? "",
      position: 0,
      permissions: { ...defaultReviewerPermissions, tools: ["qa", "meters"] } as never,
    });
    const opened = await app.request(
      "/api/guest/sessions",
      json({ token: (await issueGuestLink(db, s.organisationId, guest?.id ?? "")).token }),
    );
    const guestCookie = cookieOf(opened);
    expect((await edit(s.fileId, { isrc: "GBABC2600001" }, guestCookie)).status).toBe(403);
    expect((await get(`/api/files/${s.fileId}/metadata`, guestCookie)).status).toBe(403);

    // Another workspace's owner does not find the file at all.
    const [other] = await db
      .insert(schema.organisations)
      .values({ name: "Saltmarsh Films", slug: "saltmarsh" })
      .returning();
    const [project] = await db
      .insert(schema.projects)
      .values({ organisationId: other?.id ?? "", name: "Opening titles", profile: "music" })
      .returning();
    const blob = await storage.put(other?.id ?? "", recording);
    const [foreign] = await db
      .insert(schema.files)
      .values({
        organisationId: other?.id ?? "",
        projectId: project?.id ?? "",
        name: "Opening titles.wav",
        kind: "audio",
        blobId: blob.id,
        contentType: "audio/wav",
        byteSize: blob.byteSize,
        mediaInfo: {
          format: "wav",
          audio: { codec: "pcm_s24le", channels: 2, sampleRate: 48_000 },
          metadata: { tags: {} },
        },
      })
      .returning();
    expect((await edit(foreign?.id ?? "", { isrc: "GBABC2600001" }, s.owner)).status).toBe(404);
    expect((await get(`/api/files/${foreign?.id}/metadata`, s.owner)).status).toBe(404);
    const [untouched] = await db
      .select({ corrections: schema.files.metadataCorrections })
      .from(schema.files)
      .where(eq(schema.files.id, foreign?.id ?? ""));
    expect(untouched?.corrections).toBeNull();
  }, 60_000);

  it.runIf(hasFfmpeg || process.env.CI)(
    "writes the corrections into the original as it is downloaded, marked or not",
    async () => {
      const s = await studio();
      await edit(
        s.fileId,
        { isrc: "GB-ABC-26-00001", scene: "14", originator: "Endless Hall Records" },
        s.engineer,
      );
      const choices = (await (
        await get(`/api/files/${s.fileId}/downloads`, s.engineer)
      ).json()) as {
        original: { detail: string };
      };
      expect(choices.original.detail).toMatch(/with its corrected metadata$/);

      const check = async (bytes: Buffer, name: string) => {
        writeFileSync(join(dir, name), bytes);
        const info = await probe(join(dir, name));
        expect(info.metadata?.tags.isrc).toBe("GB-ABC-26-00001");
        expect(info.metadata?.ixml).toMatchObject({ scene: "14", take: "3" });
        expect(info.metadata?.bext).toMatchObject({
          originator: "Endless Hall Records",
          description: "Maple Leaf Rag, V2 dry",
        });
        expect(info.duration).toBeCloseTo(0.5, 2);
      };
      const plain = await download(s.fileId, s.engineer);
      expect(plain.status).toBe(200);
      expect(plain.headers.get("content-type")).toBe("audio/wav");
      await check(Buffer.from(await plain.arrayBuffer()), "plain.wav");

      // Marked for its recipient too (decision 239), the corrections written over the marked file.
      const on = await app.request(
        "/api/organisation/forensic",
        json({ audio: true }, s.owner, "PUT"),
      );
      expect(on.status).toBe(200);
      const markedChoices = (await (
        await get(`/api/files/${s.fileId}/downloads`, s.engineer)
      ).json()) as { marked: boolean; original: { detail: string } };
      expect(markedChoices.marked).toBe(true);
      expect(markedChoices.original.detail).toMatch(/inaudible mark, with its corrected metadata$/);
      const marked = await download(s.fileId, s.engineer);
      expect(marked.status).toBe(200);
      await check(Buffer.from(await marked.arrayBuffer()), "marked.wav");
      const [mark] = await db
        .select({ id: schema.forensicMarks.id })
        .from(schema.forensicMarks)
        .where(inOrg(schema.forensicMarks, s.organisationId));
      expect(mark).toBeDefined();
    },
    60_000,
  );
});

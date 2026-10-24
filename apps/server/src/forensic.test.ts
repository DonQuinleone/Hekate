import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, inOrg, runMigrations, schema, withAuditPurge } from "@hekate/db";
import { defaultProjectRoles, type ForensicStatus, type TraceResult } from "@hekate/shared";
import { createBackends, storageConfigFromEnv } from "@hekate/storage";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { createAudit } from "./audit.ts";
import { createAuth } from "./auth.ts";
import { createKeyring } from "./keyring.ts";
import { memoryMailer } from "./mail.ts";
import { probe, run } from "./media/ffmpeg.ts";
import { sampleMusic } from "./media/sample-music.ts";
import { playbackSecret } from "./playback.ts";
import { createStorage } from "./storage.ts";

const url = process.env.DATABASE_URL;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe.runIf(url)("forensic marking and leak tracing (#32)", () => {
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
  const storageRoot = mkdtempSync(join(tmpdir(), "hekate-forensic-storage-"));
  const work = mkdtempSync(join(tmpdir(), "hekate-forensic-work-"));
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
  const trace = (bytes: Buffer, cookie: string, name = "leaked.wav") =>
    app.request("/api/organisation/forensic/trace", {
      method: "POST",
      headers: {
        cookie,
        origin: "http://localhost:3000",
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent(name),
      },
      body: new Uint8Array(bytes),
    });
  const idOf = async (cookie: string) =>
    ((await (await get("/api/me", cookie)).json()) as { user: { id: string } }).user.id;
  const organisationOf = async (cookie: string) =>
    ((await (await get("/api/me", cookie)).json()) as { activeOrganisationId: string })
      .activeOrganisationId;

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
  const joinAs = async (owner: string, email: string, name: string, role = "member") => {
    const invited = await post("/api/organisation/invitations", { email, role }, owner);
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

  /** Thirty seconds of a 24-bit stereo recording, as a WAV file's bytes. */
  let recording = Buffer.alloc(0);
  const dir = mkdtempSync(join(tmpdir(), "hekate-forensic-files-"));

  /** A workspace, its owner, a project with the recording in it, and an engineer on it. */
  const studio = async () => {
    const owner = await setup();
    const organisationId = await organisationOf(owner);
    const made = await post("/api/projects", { name: "Joplin Rags", profile: "music" }, owner);
    const projectId = ((await made.json()) as { project: { id: string } }).project.id;
    const engineer = await joinAs(owner, "tomas@endlesshall.example", "Tomas Varga");
    await grantRole(owner, projectId, engineer, "Engineer");
    const blob = await storage.put(organisationId, recording);
    writeFileSync(join(dir, "probe.wav"), recording);
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
        mediaInfo: await probe(join(dir, "probe.wav")),
      })
      .returning();
    // Off until the owners turn it on (decision 239).
    const on = await app.request("/api/organisation/forensic", json({ audio: true }, owner, "PUT"));
    expect(on.status).toBe(200);
    return { owner, engineer, organisationId, projectId, fileId: file?.id ?? "" };
  };
  /** A download, asked for and taken, as someone with the cookie would. */
  const download = async (fileId: string, kind: "proxy" | "original", cookie: string) => {
    const asked = await post(`/api/files/${fileId}/downloads`, { kind }, cookie);
    expect(asked.status).toBe(201);
    const { url: link } = (await asked.json()) as { url: string };
    return get(link, cookie);
  };

  beforeAll(async () => {
    await runMigrations(url ?? "");
    if (!hasFfmpeg) return;
    const left = sampleMusic(30, 22_050, { seed: 41 });
    const right = sampleMusic(30, 22_050, { seed: 42 });
    const both = new Float32Array(left.length * 2);
    for (let i = 0; i < left.length; i++) {
      both[2 * i] = (left[i] as number) * 0.8 + (right[i] as number) * 0.2;
      both[2 * i + 1] = (right[i] as number) * 0.8 + (left[i] as number) * 0.2;
    }
    writeFileSync(join(dir, "source.f32"), Buffer.from(both.buffer));
    await run(
      "ffmpeg",
      [
        ...["-v", "error", "-y", "-f", "f32le", "-ar", "22050", "-ac", "2"],
        ...["-i", join(dir, "source.f32"), "-ar", "44100", "-c:a", "pcm_s24le"],
        join(dir, "recording.wav"),
      ],
      { timeoutMs: 60_000 },
    );
    recording = readFileSync(join(dir, "recording.wav"));
  }, 60_000);
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

  it.runIf(hasFfmpeg || process.env.CI)(
    "marks a recording's download for whoever takes it, and traces a leak back to them",
    async () => {
      const { owner, engineer, organisationId, fileId } = await studio();
      const choices = (await (await get(`/api/files/${fileId}/downloads`, engineer)).json()) as {
        original: { available: boolean; detail: string };
        marked: boolean;
        inaudible?: boolean;
      };
      expect(choices).toMatchObject({ marked: true, inaudible: true });
      expect(choices.original.detail).toMatch(/^WAV, 24-bit, 44\.1 kHz/);

      const got = await download(fileId, "original", engineer);
      expect(got.status).toBe(200);
      expect(got.headers.get("content-type")).toBe("audio/wav");
      expect(got.headers.get("cache-control")).toContain("no-store");
      const leaked = Buffer.from(await got.arrayBuffer());
      // The same recording, the same length, but not the same bytes.
      writeFileSync(join(dir, "leaked.wav"), leaked);
      const info = await probe(join(dir, "leaked.wav"));
      expect(info.audio).toMatchObject({ codec: "pcm_s24le", channels: 2, sampleRate: 44_100 });
      expect(info.duration).toBeCloseTo(30, 1);
      expect(leaked.equals(recording)).toBe(false);

      // The mark is written down with its download's entry in the access log.
      const marks = await db
        .select()
        .from(schema.forensicMarks)
        .where(inOrg(schema.forensicMarks, organisationId));
      expect(marks).toHaveLength(1);
      const mark = marks[0];
      const [entry] = await db
        .select()
        .from(schema.accessEvents)
        .where(
          and(
            inOrg(schema.accessEvents, organisationId),
            eq(schema.accessEvents.action, "download"),
          ),
        );
      expect(mark).toMatchObject({
        fileId,
        kind: "original",
        userId: await idOf(engineer),
        accessEventId: entry?.id,
        recipientLabel: "Tomas Varga <tomas@endlesshall.example>",
      });

      // Encoded again as AAC and cut to 20 seconds, it still names the engineer.
      await run(
        "ffmpeg",
        [
          ...["-v", "error", "-y", "-ss", "4", "-t", "20", "-i", join(dir, "leaked.wav")],
          ...["-c:a", "aac", "-b:a", "128k", join(dir, "leaked.m4a")],
        ],
        { timeoutMs: 60_000 },
      );
      const traced = await trace(readFileSync(join(dir, "leaked.m4a")), owner, "leaked.m4a");
      expect(traced.status).toBe(200);
      const found = (await traced.json()) as TraceResult;
      expect(found.match).toMatchObject({
        id: mark?.id,
        recipient: "Tomas Varga <tomas@endlesshall.example>",
        fileName: "Maple Leaf Rag - V2 dry.wav",
        kind: "original",
        accessEventId: entry?.id,
      });
      expect(found.match?.chance).toBeLessThan(1e-6);
      expect(found.compared).toBe(1);

      // The original itself carries no mark; the trace of it is in the log as well.
      const plain = (await (await trace(recording, owner, "master.wav")).json()) as TraceResult;
      expect(plain.match).toBeNull();
      const traces = await db
        .select()
        .from(schema.accessEvents)
        .where(
          and(
            inOrg(schema.accessEvents, organisationId),
            eq(schema.accessEvents.action, "forensic.trace"),
          ),
        );
      expect(traces.map((t) => t.details)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "leaked.m4a", mark: mark?.id }),
          expect.objectContaining({ name: "master.wav", mark: null }),
        ]),
      );
      expect(traces.find((t) => t.details?.mark)?.fileId).toBe(fileId);
    },
    120_000,
  );

  it("is for owners alone, and turning it on is theirs and logged", async () => {
    const owner = await setup();
    const organisationId = await organisationOf(owner);
    const admin = await joinAs(owner, "ines@endlesshall.example", "Ines Arlow", "admin");
    const member = await joinAs(owner, "alex@endlesshall.example", "Alex Rivera");
    for (const cookie of [admin, member]) {
      expect((await get("/api/organisation/forensic", cookie)).status).toBe(403);
      expect(
        (await app.request("/api/organisation/forensic", json({ audio: false }, cookie, "PUT")))
          .status,
      ).toBe(403);
      expect((await trace(Buffer.from("anything"), cookie)).status).toBe(403);
    }
    // Admins change the other settings, never this one.
    expect(
      (
        await app.request(
          "/api/organisation/settings",
          json({ forensicAudio: false }, admin, "PATCH"),
        )
      ).status,
    ).toBe(400);
    const status = (await (
      await get("/api/organisation/forensic", owner)
    ).json()) as ForensicStatus;
    expect(status).toEqual({ included: true, audio: false, marks: 0 });
    const on = await app.request("/api/organisation/forensic", json({ audio: true }, owner, "PUT"));
    expect(((await on.json()) as ForensicStatus).audio).toBe(true);
    const [logged] = await db
      .select()
      .from(schema.accessEvents)
      .where(
        and(
          inOrg(schema.accessEvents, organisationId),
          eq(schema.accessEvents.action, "organisation.settings"),
        ),
      );
    expect(logged?.details).toEqual({ change: { forensicAudio: true } });
    // The admin's own change keeps the owners' choice.
    await app.request("/api/organisation/settings", json({ guestLinkDays: 14 }, admin, "PATCH"));
    expect(
      ((await (await get("/api/organisation/forensic", owner)).json()) as ForensicStatus).audio,
    ).toBe(true);
  });

  it.runIf(hasFfmpeg || process.env.CI)(
    "leaves a recording as it was when the owners turn marking off, and traces only its own workspace's marks",
    async () => {
      const { owner, engineer, fileId } = await studio();
      const marked = Buffer.from(
        await (await download(fileId, "original", engineer)).arrayBuffer(),
      );
      await app.request("/api/organisation/forensic", json({ audio: false }, owner, "PUT"));
      const choices = (await (await get(`/api/files/${fileId}/downloads`, engineer)).json()) as {
        marked: boolean;
      };
      expect(choices.marked).toBe(false);
      const plain = Buffer.from(await (await download(fileId, "original", engineer)).arrayBuffer());
      expect(plain.equals(recording)).toBe(true);

      // Another workspace's owner finds nothing of this workspace's marks.
      const [elsewhere] = await db
        .insert(schema.organisations)
        .values({ name: "Elsewhere", slug: "elsewhere-forensic" })
        .returning();
      await db.insert(schema.members).values({
        organisationId: elsewhere?.id ?? "",
        userId: await idOf(engineer),
        role: "owner",
      });
      const moved = await app.request(
        "/api/me/organisation",
        json({ organisationId: elsewhere?.id }, engineer, "PUT"),
      );
      expect(moved.status).toBe(200);
      const theirs = await trace(marked, engineer);
      expect(theirs.status).toBe(200);
      expect(((await theirs.json()) as TraceResult).match).toBeNull();
      // Back home, the owner names the engineer.
      const ours = (await (await trace(marked, owner)).json()) as TraceResult;
      expect(ours.match?.recipient).toBe("Tomas Varga <tomas@endlesshall.example>");

      // A recording that cannot be marked does not leave unmarked.
      await app.request("/api/organisation/forensic", json({ audio: true }, owner, "PUT"));
      const [file] = await db.select().from(schema.files).where(eq(schema.files.id, fileId));
      const broken = await storage.put(file?.organisationId ?? "", Buffer.from("not really audio"));
      const [fake] = await db
        .insert(schema.files)
        .values({
          organisationId: file?.organisationId ?? "",
          projectId: file?.projectId ?? "",
          name: "Broken.wav",
          kind: "audio",
          blobId: broken.id,
          contentType: "audio/wav",
          byteSize: broken.byteSize,
          mediaInfo: file?.mediaInfo ?? null,
        })
        .returning();
      expect((await download(fake?.id ?? "", "original", owner)).status).toBe(422);

      // What is not a recording is refused; nothing is refused silently.
      expect((await trace(Buffer.from("not really audio"), owner)).status).toBe(422);
      expect((await trace(Buffer.alloc(0), owner)).status).toBe(400);
    },
    120_000,
  );
});

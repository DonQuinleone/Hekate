import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, schema, withAuditPurge } from "@hekate/db";
import { defaultProjectRoles, type ListeningEvent, type ListeningRoom } from "@hekate/shared";
import { createBackends, storageConfigFromEnv } from "@hekate/storage";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { createAudit } from "./audit.ts";
import { createAuth } from "./auth.ts";
import { createKeyring } from "./keyring.ts";
import { createListeningHub, listenForRooms } from "./listening.ts";
import { memoryMailer } from "./mail.ts";
import { playbackSecret } from "./playback.ts";
import { createStorage } from "./storage.ts";

const url = process.env.DATABASE_URL;

describe.runIf(url)("listening rooms (#200)", () => {
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
  const storageRoot = mkdtempSync(join(tmpdir(), "hekate-listening-storage-"));
  const storage = createStorage(
    db,
    createBackends(storageConfigFromEnv({ STORAGE_LOCAL_PATH: storageRoot })),
    keyring,
  );
  const appOf = (hub = createListeningHub()) =>
    createApp({
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
      listening: hub,
    });
  const app = appOf();
  // A second replica: its own streams, told of the first's changes only through PostgreSQL.
  const replicaHub = createListeningHub();
  const replica = appOf(replicaHub);
  const listener = createDb(process.env.DATABASE_DIRECT_URL ?? url ?? "", { max: 1 });
  let unlisten: () => Promise<void> = async () => {};

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
  const get = (path: string, cookie: string, on = app) => on.request(path, { headers: { cookie } });
  const post = (path: string, body: unknown, cookie: string, on = app) =>
    on.request(path, json(body, cookie));
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
  /** Give someone a role in a project, as its owner. */
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
  const organisationOf = async (cookie: string) =>
    (
      (await (await get("/api/me", cookie)).json()) as {
        activeOrganisationId: string;
      }
    ).activeOrganisationId;
  const addFile = async (organisationId: string, projectId: string, name: string) => {
    const blob = await storage.put(organisationId, Buffer.from(name));
    const [file] = await db
      .insert(schema.files)
      .values({
        organisationId,
        projectId,
        name,
        kind: "audio",
        blobId: blob.id,
        contentType: "audio/wav",
        byteSize: blob.byteSize,
      })
      .returning();
    return file?.id ?? "";
  };

  /** A room's stream, read as a page reads it: one event at a time. */
  const listen = async (roomId: string, cookie: string, on = app) => {
    const res = await get(`/api/listening-rooms/${roomId}/events`, cookie, on);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    /** The next event of a kind, within `ms`; null when none came. */
    const next = async (kind = "room", ms = 3_000): Promise<{ data: string } | null> => {
      const deadline = Date.now() + ms;
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const chunk = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const lines = chunk.split("\n");
          const event = lines.find((l) => l.startsWith("event: "))?.slice(7);
          const data = lines
            .filter((l) => l.startsWith("data: "))
            .map((l) => l.slice(6))
            .join("\n");
          if (event === kind) return { data };
          continue;
        }
        const left = deadline - Date.now();
        if (left <= 0) return null;
        const read = await Promise.race([
          reader.read(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), left)),
        ]);
        if (!read) return null;
        if (read.done) return null;
        buffer += decoder.decode(read.value, { stream: true });
      }
    };
    const room = async (ms?: number) => {
      const got = await next("room", ms);
      return got ? (JSON.parse(got.data) as ListeningEvent) : null;
    };
    return { next, room, close: () => reader.cancel() };
  };

  /** A workspace with its leader, a listener with a role, and a project of two recordings. */
  const studio = async () => {
    const leader = await setup();
    const organisationId = await organisationOf(leader);
    const projectId = await project(leader);
    const listenerCookie = await joinAs(leader, "tomas@endlesshall.example", "Tomas Varga");
    await grantRole(leader, projectId, listenerCookie, "Viewer");
    const first = await addFile(organisationId, projectId, "Maple Leaf Rag - V2 dry.wav");
    const second = await addFile(organisationId, projectId, "Maple Leaf Rag - V2 wet.wav");
    const started = await post(
      `/api/projects/${projectId}/listening-rooms`,
      { fileId: first },
      leader,
    );
    expect(started.status).toBe(201);
    const { room } = (await started.json()) as { room: ListeningRoom };
    return { leader, listener: listenerCookie, organisationId, projectId, first, second, room };
  };

  beforeAll(async () => {
    await runMigrations(url ?? "");
    unlisten = await listenForRooms(listener.sql, replicaHub);
  });
  beforeEach(async () => {
    await withAuditPurge(db, (tx) =>
      tx.execute(sql`truncate ${schema.organisations}, ${schema.users} cascade`),
    );
    await db.execute(sql`truncate ${schema.requestLimits}`);
  });
  afterAll(async () => {
    await unlisten();
    await withAuditPurge(db, (tx) =>
      tx.execute(sql`truncate ${schema.organisations}, ${schema.users} cascade`),
    );
    await listener.close();
    await close();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it("starts a room on a file, led by whoever started it, and lists it in its project", async () => {
    const s = await studio();
    expect(s.room).toMatchObject({
      projectId: s.projectId,
      leader: { name: "Mira Solberg" },
      fileId: s.first,
      playing: false,
      position: 0,
      rate: 1,
      revision: 0,
      listeners: [],
    });
    const listed = (await (
      await get(`/api/projects/${s.projectId}/listening-rooms`, s.listener)
    ).json()) as { rooms: ListeningRoom[] };
    expect(listed.rooms.map((r) => r.id)).toEqual([s.room.id]);

    // Starting another ends the first: one room at a time.
    const again = await post(
      `/api/projects/${s.projectId}/listening-rooms`,
      { fileId: s.second },
      s.leader,
    );
    const { room } = (await again.json()) as { room: ListeningRoom };
    const after = (await (
      await get(`/api/projects/${s.projectId}/listening-rooms`, s.leader)
    ).json()) as { rooms: ListeningRoom[] };
    expect(after.rooms.map((r) => r.id)).toEqual([room.id]);
    expect((await get(`/api/listening-rooms/${s.room.id}/events`, s.listener)).status).toBe(410);
  });

  it("sends a listener where the leader is, and only that: never a media address", async () => {
    const s = await studio();
    const stream = await listen(s.room.id, s.listener);
    const first = await stream.room();
    expect(first?.room).toMatchObject({ fileId: s.first, playing: false, revision: 0 });
    expect(first?.room.listeners.map((l) => l.name)).toEqual(["Tomas Varga"]);

    const moved = await post(
      `/api/listening-rooms/${s.room.id}/state`,
      { fileId: s.second, playing: true, position: 12.5, rate: 0.75 },
      s.leader,
    );
    expect(moved.status).toBe(200);
    expect(await moved.json()).toEqual({ revision: 1 });
    const second = await stream.room(1_500);
    expect(second?.room).toMatchObject({
      fileId: s.second,
      playing: true,
      position: 12.5,
      rate: 0.75,
      revision: 1,
    });
    // Where the leader is, and who is there: no playback token, key, segment or address.
    expect(Object.keys(second?.room ?? {}).sort()).toEqual(
      [
        "at",
        "fileId",
        "id",
        "leader",
        "listeners",
        "playing",
        "position",
        "projectId",
        "rate",
        "revision",
      ].sort(),
    );
    expect(JSON.stringify(second)).not.toMatch(/https?:|m3u8|token|key/i);
    expect(Date.parse(second?.now ?? "")).toBeGreaterThan(0);
    await stream.close();
  });

  it("lets only the leader move the room or end it", async () => {
    const s = await studio();
    const state = { fileId: s.second, playing: true, position: 3 };
    const refused = await post(`/api/listening-rooms/${s.room.id}/state`, state, s.listener);
    expect(refused.status).toBe(403);
    expect((await post(`/api/listening-rooms/${s.room.id}/end`, {}, s.listener)).status).toBe(403);
    const [row] = await db
      .select()
      .from(schema.listeningRooms)
      .where(eq(schema.listeningRooms.id, s.room.id));
    expect(row).toMatchObject({ fileId: s.first, playing: false, revision: 0, endedAt: null });

    // A file elsewhere is no file of the room's.
    const elsewhere = await project(s.leader, "Opening titles");
    const outside = await addFile(s.organisationId, elsewhere, "Opening titles - cut 3.wav");
    expect(
      (
        await post(
          `/api/listening-rooms/${s.room.id}/state`,
          { ...state, fileId: outside },
          s.leader,
        )
      ).status,
    ).toBe(400);
    expect(
      (await post(`/api/listening-rooms/${s.room.id}/state`, { ...state, position: -2 }, s.leader))
        .status,
    ).toBe(400);
  });

  it("keeps out a member of another workspace, and a member who cannot see the project", async () => {
    const s = await studio();
    // Someone signed in to a workspace of their own.
    const outsider = await joinAs(s.leader, "alex@elsewhere.example", "Alex Rivera");
    const [theirs] = await db
      .insert(schema.organisations)
      .values({ name: "Elsewhere", slug: "elsewhere-listening" })
      .returning();
    await db
      .update(schema.members)
      .set({ organisationId: theirs?.id ?? "", role: "owner" })
      .where(eq(schema.members.userId, await idOf(outsider)));
    expect(await organisationOf(outsider)).toBe(theirs?.id);
    const theirProject = await project(outsider, "Theirs");
    const theirFile = await addFile(theirs?.id ?? "", theirProject, "Theirs.wav");

    const room = `/api/listening-rooms/${s.room.id}`;
    expect((await get(room, outsider)).status).toBe(404);
    expect((await get(`${room}/events`, outsider)).status).toBe(404);
    const state = { fileId: theirFile, playing: true, position: 1 };
    expect((await post(`${room}/state`, state, outsider)).status).toBe(404);
    expect((await post(`${room}/end`, {}, outsider)).status).toBe(404);
    expect((await post(`${room}/leave`, {}, outsider)).status).toBe(404);
    expect((await get(`/api/projects/${s.projectId}/listening-rooms`, outsider)).status).toBe(404);
    expect(
      (await post(`/api/projects/${s.projectId}/listening-rooms`, { fileId: s.first }, outsider))
        .status,
    ).toBe(404);
    // Nor may a room in their own workspace be started on this one's file.
    expect(
      (await post(`/api/projects/${theirProject}/listening-rooms`, { fileId: s.first }, outsider))
        .status,
    ).toBe(404);
    // Nor the leader put another workspace's file in their room.
    expect((await post(`${room}/state`, state, s.leader)).status).toBe(404);

    // A member of this workspace with no place in the project does not find the room either.
    const stranger = await joinAs(s.leader, "ines@endlesshall.example", "Ines Arlow");
    expect((await get(room, stranger)).status).toBe(404);
    expect((await get(`${room}/events`, stranger)).status).toBe(404);
    expect((await get(`/api/projects/${s.projectId}/listening-rooms`, stranger)).status).toBe(404);

    // And no API token reaches a room, whatever it holds.
    const token = await post(
      "/api/me/tokens",
      { name: "Release pipeline", scopes: ["files:read", "files:write"], expiresInDays: 30 },
      s.leader,
    );
    const { secret } = (await token.json()) as { secret: string };
    const withToken = await app.request(`/api/projects/${s.projectId}/listening-rooms`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(withToken.status).toBe(403);
  });

  it("lets a listener go when they are taken off the project", async () => {
    const s = await studio();
    const stream = await listen(s.room.id, s.listener);
    expect(await stream.room()).not.toBeNull();
    await db
      .delete(schema.projectMembers)
      .where(eq(schema.projectMembers.userId, await idOf(s.listener)));
    expect((await get(`/api/listening-rooms/${s.room.id}`, s.listener)).status).toBe(404);
    await stream.close();
  });

  it("tells a listener on another replica at once, through PostgreSQL", async () => {
    const s = await studio();
    const stream = await listen(s.room.id, s.listener, replica);
    expect((await stream.room())?.room.revision).toBe(0);
    expect(replicaHub.size()).toBe(1);
    // Moved on the first replica, heard on the second well before its own reread.
    const started = Date.now();
    await post(
      `/api/listening-rooms/${s.room.id}/state`,
      { fileId: s.first, playing: true, position: 40 },
      s.leader,
    );
    const heard = await stream.room(2_000);
    expect(heard?.room).toMatchObject({ playing: true, position: 40, revision: 1 });
    expect(Date.now() - started).toBeLessThan(2_000);
    await stream.close();
  });

  it("shows who is listening, and lets them leave", async () => {
    const s = await studio();
    const leading = await listen(s.room.id, s.leader);
    expect((await leading.room())?.room.listeners).toEqual([]);
    const listening = await listen(s.room.id, s.listener);
    await listening.room();
    const joined = await leading.room(2_000);
    // Their page says it is there as it connects; the leader's stream rereads soon after.
    expect(joined?.room.listeners.map((l) => l.name) ?? ["late"]).toContain("Tomas Varga");
    expect((await post(`/api/listening-rooms/${s.room.id}/leave`, {}, s.listener)).status).toBe(
      204,
    );
    await listening.close();
    expect((await leading.room(2_000))?.room.listeners).toEqual([]);
    await leading.close();
  });

  it("ends for everyone when the leader ends it, or has gone", async () => {
    const s = await studio();
    const stream = await listen(s.room.id, s.listener);
    await stream.room();
    expect((await post(`/api/listening-rooms/${s.room.id}/end`, {}, s.leader)).status).toBe(204);
    expect(await stream.next("ended", 1_500)).not.toBeNull();
    expect((await get(`/api/listening-rooms/${s.room.id}/events`, s.listener)).status).toBe(410);
    expect(
      (
        await post(
          `/api/listening-rooms/${s.room.id}/state`,
          { fileId: s.first, playing: true, position: 1 },
          s.leader,
        )
      ).status,
    ).toBe(410);

    // A leader not heard from for a while has gone, and their room with them.
    const other = await post(
      `/api/projects/${s.projectId}/listening-rooms`,
      { fileId: s.first },
      s.leader,
    );
    const { room } = (await other.json()) as { room: ListeningRoom };
    await db
      .update(schema.listeningRoomPeople)
      .set({ seenAt: sql`now() - interval '10 minutes'` })
      .where(eq(schema.listeningRoomPeople.roomId, room.id));
    const read = (await (await get(`/api/listening-rooms/${room.id}`, s.listener)).json()) as {
      open: boolean;
    };
    expect(read.open).toBe(false);
    const listed = (await (
      await get(`/api/projects/${s.projectId}/listening-rooms`, s.listener)
    ).json()) as { rooms: ListeningRoom[] };
    expect(listed.rooms).toEqual([]);
  });
});

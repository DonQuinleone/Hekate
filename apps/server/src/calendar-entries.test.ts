import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, schema, withAuditPurge } from "@hekate/db";
import { defaultProjectRoles } from "@hekate/shared";
import { createBackends, storageConfigFromEnv } from "@hekate/storage";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { createAudit } from "./audit.ts";
import { createAuth } from "./auth.ts";
import { createKeyring } from "./keyring.ts";
import { memoryMailer } from "./mail.ts";
import { playbackSecret } from "./playback.ts";
import { createStorage } from "./storage.ts";

const url = process.env.DATABASE_URL;

/**
 * The calendar's entries and the tracks' deadlines (#505, decision 283): a deadline set on a
 * track reaches the calendar and its board card; entries are kept for whoever edits the
 * schedule, a session entry booking a recording session; another workspace finds none of it
 * and a lesser role is refused.
 */
describe.runIf(url)("calendar entries and deadlines", () => {
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
  const storageRoot = mkdtempSync(join(tmpdir(), "hekate-calendar-entries-"));
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
  });

  const json = (body: unknown, cookie?: string) => ({
    method: "POST",
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
  const getAs = (path: string, cookie: string) => app.request(path, { headers: { cookie } });
  const idOf = async (cookie: string) =>
    ((await (await getAs("/api/me", cookie)).json()) as { user: { id: string } }).user.id;

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
  const joinAs = async (owner: string, email: string) => {
    const invited = await app.request(
      "/api/organisation/invitations",
      json({ email, role: "member" }, owner),
    );
    const { link } = (await invited.json()) as { link: string };
    const res = await app.request(
      `/api/invitations/${link.split("/invite/")[1]}/accept`,
      json({ name: email.split("@")[0], password: "correct horse battery" }),
    );
    expect(res.status).toBe(201);
    return cookieOf(res);
  };
  const grantRole = async (owner: string, projectId: string, holder: string, name: string) => {
    const listed = (await (await getAs(`/api/projects/${projectId}/roles`, owner)).json()) as {
      roles: { id: string; name: string }[];
    };
    let role = listed.roles.find((r) => r.name === name);
    if (!role) {
      const permissions = defaultProjectRoles.find((r) => r.name === name)?.permissions ?? [];
      const made = await app.request(
        `/api/projects/${projectId}/roles`,
        json({ name, permissions }, owner),
      );
      role = ((await made.json()) as { role: { id: string; name: string } }).role;
    }
    const res = await app.request(`/api/projects/${projectId}/members/${await idOf(holder)}`, {
      ...json({ roleId: role.id }, owner),
      method: "PUT",
    });
    expect(res.status).toBe(204);
  };

  /** A project with a track of one version, a reviewer (the composer) and an engineer. */
  const studio = async () => {
    const owner = await setup();
    const organisationId = (
      (await (await getAs("/api/me", owner)).json()) as { activeOrganisationId: string }
    ).activeOrganisationId;
    const made = await app.request(
      "/api/projects",
      json({ name: "Rags", profile: "music" }, owner),
    );
    const projectId = ((await made.json()) as { project: { id: string } }).project.id;
    const blob = await storage.put(organisationId, Buffer.from("Mix v1.wav"));
    const [file] = await db
      .insert(schema.files)
      .values({
        organisationId,
        projectId,
        name: "Mix v1.wav",
        kind: "audio",
        blobId: blob.id,
        contentType: "audio/wav",
        byteSize: blob.byteSize,
        mediaInfo: { duration: 60, audio: { codec: "pcm_s24le", channels: 2, sampleRate: 48000 } },
      })
      .returning();
    const track = await app.request(
      `/api/projects/${projectId}/tracks`,
      json({ name: "Maple Leaf Rag" }, owner),
    );
    const trackId = ((await track.json()) as { track: { id: string } }).track.id;
    await app.request(
      `/api/tracks/${trackId}/versions`,
      json({ variants: [{ fileId: file?.id ?? "", name: "Mix" }] }, owner),
    );
    const composer = await joinAs(owner, "composer@example.test");
    const engineer = await joinAs(owner, "engineer@example.test");
    await grantRole(owner, projectId, composer, "Reviewer");
    await grantRole(owner, projectId, engineer, "Engineer");
    return {
      owner,
      organisationId,
      projectId,
      trackId,
      composer,
      engineer,
      ids: { composer: await idOf(composer) },
    };
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
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it("sets deadlines on tracks and keeps entries on the calendar, for those who edit the schedule (#505)", async () => {
    const s = await studio();
    type Event = {
      id: string;
      kind: string;
      date: string;
      end?: string;
      title: string;
      link: string;
      overdue: boolean;
      entry?: { id: string; attendees: { id: string }[]; sessionId: string | null };
    };
    const events = async (cookie: string, query = "month=2026-10") =>
      (
        (await (await getAs(`/api/projects/${s.projectId}/calendar?${query}`, cookie)).json()) as {
          events: Event[];
        }
      ).events;
    // A deadline on the track: on the calendar, on its card, and late once past.
    const patch = (body: unknown, cookie = s.owner) =>
      app.request(`/api/tracks/${s.trackId}`, { ...json(body, cookie), method: "PATCH" });
    const set = await patch({ dueAt: "2026-10-21T17:00:00.000Z" });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { track: { dueAt: string } }).track.dueAt).toBe(
      "2026-10-21T17:00:00.000Z",
    );
    expect((await events(s.composer)).find((e) => e.kind === "track")).toMatchObject({
      date: "2026-10-21",
      title: "Maple Leaf Rag due",
      link: `/tracks/${s.trackId}?view=versions`,
    });
    const board = async () =>
      (
        (await (await getAs(`/api/projects/${s.projectId}/board`, s.owner)).json()) as {
          cards: { id: string; due: string | null }[];
        }
      ).cards.find((k) => k.id === s.trackId);
    expect((await board())?.due).toBe("2026-10-21T17:00:00.000Z");
    await patch({ dueAt: "2020-01-01T17:00:00.000Z" });
    expect((await events(s.owner, "from=2020-01-01&to=2020-01-02"))[0]?.overdue).toBe(true);
    // A lesser role may not set one; cleared, it is gone from the card.
    expect((await patch({ dueAt: null }, s.composer)).status).toBe(403);
    await patch({ dueAt: null });
    expect((await board())?.due).toBeNull();

    // An entry over three days, about the track, with an attendee.
    const add = (body: unknown, cookie = s.owner) =>
      app.request(`/api/projects/${s.projectId}/calendar/entries`, json(body, cookie));
    const made = await add({
      kind: "meeting",
      title: "Listening meeting with the label",
      startsOn: "2026-10-30",
      endsOn: "2026-11-01",
      trackId: s.trackId,
      attendees: [s.ids.composer, "nobody"],
    });
    expect(made.status).toBe(201);
    const { entry } = (await made.json()) as {
      entry: { id: string; endsOn: string; attendees: { id: string }[] };
    };
    expect(entry).toMatchObject({
      kind: "meeting",
      startsOn: "2026-10-30",
      endsOn: "2026-11-01",
      trackId: s.trackId,
      sessionId: null,
      attendees: [{ id: s.ids.composer }],
    });
    const listed = (await events(s.composer)).find((e) => e.kind === "entry");
    expect(listed).toMatchObject({
      id: `entry-${entry.id}`,
      date: "2026-10-30",
      end: "2026-11-01",
      title: "Listening meeting with the label",
    });
    expect(listed?.entry?.attendees).toMatchObject([{ id: s.ids.composer }]);
    // Asked for by days, it is there when any of its days is within them.
    expect((await events(s.owner, "from=2026-11-01&to=2026-11-03")).map((e) => e.kind)).toEqual([
      "entry",
    ]);
    expect(await events(s.owner, "from=2026-11-02&to=2026-11-03")).toEqual([]);
    expect(
      (await getAs(`/api/projects/${s.projectId}/calendar?from=2026-11-02`, s.owner)).status,
    ).toBe(400);
    // What it is about must be the project's own.
    const other = await app.request(
      "/api/projects",
      json({ name: "Elsewhere", profile: "music" }, s.owner),
    );
    const otherId = ((await other.json()) as { project: { id: string } }).project.id;
    const theirs = await app.request(
      `/api/projects/${otherId}/tracks`,
      json({ name: "Not here" }, s.owner),
    );
    const theirTrack = ((await theirs.json()) as { track: { id: string } }).track.id;
    expect(
      (await add({ kind: "other", title: "Across", startsOn: "2026-10-30", trackId: theirTrack }))
        .status,
    ).toBe(422);
    expect(
      (await add({ kind: "other", title: "Back", startsOn: "2026-10-30", endsOn: "2026-10-29" }))
        .status,
    ).toBe(400);

    // Moved and resized, as the timeline does it; a lesser role is refused.
    const change = (id: string, body: unknown, cookie = s.owner) =>
      app.request(`/api/calendar-entries/${id}`, { ...json(body, cookie), method: "PATCH" });
    const moved = await change(entry.id, { startsOn: "2026-11-02", endsOn: "2026-11-04" });
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as { entry: { endsOn: string } }).entry.endsOn).toBe("2026-11-04");
    const shorter = await change(entry.id, { endsOn: "2026-11-02" });
    expect(((await shorter.json()) as { entry: { endsOn: null } }).entry.endsOn).toBeNull();
    expect((await change(entry.id, { title: "Mine" }, s.engineer)).status).toBe(403);
    expect((await change(entry.id, { title: "Mine" }, s.composer)).status).toBe(403);
    expect(
      (await add({ kind: "other", title: "Theirs", startsOn: "2026-10-30" }, s.engineer)).status,
    ).toBe(403);

    // A session entry books a recording session, named and dated as it is, on the track;
    // the calendar lists it once, as the entry.
    const booked = await add({
      kind: "session",
      title: "Day 4",
      startsOn: "2026-10-27",
      trackId: s.trackId,
    });
    expect(booked.status).toBe(201);
    const session = ((await booked.json()) as { entry: { id: string; sessionId: string } }).entry;
    expect(session.sessionId).toBeTruthy();
    type Sessions = { sessions: { id: string; name: string; recordedOn: string }[] };
    const sessionsOf = async () =>
      ((await (await getAs(`/api/projects/${s.projectId}/sessions`, s.owner)).json()) as Sessions)
        .sessions;
    expect((await sessionsOf()).find((x) => x.id === session.sessionId)).toMatchObject({
      name: "Day 4",
      recordedOn: "2026-10-27",
    });
    const october = await events(s.owner);
    expect(october.filter((e) => e.kind === "session")).toEqual([]);
    expect(october.find((e) => e.id === `entry-${session.id}`)).toMatchObject({
      date: "2026-10-27",
      link: `/sessions/${session.sessionId}`,
    });
    await change(session.id, { startsOn: "2026-10-28", title: "Day 4, moved" });
    expect((await sessionsOf()).find((x) => x.id === session.sessionId)).toMatchObject({
      name: "Day 4, moved",
      recordedOn: "2026-10-28",
    });
    // Someone who edits the schedule but not sessions may not book one.
    const planner = await joinAs(s.owner, "planner@example.test");
    const role = await app.request(
      `/api/projects/${s.projectId}/roles`,
      json(
        {
          name: "Planner",
          levels: {
            files: "view",
            comments: "read",
            reviews: "none",
            downloads: "none",
            takes: "none",
            production: "edit",
            workflow: "none",
            people: "none",
            project: "none",
          },
        },
        s.owner,
      ),
    );
    const roleId = ((await role.json()) as { role: { id: string } }).role.id;
    await app.request(`/api/projects/${s.projectId}/members/${await idOf(planner)}`, {
      ...json({ roleId }, s.owner),
      method: "PUT",
    });
    expect(
      (await add({ kind: "session", title: "Day 5", startsOn: "2026-10-29" }, planner)).status,
    ).toBe(403);
    expect(
      (await add({ kind: "delivery", title: "Masters", startsOn: "2026-10-29" }, planner)).status,
    ).toBe(201);
    expect((await change(entry.id, { kind: "session" }, planner)).status).toBe(403);

    // The feed carries the entries' days.
    const feed = (await (
      await app.request(`/api/projects/${s.projectId}/calendar/feed`, json({}, s.owner))
    ).json()) as { url: string };
    const ics = await (await app.request(new URL(feed.url).pathname)).text();
    expect(ics).toContain("SUMMARY:Masters");
    expect(ics).toContain(
      "DTSTART;VALUE=DATE:20261102\r\nDTEND;VALUE=DATE:20261103\r\nSUMMARY:Listening meeting",
    );

    // Another workspace's owner finds none of it; its own entries never show here.
    const outsider = await joinAs(s.owner, "outsider-entries@example.test");
    const [elsewhere] = await db
      .insert(schema.organisations)
      .values({ name: "Saltmarsh Films", slug: "saltmarsh-entries" })
      .returning({ id: schema.organisations.id });
    await db.insert(schema.members).values({
      organisationId: elsewhere?.id ?? "",
      userId: await idOf(outsider),
      role: "owner",
    });
    await app.request("/api/me/organisation", {
      ...json({ organisationId: elsewhere?.id }, outsider),
      method: "PUT",
    });
    expect((await change(entry.id, { title: "Ours now" }, outsider)).status).toBe(404);
    expect(
      (
        await app.request(`/api/calendar-entries/${entry.id}`, {
          ...json({}, outsider),
          method: "DELETE",
        })
      ).status,
    ).toBe(404);
    expect(
      (await add({ kind: "other", title: "Theirs", startsOn: "2026-10-30" }, outsider)).status,
    ).toBe(404);
    const theirProject = await app.request(
      "/api/projects",
      json({ name: "Tide", profile: "video" }, outsider),
    );
    const tideId = ((await theirProject.json()) as { project: { id: string } }).project.id;
    expect(
      (
        await app.request(
          `/api/projects/${tideId}/calendar/entries`,
          json({ kind: "other", title: "Tide call", startsOn: "2026-10-30" }, outsider),
        )
      ).status,
    ).toBe(201);
    expect((await events(s.owner)).some((e) => e.title === "Tide call")).toBe(false);

    // Removed, the entry is gone; the session it booked stays, listed as a session again.
    expect(
      (
        await app.request(`/api/calendar-entries/${session.id}`, {
          ...json({}, s.engineer),
          method: "DELETE",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(`/api/calendar-entries/${session.id}`, {
          ...json({}, s.owner),
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    expect((await sessionsOf()).some((x) => x.id === session.sessionId)).toBe(true);
    expect((await events(s.owner)).find((e) => e.kind === "session")).toMatchObject({
      date: "2026-10-28",
      title: "Day 4, moved",
    });
  }, 30_000);
});

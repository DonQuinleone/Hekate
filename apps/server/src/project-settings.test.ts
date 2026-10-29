import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, inOrg, runMigrations, schema, withAuditPurge } from "@hekate/db";
import {
  type AssetPolicy,
  defaultAssetPolicy,
  defaultProjectRoles,
  defaultReviewerPermissions,
  type ToolException,
} from "@hekate/shared";
import { createBackends, storageConfigFromEnv } from "@hekate/storage";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { createAudit } from "./audit.ts";
import { createAuth } from "./auth.ts";
import { issueGuestLink } from "./guests.ts";
import { createKeyring } from "./keyring.ts";
import { memoryMailer } from "./mail.ts";
import { playbackSecret } from "./playback.ts";
import { createStorage } from "./storage.ts";

const url = process.env.DATABASE_URL;

/**
 * A project's downloads and deletion (decision 257), its exceptions to the player tools
 * (decision 258) and who its workflows tell (decision 259): each enforced on the server, for
 * the people who may change it and nobody else.
 */
describe.runIf(url)("project settings: downloads, deletion, tool exceptions, notices", () => {
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
  const storageRoot = mkdtempSync(join(tmpdir(), "hekate-project-settings-"));
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
  const patch = (path: string, body: unknown, cookie: string) =>
    app.request(path, json(body, cookie, "PATCH"));
  const remove = (path: string, cookie: string) =>
    app.request(path, { method: "DELETE", headers: { cookie, origin: "http://localhost:3000" } });
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

  /** A workspace's owner, a project with a recording, and a producer, engineer and reviewer on it. */
  const studio = async () => {
    const owner = await setup();
    const organisationId = (
      (await (await get("/api/me", owner)).json()) as { activeOrganisationId: string }
    ).activeOrganisationId;
    const made = await post("/api/projects", { name: "Joplin Rags", profile: "music" }, owner);
    const projectId = ((await made.json()) as { project: { id: string } }).project.id;
    const producer = await joinAs(owner, "tomas@endlesshall.example", "Tomas Varga");
    const engineer = await joinAs(owner, "ines@endlesshall.example", "Ines Arlow");
    const reviewer = await joinAs(owner, "alex@endlesshall.example", "Alex Rivera");
    await grantRole(owner, projectId, producer, "Producer");
    await grantRole(owner, projectId, engineer, "Engineer");
    await grantRole(owner, projectId, reviewer, "Reviewer");
    const file = async (name: string) => {
      const blob = await storage.put(organisationId, Buffer.from(name));
      const [row] = await db
        .insert(schema.files)
        .values({
          organisationId,
          projectId,
          name,
          kind: "audio",
          blobId: blob.id,
          contentType: "audio/wav",
          byteSize: blob.byteSize,
          mediaInfo: {
            duration: 60,
            audio: { codec: "pcm_s24le", channels: 2, sampleRate: 48000 },
          } as never,
        })
        .returning();
      return row?.id ?? "";
    };
    return {
      owner,
      producer,
      engineer,
      reviewer,
      organisationId,
      projectId,
      file,
      fileId: await file("Maple Leaf Rag - V2 dry.wav"),
    };
  };
  /** A project in another workspace, which nobody here can reach. */
  const foreignProject = async () => {
    const [other] = await db
      .insert(schema.organisations)
      .values({ name: "Saltmarsh Films", slug: "saltmarsh" })
      .returning();
    const [project] = await db
      .insert(schema.projects)
      .values({ organisationId: other?.id ?? "", name: "Opening titles", profile: "video" })
      .returning();
    return project?.id ?? "";
  };
  const levelOf = async (fileId: string, cookie: string) =>
    ((await (await get(`/api/files/${fileId}/downloads`, cookie)).json()) as { level: string })
      .level;
  const projectOf = async (projectId: string, cookie: string) =>
    (
      (await (await get(`/api/projects/${projectId}`, cookie)).json()) as {
        project: {
          assetPolicy: AssetPolicy;
          workspaceMarks?: boolean;
          permissions: string[];
          tools: string[];
          workflowNotices: unknown;
        };
      }
    ).project;
  const setPolicy = (projectId: string, change: Partial<AssetPolicy>, cookie: string) =>
    patch(
      `/api/projects/${projectId}`,
      { assetPolicy: { ...defaultAssetPolicy, ...change } },
      cookie,
    );

  /** A guest asked to a feedback review of the file, with the tools and download given. */
  const guestOn = async (
    s: Awaited<ReturnType<typeof studio>>,
    grant: { tools: string[]; download: "none" | "proxy" | "original" },
  ) => {
    const [guest] = await db
      .insert(schema.guests)
      .values({
        organisationId: s.organisationId,
        name: "Alex Rivera",
        email: "alex.rivera@guest.example",
      })
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
      permissions: { ...defaultReviewerPermissions, ...grant } as never,
    });
    const opened = await app.request(
      "/api/guest/sessions",
      json({
        token: (await issueGuestLink(db, s.organisationId, guest?.id ?? "")).token,
      }),
    );
    expect(opened.status).toBe(201);
    return { guestId: guest?.id ?? "", reviewId: review?.id ?? "", cookie: cookieOf(opened) };
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
  }, 60_000);

  it("narrows downloads to what the project allows, for its editors to choose (decision 257)", async () => {
    const s = await studio();
    expect((await projectOf(s.projectId, s.producer)).assetPolicy).toEqual(defaultAssetPolicy);
    // Only those who edit the project choose; another workspace's project is not found.
    for (const cookie of [s.engineer, s.reviewer])
      expect((await setPolicy(s.projectId, { downloads: "nobody" }, cookie)).status).toBe(403);
    const foreign = await foreignProject();
    expect((await setPolicy(foreign, { downloads: "nobody" }, s.owner)).status).toBe(404);

    expect(await levelOf(s.fileId, s.engineer)).toBe("original");
    // Never an original: the proxy for everyone, the owner too.
    expect((await setPolicy(s.projectId, { originals: "never" }, s.producer)).status).toBe(200);
    expect(await levelOf(s.fileId, s.engineer)).toBe("proxy");
    expect(await levelOf(s.fileId, s.owner)).toBe("proxy");
    expect(
      (await post(`/api/files/${s.fileId}/downloads`, { kind: "original" }, s.engineer)).status,
    ).toBe(403);
    // Originals for the workspace's owners and admins alone.
    await setPolicy(s.projectId, { originals: "owners" }, s.producer);
    expect(await levelOf(s.fileId, s.engineer)).toBe("proxy");
    expect(await levelOf(s.fileId, s.owner)).toBe("original");
    // Nobody downloads, whatever their role.
    await setPolicy(s.projectId, { downloads: "nobody" }, s.producer);
    expect(await levelOf(s.fileId, s.engineer)).toBe("none");
    expect(await levelOf(s.fileId, s.owner)).toBe("none");
    expect((await projectOf(s.projectId, s.engineer)).permissions).not.toContain("download_proxy");
    expect(
      (await post(`/api/files/${s.fileId}/downloads`, { kind: "proxy" }, s.engineer)).status,
    ).toBe(403);
    // A guest's review gives them no more than the project allows.
    await setPolicy(s.projectId, { originals: "never" }, s.producer);
    const guest = await guestOn(s, { tools: [], download: "original" });
    expect(await levelOf(s.fileId, guest.cookie)).toBe("proxy");
    await setPolicy(s.projectId, { downloads: "nobody" }, s.producer);
    expect(await levelOf(s.fileId, guest.cookie)).toBe("none");

    // Each change is in the access log, with what changed.
    const logged = await db
      .select({ details: schema.accessEvents.details, projectId: schema.accessEvents.projectId })
      .from(schema.accessEvents)
      .where(
        and(
          inOrg(schema.accessEvents, s.organisationId),
          eq(schema.accessEvents.action, "project.asset_security"),
        ),
      )
      // Ids are UUIDv7: in the order they were made.
      .orderBy(schema.accessEvents.id);
    expect(logged.map((l) => l.details)).toEqual([
      { change: { originals: "never" } },
      { change: { originals: "owners" } },
      { change: { downloads: "nobody", originals: "roles" } },
      { change: { downloads: "roles", originals: "never" } },
      { change: { downloads: "nobody", originals: "roles" } },
    ]);
    expect(logged.every((l) => l.projectId === s.projectId)).toBe(true);
  }, 60_000);

  it("leaves deleting to the workspace's owners where the project says so, and lets a reviewed file go only when it allows", async () => {
    const s = await studio();
    const loose = await s.file("Rag sketch.wav");
    await setPolicy(s.projectId, { deletion: "owners" }, s.producer);
    expect((await projectOf(s.projectId, s.producer)).permissions).not.toContain("delete_files");
    expect((await remove(`/api/files/${loose}`, s.producer)).status).toBe(403);
    expect((await remove(`/api/files/${loose}`, s.owner)).status).toBe(204);
    await setPolicy(s.projectId, { deletion: "roles" }, s.producer);

    // A file in a review stays (decision 027), open or closed, until the project lets it go.
    const [review] = await db
      .insert(schema.reviews)
      .values({
        organisationId: s.organisationId,
        projectId: s.projectId,
        kind: "feedback",
        title: "First listen",
        status: "completed",
      })
      .returning();
    await db.insert(schema.reviewItems).values({
      organisationId: s.organisationId,
      reviewId: review?.id ?? "",
      fileId: s.fileId,
    });
    expect((await remove(`/api/files/${s.fileId}`, s.producer)).status).toBe(409);
    expect((await setPolicy(s.projectId, { keepReviewed: false }, s.engineer)).status).toBe(403);
    await setPolicy(s.projectId, { keepReviewed: false }, s.producer);
    expect((await remove(`/api/files/${s.fileId}`, s.producer)).status).toBe(204);
    const [deleted] = await db
      .select({ details: schema.accessEvents.details })
      .from(schema.accessEvents)
      .where(
        and(
          inOrg(schema.accessEvents, s.organisationId),
          eq(schema.accessEvents.action, "file.delete"),
          sql`${schema.accessEvents.details}->>'fileId' = ${s.fileId}`,
        ),
      );
    expect(deleted?.details).toMatchObject({ fileId: s.fileId, reviews: [review?.id] });
  }, 60_000);

  it("lets only the workspace's owners stop marking a project's downloads", async () => {
    const s = await studio();
    expect((await projectOf(s.projectId, s.producer)).workspaceMarks).toBe(false);
    expect((await projectOf(s.projectId, s.engineer)).workspaceMarks).toBeUndefined();
    const on = await app.request(
      "/api/organisation/forensic",
      json({ audio: true }, s.owner, "PUT"),
    );
    expect(on.status).toBe(200);
    expect((await projectOf(s.projectId, s.producer)).workspaceMarks).toBe(true);
    const marked = async () =>
      (
        (await (await get(`/api/files/${s.fileId}/downloads`, s.engineer)).json()) as {
          marked: boolean;
        }
      ).marked;
    expect(await marked()).toBe(true);

    expect((await setPolicy(s.projectId, { forensicDownloads: false }, s.producer)).status).toBe(
      403,
    );
    expect((await setPolicy(s.projectId, { forensicDownloads: false }, s.owner)).status).toBe(200);
    expect(await marked()).toBe(false);
    // Anyone who edits the project may bring it back.
    expect((await setPolicy(s.projectId, { forensicDownloads: true }, s.producer)).status).toBe(
      200,
    );
    expect(await marked()).toBe(true);

    // A project started from one that stopped it is marked, unless an owner starts it.
    await setPolicy(s.projectId, { forensicDownloads: false }, s.owner);
    const copy = async (cookie: string) => {
      const made = await post(
        "/api/projects",
        { name: "Joplin Rags again", profile: "music", templateId: s.projectId },
        cookie,
      );
      expect(made.status).toBe(201);
      const id = ((await made.json()) as { project: { id: string } }).project.id;
      return (await projectOf(id, cookie)).assetPolicy.forensicDownloads;
    };
    expect(await copy(s.producer)).toBe(true);
    expect(await copy(s.owner)).toBe(false);
  }, 60_000);

  it("gives a person or a group other player tools in one project, enforced on the server (decision 258)", async () => {
    const s = await studio();
    const base = `/api/projects/${s.projectId}/tool-exceptions`;
    const qa = (cookie: string) => get(`/api/files/${s.fileId}/qa`, cookie);
    const engineerId = await idOf(s.engineer);
    expect((await qa(s.engineer)).status).not.toBe(403);
    expect((await qa(s.reviewer)).status).toBe(403);

    // The project's people say their role in the workspace, so the dialog leaves out the owners
    // and admins, whom an exception would not change.
    const people = (
      (await (await get(`/api/projects/${s.projectId}/members`, s.owner)).json()) as {
        members: { userId: string; workspaceRole: string | null }[];
      }
    ).members;
    expect(people.find((m) => m.userId === engineerId)?.workspaceRole).toBe("member");
    const ownerId = await idOf(s.owner);
    for (const m of people.filter((p) => p.userId === ownerId))
      expect(m.workspaceRole).toBe("owner");

    // Those who manage roles make them; others and another workspace are refused.
    for (const cookie of [s.engineer, s.reviewer])
      expect((await post(base, { userId: engineerId, tools: ["score"] }, cookie)).status).toBe(403);
    const foreign = await foreignProject();
    expect((await get(`/api/projects/${foreign}/tool-exceptions`, s.owner)).status).toBe(404);
    expect(
      (
        await post(
          `/api/projects/${foreign}/tool-exceptions`,
          { userId: engineerId, tools: [] },
          s.owner,
        )
      ).status,
    ).toBe(404);
    // Only someone in the project, one of its groups, or a guest it has asked.
    const outsider = await joinAs(s.owner, "outside@endlesshall.example", "Outside");
    expect((await post(base, { userId: await idOf(outsider), tools: [] }, s.owner)).status).toBe(
      404,
    );
    expect((await post(base, { tools: [] }, s.owner)).status).toBe(400);

    const made = await post(base, { userId: engineerId, tools: ["score"] }, s.producer);
    expect(made.status).toBe(201);
    const exception = ((await made.json()) as { exception: ToolException }).exception;
    expect(exception).toMatchObject({ kind: "member", name: "Ines Arlow", tools: ["score"] });
    expect((await post(base, { userId: engineerId, tools: [] }, s.producer)).status).toBe(409);
    expect((await projectOf(s.projectId, s.engineer)).tools).toEqual(["score"]);
    expect((await qa(s.engineer)).status).toBe(403);
    // Changed, it applies at once; another workspace's or a lesser role's change is refused.
    expect(
      (await patch(`${base}/${exception.id}`, { tools: ["qa", "score"] }, s.engineer)).status,
    ).toBe(403);
    expect(
      (await patch(`${base}/${exception.id}`, { tools: ["qa", "score"] }, s.producer)).status,
    ).toBe(200);
    expect((await qa(s.engineer)).status).not.toBe(403);

    // A group's exception replaces its members' role's tools; a person's own wins over it.
    const group = await post(
      `/api/projects/${s.projectId}/groups`,
      { name: "Soloists", members: [await idOf(s.reviewer), engineerId] },
      s.owner,
    );
    expect(group.status).toBe(201);
    const groupId = ((await group.json()) as { group: { id: string } }).group.id;
    expect((await post(base, { groupId, tools: ["qa"] }, s.producer)).status).toBe(201);
    expect((await projectOf(s.projectId, s.reviewer)).tools).toEqual(["qa"]);
    expect((await qa(s.reviewer)).status).not.toBe(403);
    expect((await projectOf(s.projectId, s.engineer)).tools).toEqual(["qa", "score"]);
    // Owners and admins keep every tool.
    expect((await projectOf(s.projectId, s.owner)).tools).toHaveLength(7);

    // A guest's exception only takes away what their review gives.
    const guest = await guestOn(s, { tools: ["qa", "meters"], download: "none" });
    expect((await qa(guest.cookie)).status).not.toBe(403);
    expect(
      (await post(base, { guestId: guest.guestId, tools: ["score"] }, s.producer)).status,
    ).toBe(201);
    expect((await qa(guest.cookie)).status).toBe(403);

    const listed = (await (await get(base, s.engineer)).json()) as { exceptions: ToolException[] };
    expect(listed.exceptions.map((e) => [e.kind, e.name])).toEqual([
      ["member", "Ines Arlow"],
      ["group", "Soloists"],
      ["guest", "Alex Rivera"],
    ]);
    expect((await remove(`${base}/${exception.id}`, s.reviewer)).status).toBe(403);
    expect((await remove(`${base}/${exception.id}`, s.producer)).status).toBe(204);
    // Back to the group's.
    expect((await projectOf(s.projectId, s.engineer)).tools).toEqual(["qa"]);
    expect((await remove(`${base}/${exception.id}`, s.producer)).status).toBe(404);
  }, 60_000);

  it("tells whom the project says, in the app and by mail as it allows (decision 259)", async () => {
    const s = await studio();
    expect((await projectOf(s.projectId, s.producer)).workflowNotices).toEqual({
      app: true,
      mail: true,
      everyoneOnStatus: false,
    });
    const notices = (change: object, cookie: string) =>
      patch(
        `/api/projects/${s.projectId}`,
        { workflowNotices: { app: true, mail: true, everyoneOnStatus: false, ...change } },
        cookie,
      );
    expect((await notices({ app: false }, s.engineer)).status).toBe(403);
    expect(
      (await notices({ app: false }, await joinAs(s.owner, "x@endlesshall.example", "X"))).status,
    ).toBe(404);

    // A new version gives the engineer a stage, and the track a status.
    const at = (id: string, type: string, name: string, x: number, config = {}) => ({
      id,
      type,
      name,
      x,
      y: 0,
      config,
    });
    const definition = {
      nodes: [
        at("start", "upload", "A version is uploaded", 0),
        at("edit", "task", "Engineer edits", 1, { who: "Engineer", status: "Editing" }),
        at("done", "finish", "Approved", 2, { status: "Approved" }),
      ],
      connectors: [
        { id: "1", from: "start", outcome: "happened", to: "edit" },
        { id: "2", from: "edit", outcome: "done", to: "done" },
      ],
    };
    const made = await post(
      `/api/projects/${s.projectId}/workflows`,
      { name: "Editing", definition },
      s.owner,
    );
    expect(made.status).toBe(201);
    const workflowId = ((await made.json()) as { workflow: { id: string } }).workflow.id;
    expect((await patch(`/api/workflows/${workflowId}`, { active: true }, s.owner)).status).toBe(
      200,
    );
    const versioned = async (name: string) => {
      const track = await post(`/api/projects/${s.projectId}/tracks`, { name }, s.owner);
      const trackId = ((await track.json()) as { track: { id: string } }).track.id;
      const fileId = await s.file(`${name}.wav`);
      const added = await post(
        `/api/tracks/${trackId}/versions`,
        { variants: [{ fileId, name: "Mix" }] },
        s.owner,
      );
      expect(added.status).toBe(201);
      return trackId;
    };
    const told = async (cookie: string, trackId: string) =>
      db
        .select({
          text: schema.notifications.text,
          inApp: schema.notifications.inApp,
          mailMode: schema.notifications.mailMode,
        })
        .from(schema.notifications)
        .where(
          and(
            eq(schema.notifications.userId, await idOf(cookie)),
            eq(schema.notifications.kind, "workflow"),
            eq(schema.notifications.trackId, trackId),
          ),
        );

    // By mail only, and everyone in the project hears of a new status.
    expect((await notices({ app: false, everyoneOnStatus: true }, s.producer)).status).toBe(200);
    const first = await versioned("Maple Leaf Rag");
    expect(await told(s.engineer, first)).toEqual(
      expect.arrayContaining([
        { text: "Engineer edits on Maple Leaf Rag is yours", inApp: false, mailMode: "instant" },
        { text: "Maple Leaf Rag is now Editing", inApp: false, mailMode: "instant" },
      ]),
    );
    expect(await told(s.reviewer, first)).toEqual([
      { text: "Maple Leaf Rag is now Editing", inApp: false, mailMode: "instant" },
    ]);

    // In the app only, and a status only to the track's followers.
    await notices({ mail: false }, s.producer);
    const second = await versioned("The Entertainer");
    expect(await told(s.engineer, second)).toEqual([
      { text: "Engineer edits on The Entertainer is yours", inApp: true, mailMode: null },
    ]);
    expect(await told(s.reviewer, second)).toEqual([]);
  }, 60_000);
});

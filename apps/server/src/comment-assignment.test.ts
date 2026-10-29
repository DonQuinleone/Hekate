import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, schema, withAuditPurge } from "@hekate/db";
import { defaultProjectRoles } from "@hekate/shared";
import { createBackends, storageConfigFromEnv } from "@hekate/storage";
import { eq, sql } from "drizzle-orm";
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
 * Comments are given to someone as they are opened (#499, decision 279): by the rule of the
 * stage the track waits at, over the track's, over the project's; each rule names one of the
 * project's people or roles and is set by whoever edits workflows. The stages a comment may be
 * deferred to are those of the workflows that apply to its track.
 */
describe.runIf(url)("comment assignment on opening, and the stages to defer to", () => {
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
  const storageRoot = mkdtempSync(join(tmpdir(), "hekate-comment-assignment-"));
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
  const put = (path: string, body: unknown, cookie: string) =>
    app.request(path, json(body, cookie, "PUT"));
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
  const rolesOf = async (owner: string, projectId: string) =>
    (
      (await (await get(`/api/projects/${projectId}/roles`, owner)).json()) as {
        roles: { id: string; name: string }[];
      }
    ).roles;
  const grantRole = async (owner: string, projectId: string, holder: string, name: string) => {
    let role = (await rolesOf(owner, projectId)).find((r) => r.name === name);
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

  /**
   * A workspace's owner, a project with a track whose one version is a recording, and a
   * producer (who edits workflows), two engineers (who triage) and a reviewer on it.
   */
  const studio = async () => {
    const owner = await setup();
    const organisationId = (
      (await (await get("/api/me", owner)).json()) as { activeOrganisationId: string }
    ).activeOrganisationId;
    const made = await post("/api/projects", { name: "Joplin Rags", profile: "music" }, owner);
    const projectId = ((await made.json()) as { project: { id: string } }).project.id;
    const producer = await joinAs(owner, "tomas@endlesshall.example", "Tomas Varga");
    const engineer = await joinAs(owner, "ines@endlesshall.example", "Ines Arlow");
    const second = await joinAs(owner, "noor@endlesshall.example", "Noor Haddad");
    const reviewer = await joinAs(owner, "alex@endlesshall.example", "Alex Rivera");
    await grantRole(owner, projectId, producer, "Producer");
    await grantRole(owner, projectId, engineer, "Engineer");
    await grantRole(owner, projectId, second, "Engineer");
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
    const fileId = await file("Maple Leaf Rag - V1.wav");
    const [track] = await db
      .insert(schema.tracks)
      .values({ organisationId, projectId, name: "Maple Leaf Rag" })
      .returning();
    const [version] = await db
      .insert(schema.versions)
      .values({ organisationId, trackId: track?.id ?? "", number: 1 })
      .returning();
    await db.insert(schema.variants).values({
      organisationId,
      versionId: version?.id ?? "",
      fileId,
      name: "Mix",
      isPrimary: true,
    });
    const roles = await rolesOf(owner, projectId);
    const roleId = (name: string) => roles.find((r) => r.name === name)?.id ?? "";
    return {
      owner,
      producer,
      engineer,
      second,
      reviewer,
      organisationId,
      projectId,
      trackId: track?.id ?? "",
      fileId,
      looseFileId: await file("Cover.wav"),
      roleId,
      ids: {
        producer: await idOf(producer),
        engineer: await idOf(engineer),
        second: await idOf(second),
        reviewer: await idOf(reviewer),
      },
    };
  };
  type Studio = Awaited<ReturnType<typeof studio>>;

  /** A project in another workspace, with a member and a role of its own. */
  const foreign = async () => {
    const [other] = await db
      .insert(schema.organisations)
      .values({ name: "Saltmarsh Films", slug: "saltmarsh" })
      .returning();
    const organisationId = other?.id ?? "";
    const [project] = await db
      .insert(schema.projects)
      .values({ organisationId, name: "Opening titles", profile: "video" })
      .returning();
    const [role] = await db
      .insert(schema.projectRoles)
      .values({
        organisationId,
        projectId: project?.id ?? "",
        name: "Director",
        permissions: ["view", "comment"],
      })
      .returning();
    const [user] = await db
      .insert(schema.users)
      .values({ id: "user-saltmarsh", name: "Someone Else", email: "else@saltmarsh.example" })
      .returning();
    const [track] = await db
      .insert(schema.tracks)
      .values({ organisationId, projectId: project?.id ?? "", name: "Titles" })
      .returning();
    return {
      projectId: project?.id ?? "",
      roleId: role?.id ?? "",
      userId: user?.id ?? "",
      trackId: track?.id ?? "",
    };
  };

  const member = (userId: string) => ({ assign: { kind: "member" as const, userId } });
  const role = (roleId: string) => ({ assign: { kind: "role" as const, roleId } });
  const nobody = { assign: null };

  const setProject = (s: Studio, rule: unknown, cookie = s.owner) =>
    patch(`/api/projects/${s.projectId}`, { commentAssignment: rule }, cookie);
  const setTrack = (s: Studio, rule: unknown, cookie = s.owner, trackId = s.trackId) =>
    put(`/api/tracks/${trackId}/comment-assignment`, { assignment: rule }, cookie);
  const open = async (s: Studio, body: string, cookie = s.reviewer, fileId = s.fileId) => {
    const res = await post(`/api/files/${fileId}/comments`, { body }, cookie);
    expect(res.status).toBe(201);
    return ((await res.json()) as { comment: { id: string; assigneeId: string | null } }).comment;
  };
  const told = (userId: string) =>
    db
      .select({ kind: schema.notifications.kind, text: schema.notifications.text })
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, userId));

  /** A workflow started by hand that waits at a task stage, with the stage's own rule. */
  const workflowWaitingAt = async (s: Studio, assign: unknown, name = "Mix") => {
    const made = await post(
      `/api/projects/${s.projectId}/workflows`,
      {
        name,
        definition: {
          groups: [],
          nodes: [
            { id: "start", type: "manual", name: "Started by hand", x: 0, y: 0, config: {} },
            {
              id: "mix",
              type: "task",
              name: "Mix",
              x: 320,
              y: 0,
              config: { who: "Engineer", status: "Mixing" },
              ...(assign === undefined ? {} : { assign }),
            },
            { id: "done", type: "finish", name: "Mixed", x: 640, y: 0, config: {} },
          ],
          connectors: [
            { id: "c1", from: "start", outcome: "happened", to: "mix" },
            { id: "c2", from: "mix", outcome: "done", to: "done" },
          ],
        },
      },
      s.owner,
    );
    expect(made.status).toBe(201);
    const { workflow } = (await made.json()) as { workflow: { id: string } };
    expect((await patch(`/api/workflows/${workflow.id}`, { active: true }, s.owner)).status).toBe(
      200,
    );
    const started = await post(
      `/api/tracks/${s.trackId}/workflow-runs`,
      { workflowId: workflow.id },
      s.owner,
    );
    expect(started.status).toBe(201);
    const { run } = (await started.json()) as { run: { id: string } };
    return { workflowId: workflow.id, runId: run.id };
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

  it("gives a new thread to whoever the project says, and tells them; without a rule, to nobody", async () => {
    const s = await studio();
    expect((await open(s, "Nobody's yet")).assigneeId).toBeNull();
    expect(await told(s.ids.engineer)).toEqual([]);

    expect((await setProject(s, member(s.ids.engineer), s.producer)).status).toBe(200);
    const opened = await open(s, "Pedal noise before the downbeat");
    expect(opened.assigneeId).toBe(s.ids.engineer);
    expect(await told(s.ids.engineer)).toEqual([
      { kind: "assigned", text: "opened a comment for you on Maple Leaf Rag - V1.wav" },
    ]);
    // A reply joins the thread and is nobody's on its own; the author of a thread given to
    // themself is not told of it.
    const reply = await post(
      `/api/files/${s.fileId}/comments`,
      { body: "Heard it", parentId: opened.id },
      s.engineer,
    );
    expect(
      ((await reply.json()) as { comment: { assigneeId: string | null } }).comment.assigneeId,
    ).toBeNull();
    expect((await open(s, "My own note", s.engineer)).assigneeId).toBe(s.ids.engineer);
    expect((await told(s.ids.engineer)).length).toBe(1);
    // A loose file of the project follows the project's rule too.
    expect((await open(s, "Cover is dark", s.reviewer, s.looseFileId)).assigneeId).toBe(
      s.ids.engineer,
    );
    // The project says what it chose.
    const shown = (await (await get(`/api/projects/${s.projectId}`, s.owner)).json()) as {
      project: { commentAssignment: unknown };
    };
    expect(shown.project.commentAssignment).toEqual(member(s.ids.engineer));
  });

  it("lets a role stand for whoever has held it longest, and a track's rule over the project's", async () => {
    const s = await studio();
    await setProject(s, member(s.ids.reviewer));
    expect((await setTrack(s, role(s.roleId("Engineer")), s.producer)).status).toBe(200);
    expect((await open(s, "Click at bar 3")).assigneeId).toBe(s.ids.engineer);
    // A role nobody holds gives the comment to nobody, rather than falling back.
    expect((await setTrack(s, role(s.roleId("Editor")))).status).toBe(200);
    expect((await open(s, "Click at bar 4")).assigneeId).toBeNull();
    // A track may say nobody, over a project that names someone.
    expect((await setTrack(s, nobody)).status).toBe(200);
    expect((await open(s, "Click at bar 5")).assigneeId).toBeNull();
    // And null hands it back to the project.
    expect((await setTrack(s, null)).status).toBe(200);
    expect((await open(s, "Click at bar 6")).assigneeId).toBe(s.ids.reviewer);
    const track = (await (await get(`/api/tracks/${s.trackId}`, s.owner)).json()) as {
      track: { commentAssignment: unknown };
    };
    expect(track.track.commentAssignment).toBeNull();
  });

  it("gives a thread opened while the track waits at a stage to whoever the stage says", async () => {
    const s = await studio();
    await setProject(s, member(s.ids.reviewer));
    await setTrack(s, member(s.ids.engineer));
    // A stage with no rule of its own leaves it to the track.
    await workflowWaitingAt(s, undefined, "Edit");
    expect((await open(s, "Too much low end")).assigneeId).toBe(s.ids.engineer);
    const { runId } = await workflowWaitingAt(s, member(s.ids.second));
    expect((await open(s, "Still too much low end")).assigneeId).toBe(s.ids.second);
    // Once the stage is done, the track's rule holds again.
    const ended = await post(
      `/api/workflow-runs/${runId}/steps`,
      { nodeId: "mix", outcome: "done" },
      s.owner,
    );
    expect(ended.status).toBe(200);
    expect((await open(s, "Better now")).assigneeId).toBe(s.ids.engineer);
  });

  it("refuses a rule naming anyone or any role outside the project, and anyone who does not edit workflows", async () => {
    const s = await studio();
    const other = await foreign();
    // Another workspace's member or role, and a role of another project here.
    expect((await setProject(s, member(other.userId))).status).toBe(422);
    expect((await setProject(s, role(other.roleId))).status).toBe(422);
    expect((await setTrack(s, member(other.userId))).status).toBe(422);
    expect((await setTrack(s, role(other.roleId))).status).toBe(422);
    const second = await post("/api/projects", { name: "Second", profile: "music" }, s.owner);
    const secondId = ((await second.json()) as { project: { id: string } }).project.id;
    const elsewhere = (await rolesOf(s.owner, secondId)).find((r) => r.name === "Engineer");
    expect((await setProject(s, role(elsewhere?.id ?? ""))).status).toBe(422);
    // Someone who is in the workspace but cannot see the project.
    const outsider = await joinAs(s.owner, "lena@endlesshall.example", "Lena Brook");
    expect((await setProject(s, member(await idOf(outsider)))).status).toBe(422);
    // A shape that is not a rule.
    expect((await setProject(s, { assign: { kind: "group", groupId: "x" } })).status).toBe(400);
    // Another workspace's track is not found; a lesser role is refused everywhere.
    expect((await setTrack(s, nobody, s.owner, other.trackId)).status).toBe(404);
    expect((await setProject(s, nobody, s.engineer)).status).toBe(403);
    expect((await setTrack(s, nobody, s.engineer)).status).toBe(403);
    expect((await setTrack(s, nobody, s.reviewer)).status).toBe(403);
    // A stage's rule is checked the same way, as the workflow is made or changed.
    const made = await post(
      `/api/projects/${s.projectId}/workflows`,
      {
        name: "Mix",
        definition: {
          groups: [],
          nodes: [
            { id: "start", type: "manual", name: "Started by hand", x: 0, y: 0, config: {} },
            {
              id: "mix",
              type: "task",
              name: "Mix",
              x: 320,
              y: 0,
              config: {},
              assign: member(other.userId),
            },
          ],
          connectors: [{ id: "c1", from: "start", outcome: "happened", to: "mix" }],
        },
      },
      s.owner,
    );
    expect(made.status).toBe(422);
    const { workflowId } = await workflowWaitingAt(s, undefined);
    const current = (await (await get(`/api/workflows/${workflowId}`, s.owner)).json()) as {
      workflow: { definition: { nodes: { id: string }[] } };
    };
    const withRule = (assign: unknown) => ({
      definition: {
        ...current.workflow.definition,
        nodes: current.workflow.definition.nodes.map((n) =>
          n.id === "mix" ? { ...n, assign } : n,
        ),
      },
    });
    expect(
      (await patch(`/api/workflows/${workflowId}`, withRule(role(other.roleId)), s.owner)).status,
    ).toBe(422);
    expect((await patch(`/api/workflows/${workflowId}`, withRule(nobody), s.engineer)).status).toBe(
      403,
    );
    expect(
      (
        await patch(
          `/api/workflows/${workflowId}`,
          withRule(role(s.roleId("Engineer"))),
          s.producer,
        )
      ).status,
    ).toBe(200);
  });

  it("lists the stages a thread may be deferred to, with the one the track waits at", async () => {
    const s = await studio();
    const stages = async (cookie = s.engineer, fileId = s.fileId) =>
      get(`/api/files/${fileId}/stages`, cookie);
    type Listed = {
      trackId: string | null;
      workflows: { name: string; stages: { nodeId: string; name: string; current: boolean }[] }[];
    };
    // No workflow switched on: nothing to offer, and the track named all the same.
    expect((await (await stages()).json()) as Listed).toEqual({
      trackId: s.trackId,
      workflows: [],
    });
    await workflowWaitingAt(s, undefined);
    expect((await (await stages()).json()) as Listed).toEqual({
      trackId: s.trackId,
      workflows: [{ name: "Mix", stages: [{ nodeId: "mix", name: "Mix", current: true }] }].map(
        (w) => expect.objectContaining(w),
      ),
    });
    // A loose file offers the project's workflows, with nothing current.
    expect((await (await stages(s.engineer, s.looseFileId)).json()) as Listed).toEqual({
      trackId: null,
      workflows: [
        expect.objectContaining({ stages: [{ nodeId: "mix", name: "Mix", current: false }] }),
      ],
    });
    // For those who triage, of this workspace.
    expect((await stages(s.reviewer)).status).toBe(403);
    const other = await foreign();
    const theirOrganisation =
      (await db.select().from(schema.projects).where(eq(schema.projects.id, other.projectId)))[0]
        ?.organisationId ?? "";
    const blob = await storage.put(theirOrganisation, Buffer.from("titles"));
    const [theirs] = await db
      .insert(schema.files)
      .values({
        organisationId: theirOrganisation,
        projectId: other.projectId,
        name: "Titles.mov",
        kind: "video",
        blobId: blob.id,
        contentType: "video/quicktime",
        byteSize: blob.byteSize,
      })
      .returning();
    expect((await stages(s.owner, theirs?.id ?? "")).status).toBe(404);
  });
});

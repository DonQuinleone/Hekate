import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, schema, withAuditPurge } from "@hekate/db";
import type { ProjectMember } from "@hekate/shared";
import { defaultProjectRoles } from "@hekate/shared";
import { createBackends, storageConfigFromEnv } from "@hekate/storage";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { createAudit } from "./audit.ts";
import { createAuth } from "./auth.ts";
import { createKeyring } from "./keyring.ts";
import { memoryMailer } from "./mail.ts";
import { playbackSecret } from "./playback.ts";
import { dropOwnerships } from "./project-owners.ts";
import { createStorage } from "./storage.ts";

const url = process.env.DATABASE_URL;

/**
 * A project's owners (#507, decision 285): its creator is the first, there may be several, one
 * can step down while another remains and the last cannot; an owner passes a check their role
 * would fail; a lesser role and a member of another workspace are refused.
 */
describe.runIf(url)("project owners", () => {
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
  const storageRoot = mkdtempSync(join(tmpdir(), "hekate-project-owners-"));
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

  const send = (method: string, path: string, cookie: string, body: unknown = {}) =>
    app.request(path, { ...json(body, cookie), method });
  const membersOf = async (projectId: string, cookie: string) =>
    (
      (await (await getAs(`/api/projects/${projectId}/members`, cookie)).json()) as {
        members: ProjectMember[];
      }
    ).members;
  const codeOf = async (res: Response) =>
    ((await res.json()) as { error: { code: string } }).error.code;

  /** A project made by its first owner, with an engineer and a reviewer in it. */
  const studio = async () => {
    const owner = await setup();
    const made = await app.request(
      "/api/projects",
      json({ name: "Joplin Rags", profile: "music" }, owner),
    );
    expect(made.status).toBe(201);
    const projectId = ((await made.json()) as { project: { id: string } }).project.id;
    const engineer = await joinAs(owner, "tomas@endlesshall.example");
    const reviewer = await joinAs(owner, "ines@endlesshall.example");
    await grantRole(owner, projectId, engineer, "Reviewer");
    await grantRole(owner, projectId, reviewer, "Reviewer");
    return {
      owner,
      engineer,
      reviewer,
      projectId,
      ownerId: await idOf(owner),
      engineerId: await idOf(engineer),
      reviewerId: await idOf(reviewer),
    };
  };
  const ownersIn = async (projectId: string, cookie: string) =>
    (await membersOf(projectId, cookie))
      .filter((m) => m.ownerSince !== null)
      .map((m) => m.userId)
      .sort();

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

  it("makes the creator the first owner, listed with when", async () => {
    const s = await studio();
    const listed = await membersOf(s.projectId, s.reviewer);
    const creator = listed.find((m) => m.userId === s.ownerId);
    expect(creator?.ownerSince).toEqual(expect.any(String));
    expect(creator?.roleId).toEqual(expect.any(String));
    expect(listed.find((m) => m.userId === s.engineerId)?.ownerSince).toBeNull();
  });

  it("lets two owners share a project, one step down, and never the last", async () => {
    const s = await studio();
    expect(
      (await send("PUT", `/api/projects/${s.projectId}/owners/${s.engineerId}`, s.owner)).status,
    ).toBe(204);
    expect(await ownersIn(s.projectId, s.owner)).toEqual([s.ownerId, s.engineerId].sort());
    // Making an owner again changes nothing.
    expect(
      (await send("PUT", `/api/projects/${s.projectId}/owners/${s.engineerId}`, s.owner)).status,
    ).toBe(204);

    // The creator steps down, back to their role; the engineer remains.
    expect(
      (await send("DELETE", `/api/projects/${s.projectId}/owners/${s.ownerId}`, s.owner)).status,
    ).toBe(204);
    expect(await ownersIn(s.projectId, s.owner)).toEqual([s.engineerId]);
    const creator = (await membersOf(s.projectId, s.owner)).find((m) => m.userId === s.ownerId);
    expect(creator?.roleId).toEqual(expect.any(String));

    // The last owner cannot step down, by their own hand or a workspace owner's.
    const last = await send(
      "DELETE",
      `/api/projects/${s.projectId}/owners/${s.engineerId}`,
      s.engineer,
    );
    expect(last.status).toBe(409);
    expect(await codeOf(last)).toBe("last_owner");
    expect(
      (await send("DELETE", `/api/projects/${s.projectId}/owners/${s.engineerId}`, s.owner)).status,
    ).toBe(409);
    // Nor is an owner removed as a member would be.
    expect(
      (await send("DELETE", `/api/projects/${s.projectId}/members/${s.engineerId}`, s.owner))
        .status,
    ).toBe(409);
    // Someone who is not an owner has no ownership to give up.
    expect(
      (await send("DELETE", `/api/projects/${s.projectId}/owners/${s.reviewerId}`, s.owner)).status,
    ).toBe(404);
    expect(await ownersIn(s.projectId, s.owner)).toEqual([s.engineerId]);
  });

  it("never lets two owners stepping down at once leave the project without one", async () => {
    const s = await studio();
    await send("PUT", `/api/projects/${s.projectId}/owners/${s.engineerId}`, s.owner);
    const results = await Promise.all([
      send("DELETE", `/api/projects/${s.projectId}/owners/${s.ownerId}`, s.owner),
      send("DELETE", `/api/projects/${s.projectId}/owners/${s.engineerId}`, s.engineer),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
    expect(await ownersIn(s.projectId, s.owner)).toHaveLength(1);
  });

  it("lets an owner pass a check their role would fail", async () => {
    const s = await studio();
    // As a Reviewer, the engineer may not manage people or settings.
    const role = (await membersOf(s.projectId, s.owner)).find(
      (m) => m.userId === s.reviewerId,
    )?.roleId;
    const assign = () =>
      send("PUT", `/api/projects/${s.projectId}/members/${s.reviewerId}`, s.engineer, {
        roleId: role,
      });
    expect((await assign()).status).toBe(403);
    expect(
      (await send("PATCH", `/api/projects/${s.projectId}`, s.engineer, { name: "Rags" })).status,
    ).toBe(403);
    await send("PUT", `/api/projects/${s.projectId}/owners/${s.engineerId}`, s.owner);
    expect((await assign()).status).toBe(204);
    expect(
      (await send("PATCH", `/api/projects/${s.projectId}`, s.engineer, { name: "Rags" })).status,
    ).toBe(200);
    // Every permission and every tool, whatever the role says.
    const project = (await (await getAs(`/api/projects/${s.projectId}`, s.engineer)).json()) as {
      project: { permissions: string[] };
    };
    expect(project.project.permissions).toEqual(
      expect.arrayContaining(["manage_roles", "delete_project"]),
    );
    // And an owner makes and unmakes owners, which their role could never do.
    expect(
      (await send("PUT", `/api/projects/${s.projectId}/owners/${s.reviewerId}`, s.engineer)).status,
    ).toBe(204);
    expect(
      (await send("DELETE", `/api/projects/${s.projectId}/owners/${s.reviewerId}`, s.engineer))
        .status,
    ).toBe(204);
  });

  it("refuses a lesser role and a member of another workspace", async () => {
    const s = await studio();
    // A member who may manage people, but is no owner, does not reach above the roles.
    await grantRole(s.owner, s.projectId, s.reviewer, "Producer");
    expect(
      (await send("PUT", `/api/projects/${s.projectId}/owners/${s.reviewerId}`, s.reviewer)).status,
    ).toBe(403);
    expect(
      (await send("DELETE", `/api/projects/${s.projectId}/owners/${s.ownerId}`, s.reviewer)).status,
    ).toBe(403);
    // Only a member of the workspace can be made an owner.
    expect(
      (await send("PUT", `/api/projects/${s.projectId}/owners/not-a-member`, s.owner)).status,
    ).toBe(404);

    // Another workspace's owner finds no such project.
    const outsider = await joinAs(s.owner, "outsider-owners@example.test");
    const [elsewhere] = await db
      .insert(schema.organisations)
      .values({ name: "Saltmarsh Films", slug: "saltmarsh-owners" })
      .returning({ id: schema.organisations.id });
    await db.insert(schema.members).values({
      organisationId: elsewhere?.id ?? "",
      userId: await idOf(outsider),
      role: "owner",
    });
    await send("PUT", "/api/me/organisation", outsider, { organisationId: elsewhere?.id });
    const outsiderId = await idOf(outsider);
    for (const [method, path] of [
      ["PUT", `/api/projects/${s.projectId}/owners/${outsiderId}`],
      ["DELETE", `/api/projects/${s.projectId}/owners/${s.ownerId}`],
      ["POST", `/api/projects/${s.projectId}/leave`],
    ] as const)
      expect((await send(method, path, outsider)).status).toBe(404);
    expect((await getAs(`/api/projects/${s.projectId}/members`, outsider)).status).toBe(404);
    expect(await ownersIn(s.projectId, s.owner)).toEqual([s.ownerId]);
  });

  it("asks the last owner who takes over before they leave", async () => {
    const s = await studio();
    const project = `/api/projects/${s.projectId}`;
    const alone = await send("POST", `${project}/leave`, s.owner);
    expect(alone.status).toBe(409);
    expect(await codeOf(alone)).toBe("successor_needed");
    expect(
      (await send("POST", `${project}/leave`, s.owner, { successorId: s.ownerId })).status,
    ).toBe(422);
    expect(
      (await send("POST", `${project}/leave`, s.owner, { successorId: "not-a-member" })).status,
    ).toBe(404);
    expect(await ownersIn(s.projectId, s.reviewer)).toEqual([s.ownerId]);

    expect(
      (await send("POST", `${project}/leave`, s.owner, { successorId: s.engineerId })).status,
    ).toBe(204);
    const listed = await membersOf(s.projectId, s.engineer);
    expect(listed.some((m) => m.userId === s.ownerId)).toBe(false);
    expect(listed.filter((m) => m.ownerSince).map((m) => m.userId)).toEqual([s.engineerId]);

    // Anyone else simply goes.
    expect((await send("POST", `${project}/leave`, s.reviewer)).status).toBe(204);
    expect((await membersOf(s.projectId, s.engineer)).some((m) => m.userId === s.reviewerId)).toBe(
      false,
    );
    // A workspace owner with no place in it has none to leave.
    expect((await send("POST", `${project}/leave`, s.owner)).status).toBe(409);
  });

  it("hands a project on when its last owner leaves the workspace", async () => {
    const s = await studio();
    await send("PUT", `/api/projects/${s.projectId}/owners/${s.engineerId}`, s.owner);
    await send("POST", `/api/projects/${s.projectId}/leave`, s.owner);
    expect(await ownersIn(s.projectId, s.owner)).toEqual([s.engineerId]);
    const organisationId = (
      (await (await getAs("/api/me", s.owner)).json()) as { activeOrganisationId: string }
    ).activeOrganisationId;
    const [membership] = await db
      .select({ id: schema.members.id })
      .from(schema.members)
      .where(
        and(
          eq(schema.members.organisationId, organisationId),
          eq(schema.members.userId, s.engineerId),
        ),
      );
    expect(
      (await send("DELETE", `/api/organisation/members/${membership?.id}`, s.owner)).status,
    ).toBe(204);
    // Its earliest member still there takes it on.
    expect(await ownersIn(s.projectId, s.owner)).toEqual([s.reviewerId]);
  });

  it("never hands a project back to the person leaving, whatever of theirs is left", async () => {
    // Account deletion drops ownerships while the leaver's project role is still there: the
    // earliest member is then the leaver, who must be passed over.
    const s = await studio();
    const organisationId = (
      (await (await getAs("/api/me", s.owner)).json()) as { activeOrganisationId: string }
    ).activeOrganisationId;
    expect(await ownersIn(s.projectId, s.owner)).toEqual([s.ownerId]);
    await db.transaction((tx) => dropOwnerships(tx, organisationId, s.ownerId));
    expect(await ownersIn(s.projectId, s.owner)).toEqual([s.engineerId]);
  });

  it("goes with the project when it is deleted", async () => {
    const s = await studio();
    await db.delete(schema.projects).where(eq(schema.projects.id, s.projectId));
    expect(
      await db
        .select()
        .from(schema.projectOwners)
        .where(eq(schema.projectOwners.projectId, s.projectId)),
    ).toEqual([]);
  });
});

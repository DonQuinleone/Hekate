import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, schema, withAuditPurge } from "@hekate/db";
import type { ApiLogRow, ApiTokenRow } from "@hekate/shared";
import { createBackends, storageConfigFromEnv } from "@hekate/storage";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashApiToken } from "./api-tokens.ts";
import { createApp } from "./app.ts";
import { createAudit } from "./audit.ts";
import { createAuth } from "./auth.ts";
import { createKeyring } from "./keyring.ts";
import { apiLog } from "./logs.ts";
import { memoryMailer } from "./mail.ts";
import { playbackSecret } from "./playback.ts";
import { createStorage } from "./storage.ts";

const url = process.env.DATABASE_URL;

describe.runIf(url)("API tokens (#198)", () => {
  const { db, close } = createDb(url ?? "", { max: 3 });
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
  const storageRoot = mkdtempSync(join(tmpdir(), "hekate-tokens-storage-"));
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
  /** A call made with a token, as a script would make it. */
  const withToken = (token: string, path: string, method = "GET", body?: unknown) =>
    app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
  const joinAs = async (owner: string, email: string, role: string) => {
    const invited = await app.request(
      "/api/organisation/invitations",
      json({ email, role }, owner),
    );
    const { link } = (await invited.json()) as { link: string };
    const res = await app.request(
      `/api/invitations/${link.split("/invite/")[1]}/accept`,
      json({ name: "Tomas Varga", password: "correct horse battery" }),
    );
    expect(res.status).toBe(201);
    return cookieOf(res);
  };
  const organisationOf = async (cookie: string) =>
    (
      (await (await app.request("/api/me", { headers: { cookie } })).json()) as {
        activeOrganisationId: string;
      }
    ).activeOrganisationId;
  const makeToken = async (
    cookie: string,
    scopes: string[],
    path = "/api/me/tokens",
    extra: Record<string, unknown> = {},
  ) => {
    const res = await app.request(
      path,
      json({ name: "Release pipeline", scopes, expiresInDays: 90, ...extra }, cookie),
    );
    expect(res.status).toBe(201);
    return (await res.json()) as { token: ApiTokenRow; secret: string };
  };
  const project = async (cookie: string, name = "Joplin Rags") => {
    const res = await app.request("/api/projects", json({ name, profile: "music" }, cookie));
    expect(res.status).toBe(201);
    return ((await res.json()) as { project: { id: string } }).project.id;
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
    await withAuditPurge(db, (tx) =>
      tx.execute(sql`truncate ${schema.organisations}, ${schema.users} cascade`),
    );
    await close();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it("shows a token once, keeps only its hash, and lists it without it", async () => {
    const owner = await setup();
    const { token, secret } = await makeToken(owner, ["files:read", "reviews:read"]);
    expect(secret).toMatch(/^hk_pat_[A-Za-z0-9_-]{43}$/);
    expect(token).toMatchObject({
      kind: "personal",
      name: "Release pipeline",
      hint: secret.slice(0, 11),
      scopes: ["files:read", "reviews:read"],
      createdBy: "Mira Solberg",
      lastUsedAt: null,
    });
    expect(new Date(token.expiresAt ?? 0).getTime()).toBeGreaterThan(Date.now() + 89 * 86_400_000);
    const [stored] = await db.select().from(schema.apiTokens);
    expect(stored?.tokenHash).toBe(hashApiToken(secret));
    expect(stored?.tokenHash).not.toContain(secret);
    expect(JSON.stringify(stored)).not.toContain(secret);
    const listed = await app.request("/api/me/tokens", { headers: { cookie: owner } });
    const body = await listed.text();
    expect(body).toContain(token.id);
    expect(body).not.toContain(secret);
    // Its making is in the access log, by name and hint, never the token.
    const events = await db
      .select()
      .from(schema.accessEvents)
      .where(eq(schema.accessEvents.action, "api_token.create"));
    expect(events).toHaveLength(1);
    expect(events[0]?.details).toMatchObject({ token: "Release pipeline", hint: token.hint });
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it("lets a token with a read scope read, but never write", async () => {
    const owner = await setup();
    const projectId = await project(owner);
    const { secret } = await makeToken(owner, ["files:read"]);
    const read = await withToken(secret, "/api/projects");
    expect(read.status).toBe(200);
    expect(JSON.stringify(await read.json())).toContain(projectId);
    expect((await withToken(secret, `/api/projects/${projectId}/folders`)).status).toBe(200);

    const write = await withToken(secret, `/api/projects/${projectId}/folders`, "POST", {
      name: "Masters",
    });
    expect(write.status).toBe(403);
    expect(await write.json()).toMatchObject({ error: { code: "insufficient_scope" } });
    expect(
      (await withToken(secret, "/api/projects", "POST", { name: "x", profile: "music" })).status,
    ).toBe(403);
    // Nor reach what another scope covers.
    expect((await withToken(secret, `/api/projects/${projectId}/reviews`)).status).toBe(403);

    // With the write scope, it writes, as its member.
    const writer = await makeToken(owner, ["files:write"]);
    const made = await withToken(writer.secret, `/api/projects/${projectId}/folders`, "POST", {
      name: "Masters",
    });
    expect(made.status).toBe(201);
    // Writing a kind includes reading it.
    expect((await withToken(writer.secret, `/api/projects/${projectId}/folders`)).status).toBe(200);
  });

  it("never reaches accounts, other tokens, settings, the instance or playback", async () => {
    const owner = await setup();
    const { secret } = await makeToken(owner, [
      "files:read",
      "files:write",
      "reviews:read",
      "reviews:write",
      "comments",
      "downloads",
      "workflows",
      "org:read",
    ]);
    for (const [method, path] of [
      ["GET", "/api/me"],
      ["GET", "/api/me/tokens"],
      ["POST", "/api/me/tokens"],
      ["GET", "/api/organisation/tokens"],
      ["PATCH", "/api/organisation"],
      ["GET", "/api/organisation/audit"],
      ["GET", "/api/instance/me"],
      ["GET", "/api/auth/get-session"],
      ["POST", "/api/files/0190a6f0-0000-7000-8000-000000000001/playback"],
    ] as const) {
      const res = await withToken(
        secret,
        path,
        method,
        method === "GET" ? undefined : { name: "x", scopes: ["files:read"], expiresInDays: null },
      );
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: "token_not_allowed" } });
    }
    expect(await db.select().from(schema.apiTokens)).toHaveLength(1);
    // Within org:read, the workspace's members, read-only.
    expect((await withToken(secret, "/api/organisation/members")).status).toBe(200);
  });

  it("refuses a token revoked, expired, mistyped, or whose member has left", async () => {
    const owner = await setup();
    const member = await joinAs(owner, "tomas@endlesshall.example", "member");
    const mine = await makeToken(owner, ["files:read"]);
    const theirs = await makeToken(member, ["files:read"]);
    expect((await withToken(mine.secret, "/api/projects")).status).toBe(200);
    expect((await withToken(theirs.secret, "/api/projects")).status).toBe(200);

    // Revoked: by its member only; another's is not theirs to see.
    expect(
      (
        await app.request(`/api/me/tokens/${mine.token.id}`, {
          method: "DELETE",
          headers: { cookie: member, origin: "http://localhost:3000" },
        })
      ).status,
    ).toBe(404);
    const revoked = await app.request(`/api/me/tokens/${mine.token.id}`, {
      method: "DELETE",
      headers: { cookie: owner, origin: "http://localhost:3000" },
    });
    expect(revoked.status).toBe(204);
    const refused = await withToken(mine.secret, "/api/projects");
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ error: { code: "token_invalid" } });
    expect(refused.headers.get("www-authenticate")).toContain("invalid_token");

    // Expired.
    const later = await makeToken(owner, ["files:read"]);
    await db
      .update(schema.apiTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.apiTokens.id, later.token.id));
    expect((await withToken(later.secret, "/api/projects")).status).toBe(401);

    // Mistyped, or made up.
    expect((await withToken(`${later.secret.slice(0, -1)}x`, "/api/projects")).status).toBe(401);
    expect((await withToken("hk_pat_nothing", "/api/projects")).status).toBe(401);

    // Their member removed: their token goes with them.
    const [membership] = await db
      .select({ id: schema.members.id })
      .from(schema.members)
      .where(eq(schema.members.role, "member"));
    const removed = await app.request(`/api/organisation/members/${membership?.id}`, {
      method: "DELETE",
      headers: { cookie: owner, origin: "http://localhost:3000" },
    });
    expect(removed.status).toBe(204);
    expect((await withToken(theirs.secret, "/api/projects")).status).toBe(401);
  });

  it("reaches its own workspace alone", async () => {
    const owner = await setup();
    await project(owner);
    const { secret } = await makeToken(owner, ["files:read", "files:write"]);
    // Another workspace, which the token's member also owns.
    const [other] = await db
      .insert(schema.organisations)
      .values({ name: "Lantern Pictures", slug: "lantern" })
      .returning();
    const [user] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, "mira@endlesshall.example"));
    await db
      .insert(schema.members)
      .values({ organisationId: other?.id ?? "", userId: user?.id ?? "", role: "owner" });
    const [theirs] = await db
      .insert(schema.projects)
      .values({ organisationId: other?.id ?? "", name: "Crossing", profile: "video" })
      .returning();
    const listed = await withToken(secret, "/api/projects");
    expect(JSON.stringify(await listed.json())).not.toContain(theirs?.id);
    expect((await withToken(secret, `/api/projects/${theirs?.id}`)).status).toBe(404);
    expect(
      (await withToken(secret, `/api/projects/${theirs?.id}/folders`, "POST", { name: "In" }))
        .status,
    ).toBe(404);
    // A host pinned to another workspace takes none of this one's tokens (#176) is covered by
    // the middleware; here, the token's workspace is the one it was made in.
    const [row] = await db.select().from(schema.apiTokens);
    expect(row?.organisationId).toBe(await organisationOf(owner));
  });

  it("lets owners and admins alone make service tokens, which act as the workspace", async () => {
    const owner = await setup();
    const member = await joinAs(owner, "tomas@endlesshall.example", "member");
    const projectId = await project(owner);
    const input = { name: "Archive sync", scopes: ["files:read"], expiresInDays: null };
    expect((await app.request("/api/organisation/tokens", json(input, member))).status).toBe(403);
    expect(
      (await app.request("/api/organisation/tokens", { headers: { cookie: member } })).status,
    ).toBe(403);

    const { token, secret } = await makeToken(
      owner,
      ["files:read", "files:write"],
      "/api/organisation/tokens",
      {
        name: "Archive sync",
        expiresInDays: null,
      },
    );
    expect(secret).toMatch(/^hk_svc_/);
    expect(token).toMatchObject({ kind: "service", expiresAt: null, createdBy: "Mira Solberg" });
    // A member's own list does not hold it, nor theirs the workspace's.
    const own = (await (
      await app.request("/api/me/tokens", { headers: { cookie: owner } })
    ).json()) as {
      tokens: ApiTokenRow[];
    };
    expect(own.tokens).toEqual([]);

    // It sees every project, as an admin would, and what it makes is its own.
    const read = await withToken(secret, "/api/projects");
    expect(JSON.stringify(await read.json())).toContain(projectId);
    const made = await withToken(secret, `/api/projects/${projectId}/folders`, "POST", {
      name: "Deliveries",
    });
    expect(made.status).toBe(201);
    const [account] = await db
      .select()
      .from(schema.users)
      .innerJoin(schema.apiTokens, eq(schema.apiTokens.userId, schema.users.id))
      .where(eq(schema.apiTokens.id, token.id));
    expect(account?.users.email).toMatch(/@service-token\.invalid$/);
    // It is nobody's member, so it shows in no list of people.
    expect(
      await db
        .select()
        .from(schema.members)
        .where(eq(schema.members.userId, account?.users.id ?? "")),
    ).toEqual([]);
    expect((await audit.member(account?.users.id ?? "")).label).toBe(
      "Archive sync (service token)",
    );

    // Renamed, its account is too; revoked, it stops.
    const renamed = await app.request(
      `/api/organisation/tokens/${token.id}`,
      json({ name: "Archive sync (nightly)", scopes: ["files:read"] }, owner, "PATCH"),
    );
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { token: ApiTokenRow }).token.scopes).toEqual(["files:read"]);
    expect(
      (await withToken(secret, `/api/projects/${projectId}/folders`, "POST", { name: "No" }))
        .status,
    ).toBe(403);
    const [named] = await db
      .select({ name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.id, account?.users.id ?? ""));
    expect(named?.name).toBe("Archive sync (nightly)");
    expect(
      (
        await app.request(`/api/organisation/tokens/${token.id}`, {
          method: "DELETE",
          headers: { cookie: member, origin: "http://localhost:3000" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(`/api/organisation/tokens/${token.id}`, {
          method: "DELETE",
          headers: { cookie: owner, origin: "http://localhost:3000" },
        })
      ).status,
    ).toBe(204);
    expect((await withToken(secret, "/api/projects")).status).toBe(401);
    expect(
      await db
        .select({ action: schema.accessEvents.action })
        .from(schema.accessEvents)
        .where(
          and(
            eq(schema.accessEvents.organisationId, await organisationOf(owner)),
            sql`${schema.accessEvents.action}::text like 'api_token.%'`,
          ),
        )
        .orderBy(schema.accessEvents.id),
    ).toEqual([
      { action: "api_token.create" },
      { action: "api_token.change" },
      { action: "api_token.revoke" },
    ]);
  });

  it("can do no more than its member can", async () => {
    const owner = await setup();
    const member = await joinAs(owner, "tomas@endlesshall.example", "member");
    const projectId = await project(owner);
    const { secret } = await makeToken(member, ["files:read", "files:write", "org:read"]);
    // The member has no role in the project, so neither has their token.
    expect((await withToken(secret, `/api/projects/${projectId}`)).status).toBe(404);
    expect(
      (await withToken(secret, `/api/projects/${projectId}/folders`, "POST", { name: "x" })).status,
    ).toBe(404);
  });

  it("logs every call, counts it against the token's own limit, and keeps its last use", async () => {
    const owner = await setup();
    const { token, secret } = await makeToken(owner, ["files:read"]);
    expect((await withToken(secret, "/api/projects?x=secret-in-query")).status).toBe(200);
    expect((await withToken(secret, "/api/projects", "POST", { name: "x" })).status).toBe(403);
    const { rows } = await apiLog(db, { range: "24h", limit: 50 });
    expect(rows.map((r: ApiLogRow) => [r.method, r.path, r.status])).toEqual([
      ["POST", "/api/projects", 403],
      ["GET", "/api/projects", 200],
    ]);
    expect(rows[0]?.token).toMatchObject({
      id: token.id,
      name: "Release pipeline",
      kind: "personal",
    });
    // The workspace's admins read their own log.
    const own = await app.request("/api/organisation/tokens/log", { headers: { cookie: owner } });
    expect(own.status).toBe(200);
    expect(((await own.json()) as { rows: ApiLogRow[] }).rows).toHaveLength(2);
    const [used] = await db
      .select({ at: schema.apiTokens.lastUsedAt })
      .from(schema.apiTokens)
      .where(eq(schema.apiTokens.id, token.id));
    expect(used?.at).toBeInstanceOf(Date);

    // Past its limit, it waits.
    await db
      .update(schema.requestLimits)
      .set({ count: 10_000 })
      .where(eq(schema.requestLimits.key, `api-token:${token.id}`));
    const limited = await withToken(secret, "/api/projects");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });

  it("takes a token over a session the same request also carries", async () => {
    const owner = await setup();
    const { secret } = await makeToken(owner, ["files:read"]);
    const res = await app.request("/api/me/tokens", {
      headers: { cookie: owner, authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(403);
  });
});

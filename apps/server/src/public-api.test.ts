import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, schema, withAuditPurge } from "@hekate/db";
import { apiErrorBody, apiScopes } from "@hekate/shared";
import { createBackends, storageConfigFromEnv } from "@hekate/storage";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { createAudit } from "./audit.ts";
import { createAuth } from "./auth.ts";
import { createKeyring } from "./keyring.ts";
import { memoryMailer } from "./mail.ts";
import { apiOperations } from "./openapi/operations.ts";
import { referenceDocument } from "./openapi/reference.ts";
import { playbackSecret } from "./playback.ts";
import { createStorage } from "./storage.ts";

const url = process.env.DATABASE_URL;

type Doc = ReturnType<typeof referenceDocument>;
type Operation = { responses: Record<string, unknown> };

/**
 * Whether an answer has the shape its example shows: every field the example names, of the
 * same kind, all the way down (an array's first item for its items). An answer may say more.
 */
function shapeMisses(example: unknown, actual: unknown, at = "$"): string[] {
  if (example === null || example === undefined) return [];
  if (Array.isArray(example)) {
    if (!Array.isArray(actual)) return [`${at}: not an array`];
    return example.length > 0 && actual.length > 0
      ? shapeMisses(example[0], actual[0], `${at}[0]`)
      : [];
  }
  if (typeof example === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual))
      return [`${at}: not an object`];
    return Object.entries(example).flatMap(([key, inner]) =>
      key in actual
        ? shapeMisses(inner, (actual as Record<string, unknown>)[key], `${at}.${key}`)
        : [`${at}.${key}: missing`],
    );
  }
  if (actual === null) return [];
  return typeof example === typeof actual ? [] : [`${at}: ${typeof actual}, not ${typeof example}`];
}

describe.runIf(url)("the public API at /api/v1 (#197)", () => {
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
  const storageRoot = mkdtempSync(join(tmpdir(), "hekate-openapi-storage-"));
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
  const reference = referenceDocument();

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
  const tokenFor = async (cookie: string, scopes: readonly string[] = apiScopes) => {
    const res = await app.request(
      "/api/me/tokens",
      json({ name: "Release pipeline", scopes, expiresInDays: 30 }, cookie),
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { secret: string }).secret;
  };

  /**
   * A call through `/api/v1` as a script makes it, checked against the reference: the status
   * is the success the document names for it, and the answer has its example's shape.
   */
  const call = async (
    token: string,
    method: string,
    path: string,
    documented: string,
    body?: unknown,
    raw?: { type: string; bytes: Uint8Array<ArrayBuffer> },
  ) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(raw
          ? { "content-type": raw.type }
          : body === undefined
            ? {}
            : { "content-type": "application/json" }),
      },
      ...(raw ? { body: raw.bytes } : body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const op = (reference.paths as Record<string, Record<string, Operation>>)[documented]?.[
      method.toLowerCase()
    ];
    expect(op, `${method} ${documented}`).toBeDefined();
    const success = Object.keys(op?.responses ?? {}).find((s) => s.startsWith("2"));
    const text = await res.text();
    if (process.env.OPENAPI_CAPTURE)
      appendFileSync(
        process.env.OPENAPI_CAPTURE,
        `${method} ${documented} ${res.status}\n${text}\n`,
      );
    expect(`${res.status} ${text.slice(0, 300)}`).toMatch(new RegExp(`^${success} `));
    const answer = text ? (JSON.parse(text) as unknown) : null;
    const example = apiOperations[`${method} ${documented}`]?.response;
    if (example !== undefined && !process.env.OPENAPI_CAPTURE)
      expect(shapeMisses(example, answer), `${method} ${documented}`).toEqual([]);
    return (answer ?? {}) as Record<string, { id: string }>;
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

  it("serves its OpenAPI document to anyone, at /api/openapi.json and under the version", async () => {
    const owner = await setup();
    const token = await tokenFor(owner, ["files:read"]);
    const plain = await app.request("/api/openapi.json");
    expect(plain.status).toBe(200);
    const served = (await plain.json()) as Doc;
    expect(served.openapi).toBe("3.1.0");
    expect(served.servers).toEqual([{ url: "http://localhost:3000/api/v1" }]);
    // The same routes, read from the running app, as the published reference.
    expect(served.paths).toEqual(JSON.parse(JSON.stringify(reference.paths)));
    const versioned = await app.request("/api/v1/openapi.json");
    expect(await versioned.json()).toEqual(served);
    // A script may fetch it with its token in hand; the token is not judged for it.
    const withToken = await app.request("/api/v1/openapi.json", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(withToken.status).toBe(200);
  });

  it("answers as documented: statuses, and answers shaped as their examples", async () => {
    const owner = await setup();
    const token = await tokenFor(owner);
    const { project } = await call(token, "POST", "/projects", "/projects", {
      name: "Joplin Rags",
      profile: "music",
    });
    const projectId = project?.id;
    await call(token, "GET", "/projects", "/projects");
    await call(token, "GET", `/projects/${projectId}`, "/projects/{id}");
    const { folder } = await call(
      token,
      "POST",
      `/projects/${projectId}/folders`,
      "/projects/{id}/folders",
      { name: "Masters" },
    );
    const folderId = folder?.id;
    await call(token, "GET", `/projects/${projectId}/folders`, "/projects/{id}/folders");
    const { track } = await call(
      token,
      "POST",
      `/projects/${projectId}/tracks`,
      "/projects/{id}/tracks",
      { name: "Maple Leaf Rag", folderId },
    );
    const trackId = track?.id;
    await call(token, "GET", `/projects/${projectId}/tracks`, "/projects/{id}/tracks");
    await call(token, "GET", `/tracks/${trackId}`, "/tracks/{id}");

    // An upload: started, one chunk, finished.
    const bytes = new TextEncoder().encode("Maple Leaf Rag, the notes Joplin wrote.");
    const { upload } = await call(token, "POST", "/uploads", "/uploads", {
      projectId,
      folderId,
      name: "Maple Leaf Rag notes.txt",
      size: bytes.length,
      contentType: "text/plain",
    });
    const uploadId = upload?.id;
    await call(token, "GET", `/uploads/${uploadId}`, "/uploads/{id}");
    await call(
      token,
      "PUT",
      `/uploads/${uploadId}/chunks/0`,
      "/uploads/{id}/chunks/{index}",
      undefined,
      { type: "application/octet-stream", bytes },
    );
    const { file } = await call(
      token,
      "POST",
      `/uploads/${uploadId}/complete`,
      "/uploads/{id}/complete",
    );
    const fileId = file?.id;
    await call(token, "GET", `/files/${fileId}`, "/files/{id}");
    await call(token, "POST", `/files/${fileId}/comments`, "/files/{id}/comments", {
      body: "The second strain could be steadier.",
      anchor: { kind: "bar", from: { bar: 12, beat: 1 } },
    });
    await call(token, "GET", `/files/${fileId}/comments`, "/files/{id}/comments");
    await call(token, "GET", `/files/${fileId}/downloads`, "/files/{id}/downloads");
    await call(token, "GET", "/reviews", "/reviews");
    await call(token, "GET", `/projects/${projectId}/reviews`, "/projects/{id}/reviews");
    await call(token, "GET", "/organisation/members", "/organisation/members");
    await call(token, "GET", "/search?q=Maple", "/search");
    await call(token, "PATCH", `/folders/${folderId}`, "/folders/{id}", { name: "Final masters" });
    // An upload abandoned before it is finished.
    const { upload: dropped } = await call(token, "POST", "/uploads", "/uploads", {
      projectId,
      name: "Maple Leaf Rag (dry).wav",
      size: 1024,
    });
    await call(token, "DELETE", `/uploads/${dropped?.id}`, "/uploads/{id}");
  });

  it("answers only what a token may reach, and the same routes as the unversioned API", async () => {
    const owner = await setup();
    const token = await tokenFor(owner, ["files:read"]);
    const bearer = { headers: { authorization: `Bearer ${token}` } };
    // The web app's own calls are not part of the version, whoever asks.
    for (const path of ["/api/v1/me", "/api/v1/me/tokens", "/api/v1/organisation/tokens"]) {
      for (const init of [bearer, { headers: { cookie: owner } }]) {
        const res = await app.request(path, init);
        expect(res.status, path).toBe(404);
        expect(apiErrorBody.parse(await res.json()).error.code).toBe("not_found");
      }
    }
    expect(
      (await app.request("/api/v1/auth/get-session", { headers: { cookie: owner } })).status,
    ).toBe(404);
    expect((await app.request("/api/me", { headers: { cookie: owner } })).status).toBe(200);
    // A version the server does not answer, and a path that only looks like one.
    expect((await app.request("/api/v2/projects", bearer)).status).toBe(404);
    expect((await app.request("/api/v1projects", { headers: { cookie: owner } })).status).toBe(404);
    // The same route answers both ways, with a token or a session.
    const versioned = await app.request("/api/v1/projects", bearer);
    const unversioned = await app.request("/api/projects", bearer);
    expect(versioned.status).toBe(200);
    expect(await versioned.json()).toEqual(await unversioned.json());
    expect((await app.request("/api/v1/projects", { headers: { cookie: owner } })).status).toBe(
      200,
    );
    // The API log keeps the path as asked, version and all.
    const logged = await db.select({ path: schema.apiRequests.path }).from(schema.apiRequests);
    expect(logged.map((r) => r.path)).toContain("/api/v1/projects");
  });

  it("refuses in the documented error shape, naming what was wrong", async () => {
    const owner = await setup();
    const token = await tokenFor(owner, ["files:write"]);
    const post = (body: unknown, auth: Record<string, string>) =>
      app.request("/api/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify(body),
      });
    const invalid = await post({ profile: "opera" }, { authorization: `Bearer ${token}` });
    expect(invalid.status).toBe(400);
    const body = apiErrorBody.parse(await invalid.json());
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.issues?.map((i) => i.path).sort()).toEqual(["name", "profile"]);
    expect(body.error.message).toMatch(/^(name|profile): /);
    const wrong = await post(
      { name: "x", profile: "music" },
      { authorization: "Bearer hk_pat_nope" },
    );
    expect(wrong.status).toBe(401);
    expect(apiErrorBody.parse(await wrong.json()).error.code).toBe("token_invalid");
    const reader = await tokenFor(owner, ["files:read"]);
    const scoped = await post(
      { name: "x", profile: "music" },
      { authorization: `Bearer ${reader}` },
    );
    expect(scoped.status).toBe(403);
    expect(apiErrorBody.parse(await scoped.json()).error.code).toBe("insufficient_scope");
    const missing = await app.request("/api/v1/projects/01929b8e-5c1a-7d3e-9f40-2b6c8d1e4a57", {
      headers: { authorization: `Bearer ${reader}` },
    });
    expect(missing.status).toBe(404);
    expect(apiErrorBody.parse(await missing.json()).error.code).toBe("not_found");
    // Every answer names its request, for the log and a report.
    expect(missing.headers.get("x-request-id")).toMatch(/^req_/);
  });
});

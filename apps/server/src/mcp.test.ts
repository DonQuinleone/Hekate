import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, schema, withAuditPurge } from "@hekate/db";
import { type ApiScope, apiScopes, MCP_PATH, mcpTools } from "@hekate/shared";
import { createBackends, storageConfigFromEnv } from "@hekate/storage";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { createAudit } from "./audit.ts";
import { createAuth } from "./auth.ts";
import { createKeyring } from "./keyring.ts";
import { memoryMailer } from "./mail.ts";
import { withheld } from "./mcp.ts";
import { qaReportOf, reviewOf, threadsOf, waitingReviewOf } from "./mcp-tools.ts";
import { playbackSecret } from "./playback.ts";
import { createStorage } from "./storage.ts";

const url = process.env.DATABASE_URL;

describe("the MCP tools' answers (#199)", () => {
  it("pass on only the fields they name, so no address leaves", () => {
    const review = reviewOf({
      id: "r1",
      title: "Opening titles",
      playbackUrl: "https://example.test/media/1.m3u8",
      items: [{ id: "i1", kind: "file", fileId: "f1", name: "Mix.wav", url: "/api/x" }],
      reviewers: [{ name: "Tomas Varga", email: "tomas@example.test", state: "active" }],
      you: { reviewerId: "p1", active: true, canDecide: true },
    });
    const text = JSON.stringify(review);
    expect(text).not.toMatch(/url|m3u8|\/api\/|email|example\.test/i);
    expect(review.you).toEqual({
      reviewer: true,
      yourTurn: true,
      canDecide: true,
      canSubmit: false,
    });
    expect(review.reviewers[0]).toMatchObject({ name: "Tomas Varga", state: "active" });
  });

  it("gather replies under their threads, and leave resolved threads out when asked", () => {
    const rows = [
      { id: "a", parentId: null, body: "Too loud at bar 12", resolvedAt: null, createdAt: "1" },
      { id: "b", parentId: "a", body: "Agreed", createdAt: "3" },
      { id: "c", parentId: "a", body: "Fixed in v2", createdAt: "2" },
      { id: "d", parentId: null, body: "Done", resolvedAt: "2026-01-01", createdAt: "4" },
    ];
    const all = threadsOf(rows);
    expect(all.map((t) => t.id)).toEqual(["a", "d"]);
    expect(all[0]?.replies.map((r) => r.id)).toEqual(["c", "b"]);
    expect(threadsOf(rows, true).map((t) => t.id)).toEqual(["a"]);
  });

  it("read a waiting review and a QA report by name", () => {
    expect(
      waitingReviewOf({ id: "r", projectName: "Joplin Rags", yourTurn: true, secret: "x" }),
    ).toMatchObject({ id: "r", project: { name: "Joplin Rags" }, yourTurn: true });
    const qa = qaReportOf({
      status: "ready",
      profile: { label: "Streaming", source: "project", chosen: true },
      findings: [
        {
          check: "loudness",
          severity: "warn",
          summary: "Louder than the target",
          channel: null,
          start: null,
          end: null,
          details: { integrated: -9, nested: { a: 1 } },
        },
      ],
    });
    expect(qa.findings[0]?.details).toEqual({ integrated: -9 });
  });

  it("withhold any key that names an address or a secret, all the way down", () => {
    expect(
      withheld({ a: 1, downloadUrl: "x", nested: [{ href: "y", keep: true, playlist: "z" }] }),
    ).toEqual({ a: 1, nested: [{ keep: true }] });
  });
});

describe.runIf(url)("the MCP endpoint (#199)", () => {
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
  const storageRoot = mkdtempSync(join(tmpdir(), "hekate-mcp-storage-"));
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
      json({ name: "Assistant", scopes, expiresInDays: 30 }, cookie),
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { secret: string }).secret;
  };
  const userId = async () => {
    const [user] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, "mira@endlesshall.example"));
    return user?.id ?? "";
  };
  const activeOrganisation = async (cookie: string) =>
    (
      (await (await app.request("/api/me", { headers: { cookie } })).json()) as {
        activeOrganisationId: string;
      }
    ).activeOrganisationId;

  /** A call of the public API with a token, for what the tests set up. */
  const v1 = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(res.status, `${method} ${path}`).toBeLessThan(300);
    return (await res.json()) as Record<string, { id: string }>;
  };

  /**
   * In the token's workspace: a project, a recording in it, a comment on it, and an approval
   * review of it asking its owner.
   */
  const studio = async (cookie: string, name = "Joplin Rags") => {
    const full = await tokenFor(cookie);
    const organisationId = await activeOrganisation(cookie);
    const { project } = await v1(full, "POST", "/projects", { name, profile: "music" });
    const blob = await storage.put(organisationId, Buffer.from("not really audio"));
    const [file] = await db
      .insert(schema.files)
      .values({
        organisationId,
        projectId: project?.id ?? "",
        name: "Maple Leaf Rag.wav",
        kind: "audio",
        blobId: blob.id,
        contentType: "audio/wav",
        byteSize: blob.byteSize,
        mediaInfo: { duration: 60, audio: { codec: "pcm_s24le", channels: 2, sampleRate: 48000 } },
      })
      .returning();
    const fileId = file?.id ?? "";
    await v1(full, "POST", `/files/${fileId}/comments`, {
      body: "The second strain could be steadier.",
      anchor: { kind: "bar", from: { bar: 12, beat: 1 } },
    });
    const { review } = await v1(full, "POST", `/projects/${project?.id}/reviews`, {
      kind: "approval",
      title: "Opening titles",
      items: [{ fileId }],
      reviewers: [await userId()],
    });
    return { fileId, reviewId: review?.id ?? "", organisationId };
  };

  type Rpc = {
    jsonrpc: "2.0";
    id: number | string | null;
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  };
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    app.request(MCP_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const rpc = async (token: string, method: string, params?: unknown) => {
    const res = await post(
      { jsonrpc: "2.0", id: 7, method, ...(params === undefined ? {} : { params }) },
      { authorization: `Bearer ${token}` },
    );
    expect(res.status).toBe(200);
    return (await res.json()) as Rpc;
  };
  type ToolAnswer = {
    content: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  const tool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
    const answer = await rpc(token, "tools/call", { name, arguments: args });
    expect(answer.error).toBeUndefined();
    return answer.result as unknown as ToolAnswer;
  };
  const toolNames = async (token: string) =>
    (((await rpc(token, "tools/list")).result?.tools ?? []) as { name: string }[]).map(
      (t) => t.name,
    );

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

  it("speaks Streamable HTTP: initialise, notifications, versions, and a stream when asked", async () => {
    const owner = await setup();
    const token = await tokenFor(owner, ["reviews:read"]);
    const init = await rpc(token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.id).toBe(7);
    expect(init.result).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "hekate" },
    });
    // A version it does not speak is answered with the newest it does.
    const older = await rpc(token, "initialize", { protocolVersion: "2024-11-05" });
    expect(older.result?.protocolVersion).toBe("2025-11-25");
    expect((await rpc(token, "ping")).result).toEqual({});
    expect((await rpc(token, "resources/list")).error?.code).toBe(-32601);
    const bearer = { authorization: `Bearer ${token}` };
    // A notification is taken and not answered.
    expect(
      (await post({ jsonrpc: "2.0", method: "notifications/initialized" }, bearer)).status,
    ).toBe(202);
    // A header naming a version it does not speak, a batch, and what is not JSON-RPC.
    expect(
      (
        await post(
          { jsonrpc: "2.0", id: 1, method: "ping" },
          {
            ...bearer,
            "mcp-protocol-version": "1999-01-01",
          },
        )
      ).status,
    ).toBe(400);
    expect((await post([{ jsonrpc: "2.0", id: 1, method: "ping" }], bearer)).status).toBe(400);
    expect((await post({ hello: "there" }, bearer)).status).toBe(400);
    // One event on a stream, for a client that takes only that.
    const streamed = await post(
      { jsonrpc: "2.0", id: 3, method: "ping" },
      { ...bearer, accept: "text/event-stream" },
    );
    expect(streamed.headers.get("content-type")).toContain("text/event-stream");
    expect(await streamed.text()).toBe(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 3, result: {} })}\n\n`,
    );
    // No stream of its own to offer, and no session to end.
    for (const method of ["GET", "DELETE"])
      expect((await app.request(MCP_PATH, { method, headers: bearer })).status).toBe(405);
  });

  it("takes a token alone, pointing a client without one to where it gets one", async () => {
    const owner = await setup();
    const none = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(none.status).toBe(401);
    const metadataUrl = "http://localhost:3000/.well-known/oauth-protected-resource/api/mcp";
    expect(none.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${metadataUrl}"`);
    // A signed-in browser's cookie is not a token.
    expect(
      (await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { cookie: owner })).status,
    ).toBe(401);
    const wrong = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { authorization: `Bearer hk_pat_${"x".repeat(43)}` },
    );
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toContain('error="invalid_token"');
    // Another site's page in a browser, refused whatever it carries.
    const token = await tokenFor(owner, ["reviews:read"]);
    const foreign = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { authorization: `Bearer ${token}`, origin: "https://elsewhere.example" },
    );
    expect(foreign.status).toBe(403);
    // The protected resource metadata names Hekate's own authorisation server.
    const metadata = await app.request("/.well-known/oauth-protected-resource/api/mcp");
    expect(await metadata.json()).toMatchObject({
      resource: "http://localhost:3000/api/mcp",
      authorization_servers: ["http://localhost:3000"],
      scopes_supported: [...apiScopes],
      bearer_methods_supported: ["header"],
    });
    const root = await app.request("/.well-known/oauth-protected-resource");
    expect(((await root.json()) as { resource: string }).resource).toBe("http://localhost:3000");
  });

  it("reads what waits, a review and its comments, comments, decides, and reads a QA report", async () => {
    const owner = await setup();
    const { fileId, reviewId } = await studio(owner);
    const token = await tokenFor(owner, ["reviews:write", "comments", "files:read"]);
    expect(await toolNames(token)).toEqual(mcpTools.map((t) => t.name));

    const waiting = await tool(token, "list_waiting_reviews");
    expect(waiting.isError).toBeUndefined();
    const reviews = waiting.structuredContent?.reviews as { id: string; yourTurn: boolean }[];
    expect(reviews).toEqual([expect.objectContaining({ id: reviewId, yourTurn: true })]);
    // The same as text, for a client that reads only that.
    expect(JSON.parse(waiting.content[0]?.text ?? "")).toEqual(waiting.structuredContent);

    const read = await tool(token, "get_review", { reviewId });
    const review = read.structuredContent?.review as {
      title: string;
      items: { fileId: string }[];
      you: { canDecide: boolean };
    };
    expect(review).toMatchObject({ title: "Opening titles", you: { canDecide: true } });
    expect(review.items[0]?.fileId).toBe(fileId);
    const onFiles = read.structuredContent?.comments as { fileId: string; threads: unknown[] }[];
    expect(onFiles[0]?.threads).toEqual([
      expect.objectContaining({
        body: "The second strain could be steadier.",
        anchor: { kind: "bar", from: { bar: 12, beat: 1 } },
        author: "Mira Solberg",
      }),
    ]);

    const added = await tool(token, "add_comment", {
      fileId,
      body: "Bars 17 to 20 rush a little.",
      anchor: { kind: "bar", from: { bar: 17, beat: 1 }, to: { bar: 20 } },
    });
    expect(added.isError).toBeUndefined();
    const comment = added.structuredContent?.comment as { id: string; mine: boolean };
    expect(comment.mine).toBe(true);
    await tool(token, "add_comment", { fileId, body: "Agreed.", parentId: comment.id });
    const listed = await tool(token, "list_comments", { fileId });
    const threads = listed.structuredContent?.threads as { id: string; replies: unknown[] }[];
    expect(threads).toHaveLength(2);
    expect(threads.find((t) => t.id === comment.id)?.replies).toHaveLength(1);

    const qa = await tool(token, "get_qa_report", { fileId });
    expect(qa.isError).toBeUndefined();
    const report = qa.structuredContent?.report as {
      profile: { label: string };
      findings: unknown[];
    };
    expect(report.profile.label).toEqual(expect.any(String));
    expect(Array.isArray(report.findings)).toBe(true);

    const decided = await tool(token, "record_decision", {
      reviewId,
      decision: "approved",
      note: "Ready for the release.",
    });
    expect(decided.structuredContent?.review).toMatchObject({
      status: "completed",
      outcome: "approved",
      decisions: [
        expect.objectContaining({ decision: "approved", note: "Ready for the release." }),
      ],
    });
    // Nothing waits now; the closed review is still there to read.
    expect((await tool(token, "list_waiting_reviews")).structuredContent?.reviews).toEqual([]);
    expect(
      (await tool(token, "list_waiting_reviews", { include: "all" })).structuredContent?.reviews,
    ).toHaveLength(1);
    // Each tool's calls went through the public API, logged as a script's calls are.
    const logged = await db.select({ path: schema.apiRequests.path }).from(schema.apiRequests);
    expect(logged.map((r) => r.path)).toEqual(
      expect.arrayContaining([
        "/api/v1/reviews",
        `/api/v1/reviews/${reviewId}`,
        `/api/v1/files/${fileId}/comments`,
        `/api/v1/files/${fileId}/qa`,
        `/api/v1/reviews/${reviewId}/decisions`,
      ]),
    );
    // The decision is in the access log, as anyone's is.
    const events = await db
      .select({ action: schema.accessEvents.action })
      .from(schema.accessEvents)
      .where(eq(schema.accessEvents.action, "review.decision"));
    expect(events).toHaveLength(1);
  });

  it("never gives an address that would fetch media, whatever the token holds", async () => {
    const owner = await setup();
    const { fileId, reviewId } = await studio(owner);
    const token = await tokenFor(owner);
    // Not even with the downloads scope is there a tool that downloads.
    expect(await toolNames(token)).toEqual(mcpTools.map((t) => t.name));
    const answers = [
      await rpc(token, "tools/list"),
      await tool(token, "list_waiting_reviews", { include: "all" }),
      await tool(token, "get_review", { reviewId }),
      await tool(token, "list_comments", { fileId }),
      await tool(token, "get_qa_report", { fileId }),
    ];
    for (const answer of answers) {
      const text = JSON.stringify(answer);
      expect(text).not.toMatch(/https?:\/\/|\/api\/|\.m3u8|"(url|href|link|playlist)"/i);
    }
    // A tool that is not one is a protocol error.
    expect(
      (await rpc(token, "tools/call", { name: "download_file", arguments: { fileId } })).error
        ?.code,
    ).toBe(-32602);
  });

  it("acts within its scopes alone: lists only what it may call, refuses the rest", async () => {
    const owner = await setup();
    const { fileId, reviewId } = await studio(owner);
    const reader = await tokenFor(owner, ["reviews:read"]);
    expect(await toolNames(reader)).toEqual(["list_waiting_reviews", "get_review"]);
    // A review without its comments, which need their own scope.
    const read = await tool(reader, "get_review", { reviewId });
    expect(read.structuredContent).toMatchObject({ comments: null });
    const before = await db.select({ id: schema.comments.id }).from(schema.comments);
    const refusals: [string, Record<string, unknown>, ApiScope][] = [
      ["add_comment", { fileId, body: "Should not land." }, "comments"],
      ["list_comments", { fileId }, "comments"],
      ["record_decision", { reviewId, decision: "approved" }, "reviews:write"],
      ["get_qa_report", { fileId }, "files:read"],
    ];
    for (const [name, args, scope] of refusals) {
      const refused = await tool(reader, name, args);
      expect(refused.isError, name).toBe(true);
      expect(refused.content[0]?.text).toContain(scope);
    }
    expect(await db.select({ id: schema.comments.id }).from(schema.comments)).toEqual(before);
    const [still] = await db
      .select({ status: schema.reviews.status })
      .from(schema.reviews)
      .where(eq(schema.reviews.id, reviewId));
    expect(still?.status).toBe("open");

    // Files alone: the QA report and nothing of reviews or comments.
    const engineer = await tokenFor(owner, ["files:read"]);
    expect(await toolNames(engineer)).toEqual(["get_qa_report"]);
    expect((await tool(engineer, "list_waiting_reviews")).isError).toBe(true);

    // Arguments are checked, and a mistake is said so the assistant can try again.
    const wrong = await tool(reader, "get_review", { reviewId: "not-an-id" });
    expect(wrong.isError).toBe(true);
    expect(wrong.content[0]?.text).toMatch(/^Check the arguments: reviewId/);
  });

  it("reaches its own workspace alone, though its member reviews in another", async () => {
    const owner = await setup();
    const here = await studio(owner);
    const token = await tokenFor(owner);
    // Another workspace, which the same member owns and reviews in.
    const [other] = await db
      .insert(schema.organisations)
      .values({ name: "Lantern Pictures", slug: "lantern" })
      .returning();
    await db
      .insert(schema.members)
      .values({ organisationId: other?.id ?? "", userId: await userId(), role: "owner" });
    expect(
      (await app.request("/api/me/organisation", json({ organisationId: other?.id }, owner, "PUT")))
        .status,
    ).toBe(200);
    const there = await studio(owner, "Opening titles");
    expect(there.organisationId).toBe(other?.id);
    const theirToken = await tokenFor(owner);

    // Each token lists its own workspace's review, not the other's.
    const mine = (await tool(token, "list_waiting_reviews", { include: "all" })).structuredContent
      ?.reviews as { id: string }[];
    expect(mine.map((r) => r.id)).toEqual([here.reviewId]);
    const theirs = (await tool(theirToken, "list_waiting_reviews", { include: "all" }))
      .structuredContent?.reviews as { id: string }[];
    expect(theirs.map((r) => r.id)).toEqual([there.reviewId]);

    // The other workspace's review, file and comments are not found, and nothing is written.
    const before = await db.select({ id: schema.comments.id }).from(schema.comments);
    for (const [name, args] of [
      ["get_review", { reviewId: there.reviewId }],
      ["list_comments", { fileId: there.fileId }],
      ["get_qa_report", { fileId: there.fileId }],
      ["add_comment", { fileId: there.fileId, body: "Across the wall." }],
      ["record_decision", { reviewId: there.reviewId, decision: "approved" }],
    ] as const) {
      const refused = await tool(token, name, args);
      expect(refused.isError, name).toBe(true);
      expect(refused.content[0]?.text, name).toContain("404");
    }
    expect(await db.select({ id: schema.comments.id }).from(schema.comments)).toEqual(before);
    const [still] = await db
      .select({ status: schema.reviews.status })
      .from(schema.reviews)
      .where(eq(schema.reviews.id, there.reviewId));
    expect(still?.status).toBe("open");
  });

  it("stops working with its token: revoked, it is refused", async () => {
    const owner = await setup();
    const token = await tokenFor(owner, ["reviews:read"]);
    expect((await rpc(token, "tools/list")).result).toBeDefined();
    const [row] = await db.select({ id: schema.apiTokens.id }).from(schema.apiTokens);
    await app.request(`/api/me/tokens/${row?.id}`, {
      method: "DELETE",
      headers: { cookie: owner, origin: "http://localhost:3000" },
    });
    const refused = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { authorization: `Bearer ${token}` },
    );
    expect(refused.status).toBe(401);
  });
});

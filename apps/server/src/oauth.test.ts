import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, schema, withAuditPurge } from "@hekate/db";
import type {
  AuthorizeRefusal,
  AuthorizeRequestView,
  ConnectedAppRow,
  CreatedOAuthClient,
  OAuthClientRow,
  OAuthConnectionRow,
  TokenResponse,
} from "@hekate/shared";
import { createBackends, storageConfigFromEnv } from "@hekate/storage";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { createAudit } from "./audit.ts";
import { createAuth } from "./auth.ts";
import { createKeyring } from "./keyring.ts";
import { memoryMailer } from "./mail.ts";
import {
  type ClientRecord,
  checkAuthorize,
  pkceChallenge,
  pkceVerifies,
  purgeOAuth,
} from "./oauth.ts";
import { playbackSecret } from "./playback.ts";
import { createStorage } from "./storage.ts";

const ISSUER = "http://localhost:3000";

describe("checking an authorisation request (#447)", () => {
  const client = {
    id: "0190a6f0-0000-7000-8000-000000000001",
    organisationId: "0190a6f0-0000-7000-8000-000000000002",
    name: "Hekate for Slack",
    kind: "confidential",
    clientId: "hk_cli_AAAAAAAAAAAAAAAAAAAAAA",
    secretHash: null,
    secretHint: null,
    secretRotatedAt: null,
    redirectUris: ["https://slack.endlesshall.example/oauth/callback", "http://127.0.0.1/cb"],
    scopes: ["reviews:read", "comments"],
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } satisfies ClientRecord;
  const challenge = pkceChallenge("a".repeat(43));
  const good = {
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: client.redirectUris[0],
    scope: "comments",
    state: "xyz",
    code_challenge: challenge,
    code_challenge_method: "S256",
  };

  it("takes a well-formed request, and the client's own scopes when none are named", () => {
    expect(checkAuthorize(client, good, ISSUER)).toMatchObject({ scopes: ["comments"] });
    const { scope: _, ...unscoped } = good;
    expect(checkAuthorize(client, unscoped, ISSUER)).toMatchObject({
      scopes: ["reviews:read", "comments"],
    });
    // A desktop application at a loopback address may listen on any port.
    expect(
      checkAuthorize(client, { ...good, redirect_uri: "http://127.0.0.1:53124/cb" }, ISSUER),
    ).toMatchObject({ redirectUri: "http://127.0.0.1:53124/cb" });
  });

  it("never sends an unknown client, or an address not registered, anywhere", () => {
    for (const refused of [
      checkAuthorize(null, good, ISSUER),
      checkAuthorize(client, { ...good, redirect_uri: "https://attacker.example/cb" }, ISSUER),
      checkAuthorize(
        client,
        { ...good, redirect_uri: "https://slack.endlesshall.example/oauth/callback/" },
        ISSUER,
      ),
      checkAuthorize(client, { ...good, redirect_uri: undefined }, ISSUER),
    ])
      expect(refused).toMatchObject({ error: "invalid_request", redirect: null });
  });

  it("sends anything else wrong back to the application, with its state and the issuer", () => {
    const back = (params: Record<string, string | undefined>) => {
      const r = checkAuthorize(client, { ...good, ...params }, ISSUER) as AuthorizeRefusal;
      const url = new URL(r.redirect ?? "");
      expect(url.searchParams.get("state")).toBe("xyz");
      expect(url.searchParams.get("iss")).toBe(ISSUER);
      return url.searchParams.get("error");
    };
    expect(back({ response_type: "token" })).toBe("unsupported_response_type");
    expect(back({ code_challenge: undefined })).toBe("invalid_request");
    // PKCE downgrade: plain, or no method (which RFC 7636 reads as plain), is refused.
    expect(back({ code_challenge_method: "plain" })).toBe("invalid_request");
    expect(back({ code_challenge_method: undefined })).toBe("invalid_request");
    expect(back({ scope: "comments downloads" })).toBe("invalid_scope");
    expect(back({ scope: "comments admin" })).toBe("invalid_scope");
  });

  it("verifies a code verifier against its challenge, S256 only", () => {
    const verifier = randomBytes(32).toString("base64url");
    expect(pkceVerifies(verifier, pkceChallenge(verifier))).toBe(true);
    expect(pkceVerifies(`${verifier}x`, pkceChallenge(verifier))).toBe(false);
    expect(pkceVerifies(undefined, pkceChallenge(verifier))).toBe(false);
    // Plain (the verifier as its own challenge) never passes.
    expect(pkceVerifies("b".repeat(43), "b".repeat(43))).toBe(false);
    expect(pkceVerifies("short", pkceChallenge("short"))).toBe(false);
  });
});

const url = process.env.DATABASE_URL;

describe.runIf(url)("OAuth 2.1 with a sample client (#447)", () => {
  const { db, close } = createDb(url ?? "", { max: 3 });
  const mailer = memoryMailer();
  const audit = createAudit(db);
  const keyring = createKeyring(db, { current: Buffer.alloc(32, 7), previous: [] });
  const auth = createAuth({
    db,
    secret: "test-secret-test-secret-test-secret-0",
    baseURL: ISSUER,
    testing: true,
    mailer,
    audit,
    keyring,
  });
  const storageRoot = mkdtempSync(join(tmpdir(), "hekate-oauth-storage-"));
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
    publicUrl: ISSUER,
    log: false,
  });

  const json = (body: unknown, cookie?: string, method = "POST") => ({
    method,
    headers: {
      "content-type": "application/json",
      origin: ISSUER,
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
  const register = async (
    cookie: string,
    input: Partial<{ name: string; kind: string; redirectUris: string[]; scopes: string[] }> = {},
  ) => {
    const res = await app.request(
      "/api/organisation/oauth-clients",
      json(
        {
          name: "Hekate for Slack",
          kind: "confidential",
          redirectUris: ["https://slack.endlesshall.example/oauth/callback"],
          scopes: ["files:read", "reviews:read", "comments"],
          ...input,
        },
        cookie,
      ),
    );
    expect(res.status).toBe(201);
    return (await res.json()) as CreatedOAuthClient;
  };
  const withToken = (token: string, path: string, method = "GET", body?: unknown) =>
    app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const project = async (cookie: string) => {
    const res = await app.request(
      "/api/projects",
      json({ name: "Joplin Rags", profile: "music" }, cookie),
    );
    return ((await res.json()) as { project: { id: string } }).project.id;
  };

  /**
   * A sample client, as an application written against the OAuth 2.1 specification would be:
   * it reads the server's metadata, sends the person to the authorisation endpoint with PKCE
   * (S256) and a state, checks the state and issuer it gets back, and exchanges, refreshes and
   * revokes at the endpoints the metadata names, authenticating as its kind does. The person's
   * part (the consent screen) is played through the screen's own API, with their session.
   */
  const sampleClient = async (registered: CreatedOAuthClient, redirectUri?: string) => {
    const meta = (await (
      await app.request("/.well-known/oauth-authorization-server")
    ).json()) as Record<string, string>;
    const path = (endpoint: string) => new URL(endpoint).pathname;
    const redirect = redirectUri ?? registered.client.redirectUris[0] ?? "";
    const credentials = (): Record<string, string> =>
      registered.secret
        ? {
            authorization: `Basic ${Buffer.from(
              `${encodeURIComponent(registered.client.clientId)}:${encodeURIComponent(registered.secret)}`,
            ).toString("base64")}`,
          }
        : {};
    const post = (endpoint: string, fields: Record<string, string>) =>
      app.request(path(endpoint), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...credentials() },
        body: new URLSearchParams({
          ...(registered.secret ? {} : { client_id: registered.client.clientId }),
          ...fields,
        }).toString(),
      });
    return {
      meta,
      /** Where it sends the person, and what it keeps to finish: the state and the verifier. */
      begin(extra: Record<string, string | undefined> = {}) {
        const verifier = randomBytes(48).toString("base64url");
        const state = randomBytes(12).toString("base64url");
        const params: Record<string, string> = {
          response_type: "code",
          client_id: registered.client.clientId,
          redirect_uri: redirect,
          scope: "files:read comments",
          state,
          code_challenge: createHash("sha256").update(verifier).digest("base64url"),
          code_challenge_method: "S256",
        };
        for (const [k, v] of Object.entries(extra))
          if (v === undefined) delete params[k];
          else params[k] = v;
        return { params, verifier, state };
      },
      /** The person on the consent screen: what it shows, then their answer. */
      async consent(cookie: string, params: Record<string, string>, approve = true) {
        const shown = await app.request(
          `/api/oauth/authorize?${new URLSearchParams(params).toString()}`,
          { headers: { cookie } },
        );
        const view = (await shown.json()) as {
          request?: AuthorizeRequestView;
          refusal?: AuthorizeRefusal;
        };
        const answered = await app.request(
          "/api/oauth/authorize",
          json({ ...params, approve }, cookie),
        );
        return {
          shown: shown.status,
          view,
          status: answered.status,
          answer: (await answered.json()) as { redirect?: string; refusal?: AuthorizeRefusal },
        };
      },
      /** Back at its redirect address: the code, once the state and issuer are its own. */
      callback(address: string, state: string) {
        const back = new URL(address);
        expect(`${back.origin}${back.pathname}`).toBe(redirect.split("?")[0]);
        expect(back.searchParams.get("state")).toBe(state);
        expect(back.searchParams.get("iss")).toBe(meta.issuer);
        return { code: back.searchParams.get("code"), error: back.searchParams.get("error") };
      },
      exchange: (code: string, verifier: string | undefined, uri = redirect) =>
        post(meta.token_endpoint ?? "", {
          grant_type: "authorization_code",
          code,
          redirect_uri: uri,
          ...(verifier === undefined ? {} : { code_verifier: verifier }),
        }),
      refresh: (refreshToken: string, scope?: string) =>
        post(meta.token_endpoint ?? "", {
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          ...(scope ? { scope } : {}),
        }),
      revoke: (token: string) => post(meta.revocation_endpoint ?? "", { token }),
      /** The whole flow, to tokens. */
      async connect(cookie: string, extra: Record<string, string | undefined> = {}) {
        const { params, verifier, state } = this.begin(extra);
        const { answer } = await this.consent(cookie, params);
        const { code } = this.callback(answer.redirect ?? "", state);
        const res = await this.exchange(code ?? "", verifier);
        expect(res.status).toBe(200);
        return (await res.json()) as TokenResponse;
      },
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
    await withAuditPurge(db, (tx) =>
      tx.execute(sql`truncate ${schema.organisations}, ${schema.users} cascade`),
    );
    await close();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it("publishes its metadata", async () => {
    const res = await app.request("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth/authorize`,
      token_endpoint: `${ISSUER}/api/oauth/token`,
      revocation_endpoint: `${ISSUER}/api/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("runs the authorisation code flow with PKCE for a confidential client", async () => {
    const owner = await setup();
    const projectId = await project(owner);
    const registered = await register(owner);
    expect(registered.secret).toMatch(/^hk_cls_[A-Za-z0-9_-]{43}$/);
    expect(registered.client.clientId).toMatch(/^hk_cli_[A-Za-z0-9_-]{22}$/);
    // Only a hash of the secret is kept.
    const [stored] = await db.select().from(schema.oauthClients);
    expect(JSON.stringify(stored)).not.toContain(registered.secret);

    const client = await sampleClient(registered);
    const { params, verifier, state } = client.begin();
    const { shown, view, answer } = await client.consent(owner, params);
    expect(shown).toBe(200);
    expect(view.request).toEqual({
      client: { name: "Hekate for Slack", kind: "confidential" },
      workspace: { name: "Endless Hall Records" },
      scopes: ["files:read", "comments"],
      returnsTo: "slack.endlesshall.example",
      granted: false,
    });
    const { code } = client.callback(answer.redirect ?? "", state);
    expect(code).toMatch(/^hk_oac_/);

    const res = await client.exchange(code ?? "", verifier);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const tokens = (await res.json()) as TokenResponse;
    expect(tokens).toMatchObject({
      token_type: "Bearer",
      expires_in: 3600,
      scope: "files:read comments",
    });
    expect(tokens.access_token).toMatch(/^hk_oat_[A-Za-z0-9_-]{43}$/);
    expect(tokens.refresh_token).toMatch(/^hk_ort_[A-Za-z0-9_-]{43}$/);

    // The access token reaches the API as its member, within what was granted.
    const read = await withToken(tokens.access_token, "/api/projects");
    expect(read.status).toBe(200);
    expect(JSON.stringify(await read.json())).toContain(projectId);
    const write = await withToken(
      tokens.access_token,
      `/api/projects/${projectId}/folders`,
      "POST",
      {
        name: "Masters",
      },
    );
    expect(write.status).toBe(403);
    expect(await write.json()).toMatchObject({ error: { code: "insufficient_scope" } });
    // Never a token-minting path, nor the consent screen itself.
    expect((await withToken(tokens.access_token, "/api/me/tokens")).status).toBe(403);
    expect((await withToken(tokens.access_token, "/api/oauth/authorize")).status).toBe(403);
    // Its calls are in the API log, named for the application and its member.
    const [logged] = await db.select().from(schema.apiRequests);
    expect(logged).toMatchObject({
      tokenKind: "oauth",
      tokenName: "Hekate for Slack · Mira Solberg",
    });

    // Connecting again for as much is not asked again.
    const again = client.begin();
    expect((await client.consent(owner, again.params)).view.request?.granted).toBe(true);
    expect(
      (await client.consent(owner, { ...again.params, prompt: "consent" })).view.request?.granted,
    ).toBe(false);
    // The connection is in the access log, once.
    const connects = await db
      .select()
      .from(schema.accessEvents)
      .where(eq(schema.accessEvents.action, "oauth.connect"));
    expect(connects).toHaveLength(1);
    expect(JSON.stringify(connects)).not.toContain(registered.secret);
  });

  it("refreshes once per refresh token, and a refresh token used twice revokes the connection", async () => {
    const owner = await setup();
    const client = await sampleClient(await register(owner));
    const first = await client.connect(owner);

    const res = await client.refresh(first.refresh_token);
    expect(res.status).toBe(200);
    const second = (await res.json()) as TokenResponse;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect((await withToken(second.access_token, "/api/projects")).status).toBe(200);
    // The first access token still works until its hour is up.
    expect((await withToken(first.access_token, "/api/projects")).status).toBe(200);

    // The first refresh token again: someone may have stolen it. Everything stops.
    const replay = await client.refresh(first.refresh_token);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
    expect((await withToken(second.access_token, "/api/projects")).status).toBe(401);
    expect((await withToken(first.access_token, "/api/projects")).status).toBe(401);
    expect((await client.refresh(second.refresh_token)).status).toBe(400);
    // The person's consent stays: the application asks for tokens again, not for consent.
    expect(await db.select().from(schema.oauthGrants)).toHaveLength(1);
  });

  it("refuses a wider scope on refresh, spending nothing, and takes a narrower one", async () => {
    const owner = await setup();
    const client = await sampleClient(await register(owner));
    const tokens = await client.connect(owner, { scope: "files:read" });

    // Scope escalation: comments was never granted, though the client may ask for it.
    const wider = await client.refresh(tokens.refresh_token, "files:read comments");
    expect(wider.status).toBe(400);
    expect(await wider.json()).toMatchObject({ error: "invalid_scope" });
    const unknown = await client.refresh(tokens.refresh_token, "files:read admin");
    expect(await unknown.json()).toMatchObject({ error: "invalid_scope" });

    // The refresh token was not spent by the refusals.
    const narrower = await client.refresh(tokens.refresh_token, "files:read");
    expect(narrower.status).toBe(200);
    const next = (await narrower.json()) as TokenResponse;
    expect(next.scope).toBe("files:read");

    // Asking the person for more than the client may ask for is refused before consent.
    const { params, state } = client.begin({ scope: "files:read downloads" });
    const { view } = await client.consent(owner, params);
    expect(view.refusal?.error).toBe("invalid_scope");
    expect(client.callback(view.refusal?.redirect ?? "", state).error).toBe("invalid_scope");
  });

  it("refuses a redirect address the client did not register, without sending anyone there", async () => {
    const owner = await setup();
    const registered = await register(owner);
    const client = await sampleClient(registered);
    const { params } = client.begin({ redirect_uri: "https://attacker.example/callback" });
    const { view, answer } = await client.consent(owner, params);
    expect(view.refusal).toMatchObject({ error: "invalid_request", redirect: null });
    expect(answer.refusal).toMatchObject({ redirect: null });
    expect(answer.redirect).toBeUndefined();
    expect(await db.select().from(schema.oauthCodes)).toHaveLength(0);

    // A code issued for the registered address cannot be exchanged for another.
    const good = client.begin();
    const consented = await client.consent(owner, good.params);
    const { code } = client.callback(consented.answer.redirect ?? "", good.state);
    const wrong = await client.exchange(
      code ?? "",
      good.verifier,
      "https://attacker.example/callback",
    );
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: "invalid_grant" });
    // And the code is spent by the attempt.
    expect((await client.exchange(code ?? "", good.verifier)).status).toBe(400);
  });

  it("holds a public client to PKCE, with no secret, and spends a code once", async () => {
    const owner = await setup();
    const registered = await register(owner, {
      name: "Hekate for Logic Pro",
      kind: "public",
      redirectUris: ["hekate-logic://callback", "http://127.0.0.1/callback"],
      scopes: ["files:write", "comments"],
    });
    expect(registered.secret).toBeNull();
    expect(registered.client.secretHint).toBeNull();
    // A desktop application listening on a port of its own.
    const client = await sampleClient(registered, "http://127.0.0.1:49152/callback");

    // Without the verifier, or with another, the exchange fails, and the code is spent.
    for (const verifier of [undefined, randomBytes(48).toString("base64url")]) {
      const { params, state } = client.begin({ scope: "comments" });
      const { answer } = await client.consent(owner, params);
      const { code } = client.callback(answer.redirect ?? "", state);
      const res = await client.exchange(code ?? "", verifier);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_grant" });
    }

    const { params, verifier, state } = client.begin({ scope: "comments" });
    const { answer, view } = await client.consent(owner, params);
    expect(view.request?.returnsTo).toBe("127.0.0.1:49152");
    const { code } = client.callback(answer.redirect ?? "", state);
    const res = await client.exchange(code ?? "", verifier);
    expect(res.status).toBe(200);
    const tokens = (await res.json()) as TokenResponse;
    // The same code again revokes what it gave (RFC 6749, section 4.1.2).
    const reused = await client.exchange(code ?? "", verifier);
    expect(reused.status).toBe(400);
    expect((await withToken(tokens.access_token, "/api/projects")).status).toBe(401);

    // A public client presenting a secret, or a confidential one without, is not authenticated.
    const asPublic = await app.request("/api/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: registered.client.clientId,
        client_secret: "hk_cls_guess",
      }).toString(),
    });
    expect(asPublic.status).toBe(401);
    expect(await asPublic.json()).toMatchObject({ error: "invalid_client" });
  });

  it("refuses a confidential client without its secret, and after its secret is rotated", async () => {
    const owner = await setup();
    const registered = await register(owner);
    const client = await sampleClient(registered);
    const tokens = await client.connect(owner);

    const noSecret = await app.request("/api/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: registered.client.clientId,
      }).toString(),
    });
    expect(noSecret.status).toBe(401);

    const rotated = await app.request(
      `/api/organisation/oauth-clients/${registered.client.id}/secret`,
      json({}, owner),
    );
    expect(rotated.status).toBe(200);
    const fresh = (await rotated.json()) as CreatedOAuthClient;
    expect(fresh.secret).not.toBe(registered.secret);
    expect(fresh.client.secretRotatedAt).not.toBeNull();

    const old = await client.refresh(tokens.refresh_token);
    expect(old.status).toBe(401);
    expect(old.headers.get("www-authenticate")).toContain("Basic");
    // Tokens already issued keep working; the new secret refreshes them.
    expect((await withToken(tokens.access_token, "/api/projects")).status).toBe(200);
    const renewed = await sampleClient({ ...registered, secret: fresh.secret });
    expect((await renewed.refresh(tokens.refresh_token)).status).toBe(200);
  });

  it("revokes an access token alone, or a refresh token with its connection's tokens", async () => {
    const owner = await setup();
    const client = await sampleClient(await register(owner));
    const one = await client.connect(owner);
    const two = await client.connect(owner);

    expect((await client.revoke(one.access_token)).status).toBe(200);
    expect((await withToken(one.access_token, "/api/projects")).status).toBe(401);
    expect((await withToken(two.access_token, "/api/projects")).status).toBe(200);

    expect((await client.revoke(two.refresh_token)).status).toBe(200);
    expect((await withToken(two.access_token, "/api/projects")).status).toBe(401);
    expect((await client.refresh(one.refresh_token)).status).toBe(400);
    // Unknown tokens are answered the same.
    expect((await client.revoke("hk_ort_nothing")).status).toBe(200);

    // Another client cannot revoke this one's tokens.
    const other = await sampleClient(await register(owner, { name: "Lantern Deliveries" }));
    const three = await client.connect(owner);
    expect((await other.revoke(three.access_token)).status).toBe(200);
    expect((await withToken(three.access_token, "/api/projects")).status).toBe(200);
  });

  it("sends a refusal back as access_denied, with nothing granted", async () => {
    const owner = await setup();
    const client = await sampleClient(await register(owner));
    const { params, state } = client.begin();
    const { answer } = await client.consent(owner, params, false);
    expect(client.callback(answer.redirect ?? "", state)).toEqual({
      code: null,
      error: "access_denied",
    });
    expect(await db.select().from(schema.oauthGrants)).toHaveLength(0);
  });

  it("lists connected apps in Account, and Disconnect stops every token", async () => {
    const owner = await setup();
    const member = await joinAs(owner, "tomas@endlesshall.example", "member");
    const registered = await register(owner);
    const client = await sampleClient(registered);
    const mine = await client.connect(owner);
    const theirs = await client.connect(member, { scope: "reviews:read" });
    // Granted reviews alone, it reads no files.
    expect((await withToken(theirs.access_token, "/api/projects")).status).toBe(403);

    const listed = await app.request("/api/me/connected-apps", { headers: { cookie: member } });
    const { apps } = (await listed.json()) as { apps: ConnectedAppRow[] };
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ name: "Hekate for Slack", scopes: ["reviews:read"] });

    // Who has connected, for the workspace's admins alone.
    const who = await app.request(
      `/api/organisation/oauth-clients/${registered.client.id}/connections`,
      { headers: { cookie: owner } },
    );
    const { connections } = (await who.json()) as { connections: OAuthConnectionRow[] };
    expect(connections.map((c) => c.name).sort()).toEqual(["Mira Solberg", "Tomas Varga"]);
    expect(
      (
        await app.request(`/api/organisation/oauth-clients/${registered.client.id}/connections`, {
          headers: { cookie: member },
        })
      ).status,
    ).toBe(403);
    const clients = (await (
      await app.request("/api/organisation/oauth-clients", { headers: { cookie: owner } })
    ).json()) as { clients: OAuthClientRow[] };
    expect(clients.clients[0]?.connected).toBe(2);

    // Someone else's connection is not theirs to end.
    const ownersApps = (await (
      await app.request("/api/me/connected-apps", { headers: { cookie: owner } })
    ).json()) as { apps: ConnectedAppRow[] };
    const ownersApp = ownersApps.apps[0]?.id ?? "";
    expect(
      (
        await app.request(`/api/me/connected-apps/${ownersApp}`, {
          method: "DELETE",
          headers: { cookie: member, origin: ISSUER },
        })
      ).status,
    ).toBe(404);

    const gone = await app.request(`/api/me/connected-apps/${apps[0]?.id}`, {
      method: "DELETE",
      headers: { cookie: member, origin: ISSUER },
    });
    expect(gone.status).toBe(204);
    expect((await withToken(theirs.access_token, "/api/me/connected-apps")).status).toBe(401);
    expect((await client.refresh(theirs.refresh_token)).status).toBe(400);
    expect((await withToken(mine.access_token, "/api/projects")).status).toBe(200);
    const disconnects = await db
      .select()
      .from(schema.accessEvents)
      .where(eq(schema.accessEvents.action, "oauth.disconnect"));
    expect(disconnects).toHaveLength(1);
  });

  it("lets owners and admins alone register clients, in their own workspace", async () => {
    const owner = await setup();
    const member = await joinAs(owner, "tomas@endlesshall.example", "member");
    const input = {
      name: "Mastering handoff",
      kind: "confidential",
      redirectUris: ["https://mastering.example/callback"],
      scopes: ["files:read"],
    };
    expect((await app.request("/api/organisation/oauth-clients", json(input, member))).status).toBe(
      403,
    );
    // Addresses that could run, or read, something here are refused.
    for (const bad of [
      "javascript:alert(1)",
      "http://mastering.example/callback",
      "https://mastering.example/callback#x",
      "callback",
    ])
      expect(
        (
          await app.request(
            "/api/organisation/oauth-clients",
            json({ ...input, redirectUris: [bad] }, owner),
          )
        ).status,
        bad,
      ).toBe(400);

    const made = await register(owner, input);
    // Another workspace's admin sees none of it, and can change none of it.
    const [other] = await db
      .insert(schema.organisations)
      .values({ name: "Lantern Pictures", slug: "lantern" })
      .returning();
    const [tomas] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, "tomas@endlesshall.example"));
    await db
      .insert(schema.members)
      .values({ organisationId: other?.id ?? "", userId: tomas?.id ?? "", role: "owner" });
    await app.request("/api/me/organisation", json({ organisationId: other?.id }, member, "PUT"));
    const theirs = (await (
      await app.request("/api/organisation/oauth-clients", { headers: { cookie: member } })
    ).json()) as { clients: OAuthClientRow[] };
    expect(theirs.clients).toEqual([]);
    for (const [method, path] of [
      ["PATCH", `/api/organisation/oauth-clients/${made.client.id}`],
      ["POST", `/api/organisation/oauth-clients/${made.client.id}/secret`],
      ["GET", `/api/organisation/oauth-clients/${made.client.id}/connections`],
      ["DELETE", `/api/organisation/oauth-clients/${made.client.id}`],
    ] as const)
      expect(
        (
          await app.request(
            path,
            method === "GET"
              ? { headers: { cookie: member } }
              : json({ name: "Taken" }, member, method),
          )
        ).status,
        `${method} ${path}`,
      ).toBe(404);
    expect(await db.select().from(schema.oauthClients)).toHaveLength(1);
  });

  it("refuses someone who is not a member of the client's workspace on the consent screen", async () => {
    const owner = await setup();
    const registered = await register(owner);
    // Tomas signs in, then belongs to Lantern Pictures alone.
    const member = await joinAs(owner, "tomas@endlesshall.example", "member");
    const [other] = await db
      .insert(schema.organisations)
      .values({ name: "Lantern Pictures", slug: "lantern" })
      .returning();
    const [tomas] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, "tomas@endlesshall.example"));
    await db.delete(schema.members).where(eq(schema.members.userId, tomas?.id ?? ""));
    await db
      .insert(schema.members)
      .values({ organisationId: other?.id ?? "", userId: tomas?.id ?? "", role: "owner" });

    const client = await sampleClient(registered);
    const { params } = client.begin();
    const { shown, status } = await client.consent(member, params);
    expect(shown).toBe(403);
    expect(status).toBe(403);
    expect(await db.select().from(schema.oauthCodes)).toHaveLength(0);
    // Signed out, nothing is shown.
    expect(
      (await app.request(`/api/oauth/authorize?${new URLSearchParams(params).toString()}`)).status,
    ).toBe(401);
  });

  it("ends a member's connections when they leave, and a client's when it is deleted", async () => {
    const owner = await setup();
    const member = await joinAs(owner, "tomas@endlesshall.example", "member");
    const registered = await register(owner);
    const client = await sampleClient(registered);
    const mine = await client.connect(owner);
    const theirs = await client.connect(member);

    const members = (await (
      await app.request("/api/organisation/members", { headers: { cookie: owner } })
    ).json()) as { members: { id: string; email: string }[] };
    const tomas = members.members.find((m) => m.email === "tomas@endlesshall.example");
    const removed = await app.request(`/api/organisation/members/${tomas?.id}`, {
      method: "DELETE",
      headers: { cookie: owner, origin: ISSUER },
    });
    expect(removed.status).toBe(204);
    expect((await withToken(theirs.access_token, "/api/projects")).status).toBe(401);
    expect((await client.refresh(theirs.refresh_token)).status).toBe(400);
    expect(await db.select().from(schema.oauthGrants)).toHaveLength(1);

    // Narrowing the client's scopes narrows live tokens at once.
    const narrowed = await app.request(
      `/api/organisation/oauth-clients/${registered.client.id}`,
      json({ scopes: ["comments"] }, owner, "PATCH"),
    );
    expect(narrowed.status).toBe(200);
    expect((await withToken(mine.access_token, "/api/projects")).status).toBe(403);

    const deleted = await app.request(`/api/organisation/oauth-clients/${registered.client.id}`, {
      method: "DELETE",
      headers: { cookie: owner, origin: ISSUER },
    });
    expect(deleted.status).toBe(204);
    expect((await withToken(mine.access_token, "/api/projects")).status).toBe(401);
    expect(await db.select().from(schema.oauthGrants)).toHaveLength(0);
    expect(await db.select().from(schema.oauthRefreshTokens)).toHaveLength(0);
    const events = await db
      .select({ action: schema.accessEvents.action })
      .from(schema.accessEvents);
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining(["oauth_client.create", "oauth_client.change", "oauth_client.delete"]),
    );
  });

  it("purges what can no longer mean anything", async () => {
    const owner = await setup();
    const client = await sampleClient(await register(owner));
    await client.connect(owner);
    const later = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
    await purgeOAuth(db, later);
    expect(await db.select().from(schema.oauthCodes)).toHaveLength(0);
    expect(await db.select().from(schema.oauthRefreshTokens)).toHaveLength(0);
    expect(
      await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.kind, "oauth")),
    ).toHaveLength(0);
    // The connection itself stays until the person disconnects it.
    expect(await db.select().from(schema.oauthGrants)).toHaveLength(1);
  });
});

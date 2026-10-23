import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type Database, inOrg, schema } from "@hekate/db";
import {
  type ApiScope,
  type AuthorizeParams,
  type AuthorizeRefusal,
  OAUTH_ACCESS_SECONDS,
  OAUTH_CLIENT_ID_PATTERN,
  OAUTH_CODE_SECONDS,
  OAUTH_REFRESH_SECONDS,
  type OAuthClientKind,
  type OAuthClientRow,
  oauthHint,
  oauthPrefixes,
  PKCE_CHALLENGE_PATTERN,
  PKCE_VERIFIER_PATTERN,
  parseScope,
  redirectMatches,
  scopeString,
  scopesWithin,
  type TokenResponse,
} from "@hekate/shared";
import { eq, inArray, isNull, lt, or } from "drizzle-orm";
import { hashApiToken, newApiToken } from "./api-tokens.ts";

/**
 * OAuth 2.1 (#447, decision 225): the authorisation code flow with PKCE for confidential and
 * public clients, refresh tokens used once, and revocation. An application's access token is an
 * API token of the `oauth` kind, so the middleware that takes members' tokens takes it too:
 * the same scopes, limits and API log. Every credential is stored only as a hash.
 */

const { apiTokens, oauthClients, oauthCodes, oauthGrants, oauthRefreshTokens, organisations } =
  schema;

/** A credential's hash, as API tokens are hashed: each is 32 random bytes, found by its hash. */
const credentialHash = hashApiToken;

/** Two hashes compared in constant time. */
export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

const secretOf = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`;

/** A new client's id, and for a confidential one its secret (shown once) and the hash kept. */
export function newClientCredentials(kind: OAuthClientKind) {
  const clientId = `${oauthPrefixes.clientId}${randomBytes(16).toString("base64url")}`;
  return { clientId, ...(kind === "confidential" ? newClientSecret() : { secret: null }) };
}

export function newClientSecret() {
  const secret = secretOf(oauthPrefixes.clientSecret);
  return { secret, secretHash: credentialHash(secret), secretHint: oauthHint(secret) };
}

/** The PKCE challenge of a verifier (S256): its SHA-256 in base64url. */
export const pkceChallenge = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

/** Whether a code verifier answers the challenge it was issued under. */
export function pkceVerifies(verifier: string | undefined, challenge: string): boolean {
  if (!verifier || !PKCE_VERIFIER_PATTERN.test(verifier)) return false;
  const made = Buffer.from(pkceChallenge(verifier));
  const held = Buffer.from(challenge);
  return made.length === held.length && timingSafeEqual(made, held);
}

/** An address with parameters added, kept as it was otherwise (an application's own scheme too). */
export function withParams(uri: string, params: Record<string, string | undefined>): string {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}

/** Where an answer goes, as the consent screen names it: a host, or an application's scheme. */
export function returnsTo(uri: string): string {
  const url = new URL(uri);
  return url.protocol === "https:" || url.protocol === "http:"
    ? url.host
    : `${url.protocol}//${url.host}`;
}

export type ClientRecord = typeof oauthClients.$inferSelect;

/** A request the consent screen may show, with what was checked of it. */
export interface CheckedAuthorize {
  client: ClientRecord;
  redirectUri: string;
  scopes: ApiScope[];
  challenge: string;
  state: string | undefined;
}

/**
 * An authorisation request checked as OAuth 2.1 asks, in its order. A client that is not
 * registered, or a redirect address it did not register, is refused on the screen and never
 * sent anywhere (it could be anyone's address); anything else wrong is sent back to the
 * application. PKCE is required of every client, with S256 alone. Without a scope, the
 * client's own are asked for. A pure function of the client and the request.
 */
export function checkAuthorize(
  client: ClientRecord | null,
  params: AuthorizeParams,
  issuer: string,
): CheckedAuthorize | AuthorizeRefusal {
  if (!client)
    return {
      error: "invalid_request",
      description: "That application is not registered here.",
      redirect: null,
    };
  const redirectUri = params.redirect_uri;
  if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri))
    return {
      error: "invalid_request",
      description: `${client.name} asked to be sent back to an address it has not registered.`,
      redirect: null,
    };
  const back = (error: string, description: string): AuthorizeRefusal => ({
    error,
    description,
    redirect: withParams(redirectUri, {
      error,
      error_description: description,
      state: params.state,
      iss: issuer,
    }),
  });
  if (params.response_type !== "code")
    return back("unsupported_response_type", "Only the authorisation code flow is supported.");
  if (!params.code_challenge)
    return back("invalid_request", "PKCE is required: send a code_challenge.");
  if (params.code_challenge_method !== "S256")
    return back("invalid_request", "The code challenge method must be S256.");
  if (!PKCE_CHALLENGE_PATTERN.test(params.code_challenge))
    return back("invalid_request", "That code challenge is not an S256 challenge.");
  const scopes = params.scope === undefined ? client.scopes : parseScope(params.scope);
  if (!scopes) return back("invalid_scope", "One of the scopes asked for is not a scope.");
  if (!scopesWithin(scopes, client.scopes))
    return back("invalid_scope", "The application asked for more than it may ask for.");
  return { client, redirectUri, scopes, challenge: params.code_challenge, state: params.state };
}

/** A client by the id an application sends: public, unique on the instance, and naming its workspace. */
export async function clientByClientId(
  db: Database,
  clientId: string | undefined,
): Promise<ClientRecord | null> {
  if (!clientId || !OAUTH_CLIENT_ID_PATTERN.test(clientId)) return null;
  // The one lookup without a workspace: the client id is what names it.
  const [row] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId));
  return row ?? null;
}

/** A client as settings show it, with whoever made it named and how many have it connected. */
export const clientRowOf = (
  row: ClientRecord,
  createdBy: string | null,
  connected: number,
): OAuthClientRow => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  clientId: row.clientId,
  secretHint: row.secretHint,
  redirectUris: row.redirectUris,
  scopes: row.scopes,
  createdAt: row.createdAt.toISOString(),
  createdBy,
  secretRotatedAt: row.secretRotatedAt?.toISOString() ?? null,
  connected,
});

/** An error the token and revocation endpoints answer (RFC 6749 section 5.2). */
export interface OAuthError {
  error:
    | "invalid_request"
    | "invalid_client"
    | "invalid_grant"
    | "unauthorized_client"
    | "unsupported_grant_type"
    | "invalid_scope";
  description: string;
}

/**
 * The client a token or revocation request comes from, by its credentials: a Basic header or
 * the body, never both. A confidential client must give its secret; a public client has none
 * to give.
 */
export async function authenticateClient(
  db: Database,
  header: string | undefined,
  body: { client_id?: string | undefined; client_secret?: string | undefined },
): Promise<{ client: ClientRecord } | (OAuthError & { basic: boolean })> {
  let clientId = body.client_id;
  let secret = body.client_secret;
  const basic = header ? /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header.trim()) : null;
  if (basic?.[1]) {
    if (body.client_secret !== undefined)
      return {
        error: "invalid_request",
        description: "Send the client's credentials one way, not two.",
        basic: true,
      };
    const decoded = Buffer.from(basic[1], "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon < 0)
      return { error: "invalid_client", description: "That client is not known.", basic: true };
    // Form-encoded first (RFC 6749 section 2.3.1).
    const unform = (s: string) => {
      try {
        return decodeURIComponent(s.replace(/\+/g, " "));
      } catch {
        return "";
      }
    };
    const fromHeader = unform(decoded.slice(0, colon));
    if (clientId !== undefined && clientId !== fromHeader)
      return {
        error: "invalid_request",
        description: "The client named in the body is not the one authenticated.",
        basic: true,
      };
    clientId = fromHeader;
    secret = unform(decoded.slice(colon + 1)) || undefined;
  }
  const refused = {
    error: "invalid_client" as const,
    description: "That client is not known, or its secret is wrong.",
    basic: Boolean(basic),
  };
  const client = await clientByClientId(db, clientId);
  if (!client) return refused;
  if (client.kind === "public") return secret === undefined ? { client } : refused;
  if (!secret || !client.secretHash || !sameHash(credentialHash(secret), client.secretHash))
    return refused;
  return { client };
}

/** The scopes three lists have in common, in settings' order. */
const common = (...lists: (readonly ApiScope[])[]) =>
  (lists[0] ?? []).filter((s) => lists.every((l) => l.includes(s)));

/** Every token of a connection stops working: its application must ask again. */
export async function endGrantTokens(
  db: Pick<Database, "update">,
  organisationId: string,
  grantIds: string[],
  now = new Date(),
) {
  if (grantIds.length === 0) return;
  await db
    .update(apiTokens)
    .set({ revokedAt: now })
    .where(
      inOrg(
        apiTokens,
        organisationId,
        eq(apiTokens.kind, "oauth"),
        inArray(apiTokens.grantId, grantIds),
        isNull(apiTokens.revokedAt),
      ),
    );
  await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: now })
    .where(
      inOrg(
        oauthRefreshTokens,
        organisationId,
        inArray(oauthRefreshTokens.grantId, grantIds),
        isNull(oauthRefreshTokens.revokedAt),
      ),
    );
}

type GrantRecord = typeof oauthGrants.$inferSelect;

/** Whether the connection's member is still in the workspace, and the workspace open. */
async function grantStands(db: Database, grant: GrantRecord): Promise<boolean> {
  const [row] = await db
    .select({ suspendedAt: organisations.suspendedAt, role: schema.members.role })
    .from(organisations)
    .leftJoin(
      schema.members,
      inOrg(schema.members, grant.organisationId, eq(schema.members.userId, grant.userId)),
    )
    .where(eq(organisations.id, grant.organisationId));
  return Boolean(row?.role) && !row?.suspendedAt;
}

/** An access token and a refresh token for a connection, as the token endpoint answers them. */
async function issueTokens(
  db: Database,
  client: ClientRecord,
  grant: GrantRecord,
  scopes: ApiScope[],
  refreshScopes: ApiScope[],
  now = new Date(),
): Promise<TokenResponse> {
  const access = newApiToken("oauth");
  const refresh = secretOf(oauthPrefixes.refreshToken);
  const [user] = await db
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, grant.userId));
  await db.transaction(async (tx) => {
    await tx.insert(apiTokens).values({
      organisationId: grant.organisationId,
      kind: "oauth",
      userId: grant.userId,
      // The application and whom it acts for, as the API log names its calls.
      name: `${client.name} · ${user?.name ?? "member"}`.slice(0, 160),
      hint: access.hint,
      tokenHash: access.hash,
      scopes,
      expiresAt: new Date(now.getTime() + OAUTH_ACCESS_SECONDS * 1000),
      createdBy: grant.userId,
      grantId: grant.id,
    });
    await tx.insert(oauthRefreshTokens).values({
      organisationId: grant.organisationId,
      grantId: grant.id,
      tokenHash: credentialHash(refresh),
      scopes: refreshScopes,
      expiresAt: new Date(now.getTime() + OAUTH_REFRESH_SECONDS * 1000),
    });
  });
  return {
    access_token: access.secret,
    token_type: "Bearer",
    expires_in: OAUTH_ACCESS_SECONDS,
    refresh_token: refresh,
    scope: scopeString(scopes),
  };
}

const invalidGrant = (description: string): OAuthError => ({
  error: "invalid_grant",
  description,
});

/**
 * An authorisation code exchanged for tokens. The code is spent before anything else is
 * checked, so a wrong verifier or address cannot be tried twice; a code spent already revokes
 * what its connection holds, as the first use may have been someone else's (RFC 6749 section
 * 4.1.2).
 */
export async function exchangeCode(
  db: Database,
  client: ClientRecord,
  input: { code: string; redirect_uri: string; code_verifier?: string | undefined },
  now = new Date(),
): Promise<TokenResponse | OAuthError> {
  const org = client.organisationId;
  const [found] = await db
    .select({ code: oauthCodes, grant: oauthGrants })
    .from(oauthCodes)
    .innerJoin(oauthGrants, inOrg(oauthGrants, org, eq(oauthGrants.id, oauthCodes.grantId)))
    .where(
      inOrg(
        oauthCodes,
        org,
        eq(oauthCodes.codeHash, credentialHash(input.code)),
        eq(oauthGrants.clientId, client.id),
      ),
    );
  if (!found) return invalidGrant("That code is not known.");
  const [spent] = await db
    .update(oauthCodes)
    .set({ usedAt: now })
    .where(inOrg(oauthCodes, org, eq(oauthCodes.id, found.code.id), isNull(oauthCodes.usedAt)))
    .returning({ id: oauthCodes.id });
  if (!spent) {
    await endGrantTokens(db, org, [found.grant.id], now);
    return invalidGrant("That code was used already.");
  }
  if (found.code.expiresAt <= now) return invalidGrant("That code has expired.");
  if (input.redirect_uri !== found.code.redirectUri)
    return invalidGrant("The redirect address is not the one the code was issued for.");
  if (!redirectMatches(client.redirectUris, found.code.redirectUri))
    return invalidGrant("The redirect address is no longer registered.");
  if (!pkceVerifies(input.code_verifier, found.code.codeChallenge))
    return invalidGrant("The code verifier does not match the code challenge.");
  if (!(await grantStands(db, found.grant)))
    return invalidGrant("The member is no longer in the workspace, or it is suspended.");
  const scopes = common(found.code.scopes, client.scopes, found.grant.scopes);
  if (scopes.length === 0) return invalidGrant("Nothing granted remains.");
  return issueTokens(db, client, found.grant, scopes, scopes, now);
}

/**
 * A refresh token exchanged for new tokens. Each is used once: the answer carries the next. One
 * used again revokes every token of its connection (OAuth 2.1, section 4.3.1). A narrower scope
 * may be asked for the access token; a wider one is refused, and spends nothing.
 */
export async function refreshTokens(
  db: Database,
  client: ClientRecord,
  input: { refresh_token: string; scope?: string | undefined },
  now = new Date(),
): Promise<TokenResponse | OAuthError> {
  const org = client.organisationId;
  const [found] = await db
    .select({ token: oauthRefreshTokens, grant: oauthGrants })
    .from(oauthRefreshTokens)
    .innerJoin(oauthGrants, inOrg(oauthGrants, org, eq(oauthGrants.id, oauthRefreshTokens.grantId)))
    .where(
      inOrg(
        oauthRefreshTokens,
        org,
        eq(oauthRefreshTokens.tokenHash, credentialHash(input.refresh_token)),
        eq(oauthGrants.clientId, client.id),
      ),
    );
  if (!found) return invalidGrant("That refresh token is not known.");
  if (found.token.revokedAt) return invalidGrant("That refresh token was revoked.");
  if (found.token.expiresAt <= now) return invalidGrant("That refresh token has expired.");
  const held = common(found.token.scopes, client.scopes, found.grant.scopes);
  let scopes = held;
  if (input.scope !== undefined) {
    const asked = parseScope(input.scope);
    if (!asked) return { error: "invalid_scope", description: "One of those is not a scope." };
    if (!scopesWithin(asked, found.token.scopes))
      return {
        error: "invalid_scope",
        description: "A refresh cannot widen what was granted.",
      };
    scopes = common(asked, held);
  }
  if (scopes.length === 0)
    return { error: "invalid_scope", description: "Nothing granted remains." };
  if (!(await grantStands(db, found.grant)))
    return invalidGrant("The member is no longer in the workspace, or it is suspended.");
  const [spent] = await db
    .update(oauthRefreshTokens)
    .set({ usedAt: now })
    .where(
      inOrg(
        oauthRefreshTokens,
        org,
        eq(oauthRefreshTokens.id, found.token.id),
        isNull(oauthRefreshTokens.usedAt),
        isNull(oauthRefreshTokens.revokedAt),
      ),
    )
    .returning({ id: oauthRefreshTokens.id });
  if (!spent) {
    await endGrantTokens(db, org, [found.grant.id], now);
    return invalidGrant("That refresh token was used already.");
  }
  return issueTokens(db, client, found.grant, scopes, held, now);
}

/**
 * A token revoked by its client (RFC 7009): an access token alone, or a refresh token with
 * every token of its connection. Unknown tokens, and another client's, are answered the same.
 */
export async function revokeToken(
  db: Database,
  client: ClientRecord,
  token: string,
  now = new Date(),
): Promise<void> {
  const org = client.organisationId;
  if (token.startsWith(oauthPrefixes.accessToken)) {
    const [found] = await db
      .select({ id: apiTokens.id })
      .from(apiTokens)
      .innerJoin(oauthGrants, inOrg(oauthGrants, org, eq(oauthGrants.id, apiTokens.grantId)))
      .where(
        inOrg(
          apiTokens,
          org,
          eq(apiTokens.tokenHash, hashApiToken(token)),
          eq(apiTokens.kind, "oauth"),
          eq(oauthGrants.clientId, client.id),
        ),
      );
    if (found)
      await db
        .update(apiTokens)
        .set({ revokedAt: now })
        .where(inOrg(apiTokens, org, eq(apiTokens.id, found.id), isNull(apiTokens.revokedAt)));
    return;
  }
  if (token.startsWith(oauthPrefixes.refreshToken)) {
    const [found] = await db
      .select({ grantId: oauthRefreshTokens.grantId })
      .from(oauthRefreshTokens)
      .innerJoin(
        oauthGrants,
        inOrg(oauthGrants, org, eq(oauthGrants.id, oauthRefreshTokens.grantId)),
      )
      .where(
        inOrg(
          oauthRefreshTokens,
          org,
          eq(oauthRefreshTokens.tokenHash, credentialHash(token)),
          eq(oauthGrants.clientId, client.id),
        ),
      );
    if (found) await endGrantTokens(db, org, [found.grantId], now);
  }
}

/** A connection's code: issued as the member approves, spent at the token endpoint. */
export async function issueCode(
  db: Pick<Database, "insert">,
  grant: { id: string; organisationId: string },
  checked: { redirectUri: string; scopes: ApiScope[]; challenge: string },
  now = new Date(),
): Promise<string> {
  const code = secretOf(oauthPrefixes.code);
  await db.insert(oauthCodes).values({
    organisationId: grant.organisationId,
    grantId: grant.id,
    codeHash: credentialHash(code),
    redirectUri: checked.redirectUri,
    scopes: checked.scopes,
    codeChallenge: checked.challenge,
    expiresAt: new Date(now.getTime() + OAUTH_CODE_SECONDS * 1000),
  });
  return code;
}

/**
 * A client allowed fewer scopes: what its connections granted, their live tokens and their
 * refresh tokens lose the rest at once, and a token left with nothing is revoked.
 */
export async function narrowClient(
  db: Pick<Database, "select" | "update">,
  organisationId: string,
  clientId: string,
  allowed: readonly ApiScope[],
  now = new Date(),
) {
  const grants = await db
    .select()
    .from(oauthGrants)
    .where(inOrg(oauthGrants, organisationId, eq(oauthGrants.clientId, clientId)));
  const ids = grants.map((g) => g.id);
  for (const g of grants)
    await db
      .update(oauthGrants)
      .set({ scopes: common(g.scopes, allowed), updatedAt: now })
      .where(inOrg(oauthGrants, organisationId, eq(oauthGrants.id, g.id)));
  if (ids.length === 0) return;
  const tokens = await db
    .select({ id: apiTokens.id, scopes: apiTokens.scopes })
    .from(apiTokens)
    .where(
      inOrg(
        apiTokens,
        organisationId,
        eq(apiTokens.kind, "oauth"),
        inArray(apiTokens.grantId, ids),
        isNull(apiTokens.revokedAt),
      ),
    );
  for (const t of tokens) {
    const left = common(t.scopes, allowed);
    await db
      .update(apiTokens)
      .set(left.length > 0 ? { scopes: left } : { scopes: t.scopes, revokedAt: now })
      .where(inOrg(apiTokens, organisationId, eq(apiTokens.id, t.id)));
  }
  const refreshes = await db
    .select({ id: oauthRefreshTokens.id, scopes: oauthRefreshTokens.scopes })
    .from(oauthRefreshTokens)
    .where(
      inOrg(
        oauthRefreshTokens,
        organisationId,
        inArray(oauthRefreshTokens.grantId, ids),
        isNull(oauthRefreshTokens.revokedAt),
      ),
    );
  for (const r of refreshes) {
    const left = common(r.scopes, allowed);
    await db
      .update(oauthRefreshTokens)
      .set(left.length > 0 ? { scopes: left } : { revokedAt: now })
      .where(inOrg(oauthRefreshTokens, organisationId, eq(oauthRefreshTokens.id, r.id)));
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What OAuth leaves behind, gone once it can mean nothing: codes a day after they ran out,
 * refresh tokens once they have (a used one is kept until then, to tell a replay), and access
 * tokens thirty days after, as the API log is kept by default. Workspace by workspace.
 */
export async function purgeOAuth(db: Database, now = new Date()) {
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const monthAgo = new Date(now.getTime() - 30 * DAY_MS);
  for (const { id } of await db.select({ id: organisations.id }).from(organisations)) {
    await db.delete(oauthCodes).where(inOrg(oauthCodes, id, lt(oauthCodes.expiresAt, dayAgo)));
    await db
      .delete(oauthRefreshTokens)
      .where(inOrg(oauthRefreshTokens, id, lt(oauthRefreshTokens.expiresAt, now)));
    await db
      .delete(apiTokens)
      .where(
        inOrg(
          apiTokens,
          id,
          eq(apiTokens.kind, "oauth"),
          or(lt(apiTokens.expiresAt, monthAgo), lt(apiTokens.revokedAt, monthAgo)),
        ),
      );
  }
}

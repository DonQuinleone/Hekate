import { randomBytes, scryptSync } from "node:crypto";
import { type Database, inOrg, schema } from "@hekate/db";
import {
  API_TOKEN_PATTERN,
  API_TOKEN_RATE,
  type ApiScope,
  type ApiTokenKind,
  type ApiTokenRow,
  apiScopeLabels,
  apiTokenHint,
  apiTokenPrefixes,
  type OrganisationRole,
  SERVICE_ACCOUNT_DOMAIN,
  scopeAllows,
  scopeFor,
} from "@hekate/shared";
import { and, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { getPath } from "hono/utils/url";
import { requestInfo } from "./audit.ts";
import type { ApiError } from "./errors.ts";
import { pinnedWorkspace } from "./hosts.ts";
import { admit } from "./rate-limit.ts";

const { apiTokens, apiRequests, members, organisations, users } = schema;

/** A new token, the hash stored in its place, and its hint. The token is shown once. */
export function newApiToken(kind: ApiTokenKind) {
  const token = `${apiTokenPrefixes[kind]}${randomBytes(32).toString("base64url")}`;
  return { secret: token, hash: hashApiToken(token), hint: apiTokenHint(token) };
}

/**
 * A token's hash, all the database keeps: scrypt at a low cost, with one salt for every token so
 * a token can be found by its hash. A token is 256 random bits, not a password a person chose,
 * so a high cost would protect nothing and slow every call; this one takes about a millisecond.
 */
export const hashApiToken = (token: string) =>
  scryptSync(token, "hekate-api-token", 32, { N: 1024, r: 8, p: 1 }).toString("hex");

/** A token as settings show it, with whoever made it named. */
export const apiTokenRowOf = (
  row: typeof apiTokens.$inferSelect,
  createdBy: string | null,
): ApiTokenRow => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  hint: row.hint,
  scopes: row.scopes,
  createdAt: row.createdAt.toISOString(),
  createdBy,
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  expiresAt: row.expiresAt?.toISOString() ?? null,
});

/** What a request made with a token carries: who it acts as, where, and what it may do. */
export interface ApiTokenContext {
  id: string;
  kind: ApiTokenKind;
  name: string;
  organisationId: string;
  userId: string;
  /** The member's role now, for a member's own; a service token acts as an admin. */
  role: OrganisationRole;
  scopes: ApiScope[];
}

/** The role a service token acts with: it may do what an admin may, within its scopes. */
export const SERVICE_TOKEN_ROLE: OrganisationRole = "admin";

/** `Authorization: Bearer hk_…`: the token a request carries, or none. */
export function bearerOf(c: Context): string | null {
  const header = c.req.header("authorization");
  const match = header ? /^Bearer\s+(hk_\S*)$/i.exec(header.trim()) : null;
  return match?.[1] ?? null;
}

/**
 * The token behind a secret, if it still works: not revoked, not past its time, its workspace
 * not suspended, and (for a member's own) its member still in the workspace, with their role
 * now. Found by its hash alone: the token is the credential, and names its workspace.
 */
export async function liveToken(
  db: Database,
  secret: string,
  now = new Date(),
): Promise<ApiTokenContext | null> {
  if (!API_TOKEN_PATTERN.test(secret)) return null;
  const [row] = await db
    .select({
      id: apiTokens.id,
      kind: apiTokens.kind,
      name: apiTokens.name,
      organisationId: apiTokens.organisationId,
      userId: apiTokens.userId,
      scopes: apiTokens.scopes,
      role: members.role,
    })
    .from(apiTokens)
    .innerJoin(organisations, eq(organisations.id, apiTokens.organisationId))
    .leftJoin(
      members,
      and(
        eq(members.organisationId, apiTokens.organisationId),
        eq(members.userId, apiTokens.userId),
      ),
    )
    .where(
      and(
        eq(apiTokens.tokenHash, hashApiToken(secret)),
        isNull(apiTokens.revokedAt),
        or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now)),
      ),
    );
  if (!row) return null;
  const role = row.kind === "service" ? SERVICE_TOKEN_ROLE : row.role;
  if (!role) return null;
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    organisationId: row.organisationId,
    userId: row.userId,
    role,
    scopes: row.scopes,
  };
}

export interface TokenAuthDeps {
  db: Database;
  trustProxy: boolean;
}

const refuse = (c: Context, status: 401 | 403, code: string, message: string) => {
  if (status === 401) c.header("WWW-Authenticate", `Bearer error="invalid_token"`);
  return c.json<ApiError>({ error: { code, message } }, status);
};

/**
 * Lets a request in on an API token (`Authorization: Bearer hk_…`), before anything else reads
 * who is asking. The token must still work and hold the scope the call needs (`scopeFor`); where
 * no token may go, or it lacks the scope, the call is refused before any route sees it. Each
 * call it makes is counted against its own limit (#172) and written to the API log, and the
 * token's last use is kept to the minute. A request without a token passes untouched; one with a
 * token never falls back to a session cookie it also carries.
 */
export const tokenAuth = (deps: TokenAuthDeps) =>
  createMiddleware<{ Variables: { apiToken?: ApiTokenContext } }>(async (c, next) => {
    const secret = bearerOf(c);
    if (secret === null) return next();
    const token = await liveToken(deps.db, secret);
    if (!token)
      return refuse(
        c,
        401,
        "token_invalid",
        "That API token does not work: it may have been revoked, or have expired.",
      );
    const started = performance.now();
    const respond = async (): Promise<Response | undefined> => {
      // A workspace's host (#176) takes only that workspace's tokens.
      const pinned = pinnedWorkspace(c);
      if (pinned && pinned.id !== token.organisationId)
        return refuse(c, 401, "token_invalid", "That API token is for another workspace.");
      const [workspace] = await deps.db
        .select({ suspendedAt: organisations.suspendedAt })
        .from(organisations)
        .where(eq(organisations.id, token.organisationId));
      if (workspace?.suspendedAt)
        return refuse(c, 403, "workspace_suspended", "This workspace is suspended.");
      const needed = scopeFor(c.req.method, c.req.path);
      if (!needed)
        return refuse(c, 403, "token_not_allowed", "An API token cannot be used for that.");
      if (!scopeAllows(token.scopes, needed))
        return refuse(
          c,
          403,
          "insufficient_scope",
          `That needs the ${needed} scope (${apiScopeLabels[needed].toLowerCase()}), which this token does not have.`,
        );
      const { allowed, retryAfter } = await admit(deps.db, `api-token:${token.id}`, API_TOKEN_RATE);
      if (!allowed) {
        c.header("Retry-After", String(retryAfter));
        return c.json<ApiError>(
          {
            error: {
              code: "rate_limited",
              message: "This token has made too many calls. Wait a moment and try again.",
            },
          },
          429,
        );
      }
      c.set("apiToken", token);
      await next();
      return undefined;
    };
    // Logged whatever came of it: a failure that escapes as one.
    let status = 500;
    try {
      const refused = await respond();
      status = refused?.status ?? c.res.status;
      return refused;
    } finally {
      await logCall(deps, c, token, status, started);
    }
  });

/** One call in the API log, and the token's last use to the minute. */
async function logCall(
  deps: TokenAuthDeps,
  c: Context,
  token: ApiTokenContext,
  status: number,
  started: number,
) {
  const now = new Date();
  await deps.db.insert(apiRequests).values({
    organisationId: token.organisationId,
    tokenId: token.id,
    tokenName: token.name,
    tokenKind: token.kind,
    method: c.req.method,
    // The path as asked, so the log shows the version a call used (decision 224).
    path: getPath(c.req.raw).slice(0, 500),
    status,
    durationMs: Math.round(performance.now() - started),
    ipAddress: requestInfo(c, deps.trustProxy).ipAddress ?? null,
  });
  await deps.db
    .update(apiTokens)
    .set({ lastUsedAt: now })
    .where(
      inOrg(
        apiTokens,
        token.organisationId,
        eq(apiTokens.id, token.id),
        or(
          isNull(apiTokens.lastUsedAt),
          lt(apiTokens.lastUsedAt, new Date(now.getTime() - 60_000)),
        ),
      ),
    );
}

/**
 * Every live token a member holds in a workspace stops working: they have left it. Their own
 * tokens, and their connected apps' (#447), whose connections go with them (and with those,
 * their codes and refresh tokens).
 */
export async function revokeMemberTokens(
  db: Pick<Database, "update" | "delete">,
  organisationId: string,
  userId: string,
  by: string | null,
) {
  await db
    .update(apiTokens)
    .set({ revokedAt: new Date(), revokedBy: by })
    .where(
      inOrg(
        apiTokens,
        organisationId,
        inArray(apiTokens.kind, ["personal", "oauth"]),
        eq(apiTokens.userId, userId),
        isNull(apiTokens.revokedAt),
      ),
    );
  await db
    .delete(schema.oauthGrants)
    .where(inOrg(schema.oauthGrants, organisationId, eq(schema.oauthGrants.userId, userId)));
}

/**
 * A service token's own account: who it acts as, so what it makes has an author. It belongs to
 * no workspace as a member and has no way to sign in; its address is reserved and goes nowhere.
 */
export async function createServiceAccount(
  db: Pick<Database, "insert">,
  id: string,
  name: string,
): Promise<string> {
  const userId = `svc_${id}`;
  await db.insert(users).values({
    id: userId,
    name,
    email: `${id}@${SERVICE_ACCOUNT_DOMAIN}`,
    emailVerified: false,
  });
  return userId;
}

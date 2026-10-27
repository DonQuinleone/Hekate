import { type Database, inOrg, schema, uuidv7 } from "@hekate/db";
import {
  type AuthorizeRefusal,
  type AuthorizeRequestView,
  apiScopes,
  authorizeDecision,
  authorizeParams,
  type ConnectedAppRow,
  createOAuthClientInput,
  OAUTH_CLIENT_LIMIT,
  type OAuthConnectionRow,
  revokeRequest,
  scopesWithin,
  tokenRequest,
  updateOAuthClientInput,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { count, desc, eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { type Audit, requestInfo } from "../audit.ts";
import { CodedException, NotFound } from "../errors.ts";
import { pinnedWorkspace } from "../hosts.ts";
import {
  authenticateClient,
  type CheckedAuthorize,
  type ClientRecord,
  checkAuthorize,
  clientByClientId,
  clientRowOf,
  endGrantTokens,
  exchangeCode,
  issueCode,
  narrowClient,
  newClientCredentials,
  newClientSecret,
  type OAuthError,
  refreshTokens,
  returnsTo,
  revokeToken,
  withParams,
} from "../oauth.ts";
import { rateLimit } from "../rate-limit.ts";
import {
  assertOpen,
  assertSecondFactor,
  assertSessionAllowed,
  assertSignedInThrough,
  membershipOf,
  requireRole,
  type SecondFactorRule,
  type SessionVariables,
  type TenantVariables,
} from "../tenancy.ts";

const { apiTokens, oauthClients, oauthGrants, organisations, users } = schema;

export interface OAuthDeps {
  db: Database;
  audit: Audit;
  trustProxy: boolean;
  /** The instance's address: the issuer, and where the endpoints are. */
  publicUrl: string;
  secondFactor: SecondFactorRule;
}

const idParam = zValidator("param", z.object({ id: z.uuid() }));

/** The issuer the metadata names and every authorisation response carries (RFC 9207). */
export const issuerOf = (publicUrl: string) => publicUrl.replace(/\/+$/, "");

/**
 * The authorisation server's metadata (RFC 8414), at `/.well-known/oauth-authorization-server`:
 * where an application sends people, and where it exchanges and revokes tokens.
 */
export function oauthMetadata(publicUrl: string) {
  const issuer = issuerOf(publicUrl);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/api/oauth/token`,
    revocation_endpoint: `${issuer}/api/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    revocation_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post",
      "none",
    ],
    scopes_supported: [...apiScopes],
    authorization_response_iss_parameter_supported: true,
  };
}

/** The last use of each connection's tokens: when its application last called. */
const lastUsed = sql<Date | null>`(select max(${apiTokens.lastUsedAt}) from ${apiTokens}
  where ${apiTokens.grantId} = ${oauthGrants.id}
  and ${apiTokens.organisationId} = ${oauthGrants.organisationId})`;

const iso = (value: Date | string | null) =>
  value === null ? null : new Date(value).toISOString();

/**
 * `/api/organisation/oauth-clients`: the workspace's OAuth clients, for its owners and admins.
 * Each lists, registers, changes (its name, redirect addresses and scopes; never its kind),
 * rotates its secret, shows who has it connected, and deletes one, which disconnects everyone.
 */
export function oauthClientRoutes(deps: OAuthDeps) {
  const { db, audit } = deps;
  const find = async (c: Context<{ Variables: TenantVariables }>, id: string) => {
    const [row] = await db
      .select()
      .from(oauthClients)
      .where(inOrg(oauthClients, c.var.organisationId, eq(oauthClients.id, id)));
    if (!row) throw new NotFound("Client");
    return row;
  };
  const connectedOf = (organisationId: string) =>
    sql<number>`(select count(*)::int from ${oauthGrants}
      where ${oauthGrants.clientId} = ${oauthClients.id}
      and ${oauthGrants.organisationId} = ${organisationId})`;
  const rowOf = async (organisationId: string, row: ClientRecord) => {
    const [made] = await db
      .select({ createdBy: users.name, connected: connectedOf(organisationId) })
      .from(oauthClients)
      .leftJoin(users, eq(users.id, oauthClients.createdBy))
      .where(inOrg(oauthClients, organisationId, eq(oauthClients.id, row.id)));
    return clientRowOf(row, made?.createdBy ?? null, Number(made?.connected ?? 0));
  };
  const record = async (
    c: Context<{ Variables: TenantVariables }>,
    action:
      | "oauth_client.create"
      | "oauth_client.change"
      | "oauth_client.rotate"
      | "oauth_client.delete",
    row: ClientRecord,
    into: Pick<Database, "insert"> = db,
  ) =>
    audit.record(
      c.var.organisationId,
      await audit.member(c.var.userId),
      {
        action,
        // Its name and public id, never its secret.
        details: {
          client: row.name,
          clientId: row.clientId,
          kind: row.kind,
          redirectUris: row.redirectUris,
          scopes: row.scopes,
        },
      },
      requestInfo(c, deps.trustProxy),
      into,
    );

  return new Hono<{ Variables: TenantVariables }>()
    .use("*", requireRole("admin"))
    .get("/", async (c) => {
      const rows = await db
        .select({
          client: oauthClients,
          createdBy: users.name,
          connected: connectedOf(c.var.organisationId),
        })
        .from(oauthClients)
        .leftJoin(users, eq(users.id, oauthClients.createdBy))
        .where(inOrg(oauthClients, c.var.organisationId))
        .orderBy(desc(oauthClients.createdAt));
      return c.json({
        clients: rows.map((r) => clientRowOf(r.client, r.createdBy, Number(r.connected))),
      });
    })
    .post("/", zValidator("json", createOAuthClientInput), async (c) => {
      const input = c.req.valid("json");
      const { clientId, secret, ...hashed } = newClientCredentials(input.kind);
      const row = await db.transaction(async (tx) => {
        // Counted under a lock on the workspace's row, so two at once cannot pass the limit.
        await tx
          .select({ id: organisations.id })
          .from(organisations)
          .where(eq(organisations.id, c.var.organisationId))
          .for("update");
        const [held] = await tx
          .select({ n: count() })
          .from(oauthClients)
          .where(inOrg(oauthClients, c.var.organisationId));
        if ((held?.n ?? 0) >= OAUTH_CLIENT_LIMIT)
          throw new CodedException(
            409,
            "client_limit",
            `A workspace can register at most ${OAUTH_CLIENT_LIMIT} clients. Delete one first.`,
          );
        const [made] = await tx
          .insert(oauthClients)
          .values({
            id: uuidv7(),
            organisationId: c.var.organisationId,
            name: input.name,
            kind: input.kind,
            clientId,
            secretHash: "secretHash" in hashed ? hashed.secretHash : null,
            secretHint: "secretHint" in hashed ? hashed.secretHint : null,
            redirectUris: input.redirectUris,
            scopes: input.scopes,
            createdBy: c.var.userId,
          })
          .returning();
        if (!made) throw new Error("The client was not saved");
        await record(c, "oauth_client.create", made, tx);
        return made;
      });
      return c.json({ client: await rowOf(c.var.organisationId, row), secret }, 201);
    })
    .patch("/:id", idParam, zValidator("json", updateOAuthClientInput), async (c) => {
      const input = c.req.valid("json");
      const before = await find(c, c.req.valid("param").id);
      const row = await db.transaction(async (tx) => {
        const [changed] = await tx
          .update(oauthClients)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.redirectUris !== undefined ? { redirectUris: input.redirectUris } : {}),
            ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
            updatedAt: new Date(),
          })
          .where(inOrg(oauthClients, c.var.organisationId, eq(oauthClients.id, before.id)))
          .returning();
        if (!changed) throw new NotFound("Client");
        // Fewer scopes: what was granted, and every live token, loses the rest at once.
        if (input.scopes !== undefined && !scopesWithin(before.scopes, input.scopes))
          await narrowClient(tx, c.var.organisationId, changed.id, input.scopes);
        await record(c, "oauth_client.change", changed, tx);
        return changed;
      });
      return c.json({ client: await rowOf(c.var.organisationId, row) });
    })
    .post("/:id/secret", idParam, async (c) => {
      const before = await find(c, c.req.valid("param").id);
      if (before.kind !== "confidential")
        throw new CodedException(
          409,
          "not_confidential",
          "A public client has no secret: it proves each exchange with PKCE.",
        );
      const { secret, secretHash, secretHint } = newClientSecret();
      const row = await db.transaction(async (tx) => {
        const [changed] = await tx
          .update(oauthClients)
          .set({ secretHash, secretHint, secretRotatedAt: new Date(), updatedAt: new Date() })
          .where(inOrg(oauthClients, c.var.organisationId, eq(oauthClients.id, before.id)))
          .returning();
        if (!changed) throw new NotFound("Client");
        await record(c, "oauth_client.rotate", changed, tx);
        return changed;
      });
      return c.json({ client: await rowOf(c.var.organisationId, row), secret });
    })
    .get("/:id/connections", idParam, async (c) => {
      const client = await find(c, c.req.valid("param").id);
      const rows = await db
        .select({
          id: oauthGrants.id,
          name: users.name,
          email: users.email,
          scopes: oauthGrants.scopes,
          connectedAt: oauthGrants.createdAt,
          lastUsedAt: lastUsed,
        })
        .from(oauthGrants)
        .innerJoin(users, eq(users.id, oauthGrants.userId))
        .where(inOrg(oauthGrants, c.var.organisationId, eq(oauthGrants.clientId, client.id)))
        .orderBy(desc(oauthGrants.createdAt));
      return c.json({
        connections: rows.map(
          (r): OAuthConnectionRow => ({
            id: r.id,
            name: r.name,
            email: r.email,
            scopes: r.scopes,
            connectedAt: r.connectedAt.toISOString(),
            lastUsedAt: iso(r.lastUsedAt),
          }),
        ),
      });
    })
    .delete("/:id", idParam, async (c) => {
      const client = await find(c, c.req.valid("param").id);
      await db.transaction(async (tx) => {
        const grants = await tx
          .select({ id: oauthGrants.id })
          .from(oauthGrants)
          .where(inOrg(oauthGrants, c.var.organisationId, eq(oauthGrants.clientId, client.id)));
        // Its tokens stop at once; its connections, codes and refresh tokens go with it.
        await endGrantTokens(
          tx,
          c.var.organisationId,
          grants.map((g) => g.id),
        );
        await tx
          .delete(oauthClients)
          .where(inOrg(oauthClients, c.var.organisationId, eq(oauthClients.id, client.id)));
        await record(c, "oauth_client.delete", client, tx);
      });
      return c.body(null, 204);
    });
}

/**
 * `/api/me/connected-apps`: the applications a member let into this workspace, with what each
 * may do, and Disconnect, which revokes every token it holds.
 */
export function connectedAppRoutes(deps: OAuthDeps) {
  const { db, audit } = deps;
  return new Hono<{ Variables: TenantVariables }>()
    .get("/", async (c) => {
      const rows = await db
        .select({
          id: oauthGrants.id,
          name: oauthClients.name,
          kind: oauthClients.kind,
          scopes: oauthGrants.scopes,
          connectedAt: oauthGrants.createdAt,
          lastUsedAt: lastUsed,
        })
        .from(oauthGrants)
        .innerJoin(
          oauthClients,
          inOrg(oauthClients, c.var.organisationId, eq(oauthClients.id, oauthGrants.clientId)),
        )
        .where(inOrg(oauthGrants, c.var.organisationId, eq(oauthGrants.userId, c.var.userId)))
        .orderBy(desc(oauthGrants.createdAt));
      return c.json({
        apps: rows.map(
          (r): ConnectedAppRow => ({
            id: r.id,
            name: r.name,
            kind: r.kind,
            scopes: r.scopes,
            connectedAt: r.connectedAt.toISOString(),
            lastUsedAt: iso(r.lastUsedAt),
          }),
        ),
      });
    })
    .delete("/:id", idParam, async (c) => {
      const { id } = c.req.valid("param");
      await db.transaction(async (tx) => {
        const [grant] = await tx
          .select({
            id: oauthGrants.id,
            client: oauthClients.name,
            clientId: oauthClients.clientId,
          })
          .from(oauthGrants)
          .innerJoin(
            oauthClients,
            inOrg(oauthClients, c.var.organisationId, eq(oauthClients.id, oauthGrants.clientId)),
          )
          .where(
            inOrg(
              oauthGrants,
              c.var.organisationId,
              eq(oauthGrants.id, id),
              eq(oauthGrants.userId, c.var.userId),
            ),
          );
        if (!grant) throw new NotFound("Connected app");
        await endGrantTokens(tx, c.var.organisationId, [grant.id]);
        await tx
          .delete(oauthGrants)
          .where(inOrg(oauthGrants, c.var.organisationId, eq(oauthGrants.id, grant.id)));
        await audit.record(
          c.var.organisationId,
          await audit.member(c.var.userId),
          {
            action: "oauth.disconnect",
            details: { client: grant.client, clientId: grant.clientId },
          },
          requestInfo(c, deps.trustProxy),
          tx,
        );
      });
      return c.body(null, 204);
    });
}

/**
 * `/api/oauth/authorize`: what the consent screen shows (GET) and the person's answer (POST),
 * for a signed-in member of the client's workspace whose sign-in meets what it asks. No token
 * reaches it (`scopeFor` names no such path). Approving answers the address to go back to,
 * with a code; refusing, with `access_denied`.
 */
export function oauthAuthorizeRoutes(deps: OAuthDeps) {
  const { db, audit } = deps;
  const issuer = issuerOf(deps.publicUrl);

  /** The request checked, and the member held to the client's workspace as its own pages would hold them. */
  const checked = async (
    c: Context<{ Variables: SessionVariables }>,
    params: z.infer<typeof authorizeParams>,
  ): Promise<{ refusal: AuthorizeRefusal } | { ok: CheckedAuthorize; workspace: string }> => {
    const client = await clientByClientId(db, params.client_id);
    const result = checkAuthorize(client, params, issuer);
    if ("error" in result) return { refusal: result };
    const organisationId = result.client.organisationId;
    const pinned = pinnedWorkspace(c);
    if (pinned && pinned.id !== organisationId)
      throw new CodedException(
        403,
        "not_member_here",
        "This application belongs to another workspace. Open it from the instance's own address.",
      );
    const membership = await membershipOf(db, c.var.userId, organisationId);
    if (!membership)
      throw new CodedException(
        403,
        "not_member_here",
        "This application belongs to a workspace you are not a member of.",
      );
    const role = { organisationId, role: membership.role };
    await assertOpen(db, organisationId);
    await assertSessionAllowed(db, c.var.sessionId, role);
    await assertSignedInThrough(db, c.var.sessionId, role);
    await assertSecondFactor(db, c.var.sessionId, role, deps.secondFactor);
    const [workspace] = await db
      .select({ name: organisations.name })
      .from(organisations)
      .where(eq(organisations.id, organisationId));
    return { ok: result, workspace: workspace?.name ?? "" };
  };
  const existingGrant = async (check: CheckedAuthorize, userId: string) => {
    const [grant] = await db
      .select()
      .from(oauthGrants)
      .where(
        inOrg(
          oauthGrants,
          check.client.organisationId,
          eq(oauthGrants.clientId, check.client.id),
          eq(oauthGrants.userId, userId),
        ),
      );
    return grant ?? null;
  };

  return new Hono<{ Variables: SessionVariables }>()
    .get("/", zValidator("query", authorizeParams), async (c) => {
      const params = c.req.valid("query");
      const result = await checked(c, params);
      if ("refusal" in result) return c.json(result);
      const { ok, workspace } = result;
      const grant = await existingGrant(ok, c.var.userId);
      const request: AuthorizeRequestView = {
        client: { name: ok.client.name, kind: ok.client.kind },
        workspace: { name: workspace },
        scopes: ok.scopes,
        returnsTo: returnsTo(ok.redirectUri),
        granted:
          grant !== null && scopesWithin(ok.scopes, grant.scopes) && params.prompt !== "consent",
      };
      return c.json({ request });
    })
    .post("/", zValidator("json", authorizeDecision), async (c) => {
      const { approve, ...params } = c.req.valid("json");
      const result = await checked(c, params);
      if ("refusal" in result) return c.json(result);
      const { ok } = result;
      if (!approve)
        return c.json({
          redirect: withParams(ok.redirectUri, {
            error: "access_denied",
            error_description: "The person refused.",
            state: ok.state,
            iss: issuer,
          }),
        });
      const organisationId = ok.client.organisationId;
      const code = await db.transaction(async (tx) => {
        const before = await existingGrant(ok, c.var.userId);
        const scopes = apiScopes.filter(
          (s) => ok.scopes.includes(s) || (before?.scopes.includes(s) ?? false),
        );
        const [grant] = await tx
          .insert(oauthGrants)
          .values({
            id: uuidv7(),
            organisationId,
            clientId: ok.client.id,
            userId: c.var.userId,
            scopes,
          })
          .onConflictDoUpdate({
            target: [oauthGrants.clientId, oauthGrants.userId],
            set: { scopes, updatedAt: new Date() },
          })
          .returning();
        if (!grant) throw new Error("The connection was not saved");
        // A new connection, or one given more, is in the access log; asking again for as much is not.
        if (!before || !scopesWithin(ok.scopes, before.scopes))
          await audit.record(
            organisationId,
            await audit.member(c.var.userId),
            {
              action: "oauth.connect",
              details: { client: ok.client.name, clientId: ok.client.clientId, scopes },
            },
            requestInfo(c, deps.trustProxy),
            tx,
          );
        return issueCode(tx, grant, ok);
      });
      return c.json({
        redirect: withParams(ok.redirectUri, { code, state: ok.state, iss: issuer }),
      });
    });
}

/** Token and revocation answers are never cached (RFC 6749 section 5.1). */
const noStore = (c: Context) => {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
};

const oauthError = (c: Context, e: OAuthError & { basic?: boolean }) => {
  noStore(c);
  if (e.error === "invalid_client" && e.basic)
    c.header("WWW-Authenticate", 'Basic realm="Hekate", charset="UTF-8"');
  return c.json(
    { error: e.error, error_description: e.description },
    e.error === "invalid_client" ? 401 : 400,
  );
};

/** A form-encoded body as a plain record of its fields, or null when it is not one. */
async function formOf(c: Context): Promise<Record<string, string> | null> {
  const type = c.req.header("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/x-www-form-urlencoded")) return null;
  const body = await c.req.parseBody();
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === "string") fields[k] = v;
  return fields;
}

/**
 * `/api/oauth/token` and `/api/oauth/revoke`: where an application exchanges a code or a
 * refresh token, and revokes one, with its client's credentials and no session. Answered to any
 * origin (a browser application is a public client), never cached, and slowed per address.
 */
export function oauthTokenRoutes(deps: OAuthDeps) {
  const { db } = deps;
  const open = cors({
    origin: "*",
    allowMethods: ["POST"],
    allowHeaders: ["Authorization", "Content-Type"],
    maxAge: 600,
  });
  const limit = rateLimit(
    db,
    "oauth-token",
    { max: 120, windowMs: 60_000 },
    { trustProxy: deps.trustProxy },
  );
  return new Hono()
    .use("/token", open)
    .use("/revoke", open)
    .post("/token", limit, async (c) => {
      const form = await formOf(c);
      if (!form)
        return oauthError(c, {
          error: "invalid_request",
          description: "Send the request form-encoded.",
        });
      if (form.grant_type !== "authorization_code" && form.grant_type !== "refresh_token")
        return oauthError(c, {
          error: form.grant_type ? "unsupported_grant_type" : "invalid_request",
          description: "The grant type must be authorization_code or refresh_token.",
        });
      const parsed = tokenRequest.safeParse(form);
      if (!parsed.success)
        return oauthError(c, {
          error: "invalid_request",
          description: "A parameter the request needs is missing, or too long.",
        });
      const input = parsed.data;
      const authed = await authenticateClient(db, c.req.header("authorization"), input);
      if (!("client" in authed)) return oauthError(c, authed);
      const result =
        input.grant_type === "authorization_code"
          ? await exchangeCode(db, authed.client, input)
          : await refreshTokens(db, authed.client, input);
      if ("error" in result) return oauthError(c, result);
      noStore(c);
      return c.json(result);
    })
    .post("/revoke", limit, async (c) => {
      const form = await formOf(c);
      const parsed = form ? revokeRequest.safeParse(form) : null;
      if (!parsed?.success)
        return oauthError(c, {
          error: "invalid_request",
          description: "Send the token to revoke, form-encoded.",
        });
      const authed = await authenticateClient(db, c.req.header("authorization"), parsed.data);
      if (!("client" in authed)) return oauthError(c, authed);
      await revokeToken(db, authed.client, parsed.data.token);
      noStore(c);
      return c.body(null, 200);
    });
}

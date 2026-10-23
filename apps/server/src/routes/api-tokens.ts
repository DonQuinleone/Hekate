import { type Database, inOrg, schema, uuidv7 } from "@hekate/db";
import {
  API_TOKEN_LIMIT,
  type ApiTokenKind,
  createApiTokenInput,
  logQuery,
  updateApiTokenInput,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { apiTokenRowOf, createServiceAccount, newApiToken } from "../api-tokens.ts";
import { type Audit, requestInfo } from "../audit.ts";
import { CodedException, NotFound } from "../errors.ts";
import { apiLog } from "../logs.ts";
import { requireRole, type TenantVariables } from "../tenancy.ts";

const { apiTokens, users } = schema;

const idParam = zValidator("param", z.object({ id: z.uuid() }));

export interface ApiTokenDeps {
  db: Database;
  audit: Audit;
  trustProxy: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The routes for one kind of token: a member's own (`/api/me/tokens`), or the workspace's
 * service tokens (`/api/organisation/tokens`, admins only). Each lists the live tokens of its
 * kind, makes one (the token answered once, only its hash kept), renames one or changes its
 * scopes, and revokes one. A token is never made, changed or revoked with a token: these paths
 * are not in any scope (`scopeFor`).
 */
function tokenRoutes(kind: ApiTokenKind, deps: ApiTokenDeps) {
  const { db, audit } = deps;
  /** Whose tokens these are: the member's own, or every service token of the workspace. */
  const mine = (c: Context<{ Variables: TenantVariables }>) =>
    inOrg(
      apiTokens,
      c.var.organisationId,
      eq(apiTokens.kind, kind),
      isNull(apiTokens.revokedAt),
      kind === "personal" ? eq(apiTokens.userId, c.var.userId) : undefined,
    );
  const find = async (c: Context<{ Variables: TenantVariables }>, id: string) => {
    const [row] = await db
      .select()
      .from(apiTokens)
      .where(and(mine(c), eq(apiTokens.id, id)));
    if (!row) throw new NotFound("Token");
    return row;
  };
  const nameOf = async (userId: string | null) => {
    if (!userId) return null;
    const [user] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
    return user?.name ?? null;
  };
  const record = async (
    c: Context<{ Variables: TenantVariables }>,
    action: "api_token.create" | "api_token.change" | "api_token.revoke",
    row: typeof apiTokens.$inferSelect,
    into: Pick<Database, "insert"> = db,
  ) =>
    audit.record(
      c.var.organisationId,
      await audit.member(c.var.userId),
      {
        action,
        // Its name and hint, never the token.
        details: {
          kind: row.kind,
          token: row.name,
          hint: row.hint,
          scopes: row.scopes,
          expiresAt: row.expiresAt?.toISOString() ?? null,
        },
      },
      requestInfo(c, deps.trustProxy),
      into,
    );

  return new Hono<{ Variables: TenantVariables }>()
    .get("/", async (c) => {
      const rows = await db
        .select({ token: apiTokens, createdBy: users.name })
        .from(apiTokens)
        .leftJoin(users, eq(users.id, apiTokens.createdBy))
        .where(mine(c))
        .orderBy(desc(apiTokens.createdAt));
      return c.json({ tokens: rows.map((r) => apiTokenRowOf(r.token, r.createdBy)) });
    })
    .post("/", zValidator("json", createApiTokenInput), async (c) => {
      const input = c.req.valid("json");
      const { secret, hash, hint } = newApiToken(kind);
      const id = uuidv7();
      const row = await db.transaction(async (tx) => {
        // Counted under a lock on the workspace's row, so two at once cannot pass the limit.
        await tx
          .select({ id: schema.organisations.id })
          .from(schema.organisations)
          .where(eq(schema.organisations.id, c.var.organisationId))
          .for("update");
        const [held] = await tx.select({ n: count() }).from(apiTokens).where(mine(c));
        if ((held?.n ?? 0) >= API_TOKEN_LIMIT)
          throw new CodedException(
            409,
            "token_limit",
            `There can be at most ${API_TOKEN_LIMIT} tokens here. Revoke one first.`,
          );
        const userId =
          kind === "service" ? await createServiceAccount(tx, id, input.name) : c.var.userId;
        const [made] = await tx
          .insert(apiTokens)
          .values({
            id,
            organisationId: c.var.organisationId,
            kind,
            userId,
            name: input.name,
            hint,
            tokenHash: hash,
            scopes: input.scopes,
            expiresAt:
              input.expiresInDays === null
                ? null
                : new Date(Date.now() + input.expiresInDays * DAY_MS),
            createdBy: c.var.userId,
          })
          .returning();
        if (!made) throw new Error("The token was not saved");
        await record(c, "api_token.create", made, tx);
        return made;
      });
      return c.json({ token: apiTokenRowOf(row, await nameOf(row.createdBy)), secret }, 201);
    })
    .patch("/:id", idParam, zValidator("json", updateApiTokenInput), async (c) => {
      const input = c.req.valid("json");
      const before = await find(c, c.req.valid("param").id);
      const row = await db.transaction(async (tx) => {
        const [changed] = await tx
          .update(apiTokens)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
          })
          .where(and(mine(c), eq(apiTokens.id, before.id)))
          .returning();
        if (!changed) throw new NotFound("Token");
        // A service token's account carries its name, as what it made shows it.
        if (kind === "service" && input.name !== undefined)
          await tx.update(users).set({ name: input.name }).where(eq(users.id, changed.userId));
        await record(c, "api_token.change", changed, tx);
        return changed;
      });
      return c.json({ token: apiTokenRowOf(row, await nameOf(row.createdBy)) });
    })
    .delete("/:id", idParam, async (c) => {
      const { id } = c.req.valid("param");
      await db.transaction(async (tx) => {
        const [revoked] = await tx
          .update(apiTokens)
          .set({ revokedAt: new Date(), revokedBy: c.var.userId })
          .where(and(mine(c), eq(apiTokens.id, id)))
          .returning();
        if (!revoked) throw new NotFound("Token");
        await record(c, "api_token.revoke", revoked, tx);
      });
      return c.body(null, 204);
    });
}

/** `/api/me/tokens`: the member's own tokens in this workspace. */
export const personalTokenRoutes = (deps: ApiTokenDeps) => tokenRoutes("personal", deps);

/**
 * `/api/organisation/tokens`: the workspace's service tokens, for its owners and admins, and
 * the API log of every call its tokens made (`/log`), members' own among them.
 */
export const serviceTokenRoutes = (deps: ApiTokenDeps) =>
  new Hono<{ Variables: TenantVariables }>()
    .use("*", requireRole("admin"))
    .get("/log", zValidator("query", logQuery.omit({ workspace: true })), async (c) => {
      const query = c.req.valid("query");
      const { rows, next } = await apiLog(deps.db, {
        ...query,
        workspace: c.var.organisationId,
      });
      return c.json({ rows, next });
    })
    .route("/", tokenRoutes("service", deps));

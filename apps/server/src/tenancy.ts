import { type Database, schema } from "@hekate/db";
import { and, asc, eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { Auth } from "./auth.ts";

export type OrganisationRole = (typeof schema.organisationRoleEnum.enumValues)[number];

export interface SessionVariables {
  userId: string;
  sessionId: string;
}

export interface TenantVariables extends SessionVariables {
  organisationId: string;
  organisationRole: OrganisationRole;
}

/** Requires a signed-in member. Responds 401 otherwise. */
export const requireSession = (auth: Auth) =>
  createMiddleware<{ Variables: SessionVariables }>(async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) throw new HTTPException(401, { message: "Sign in to continue" });
    c.set("userId", session.user.id);
    c.set("sessionId", session.session.id);
    await next();
  });

/**
 * Resolves the organisation for the request from the session's active organisation, falling back
 * to the member's first organisation. Responds 403 when the user belongs to none.
 */
export const requireOrganisation = (db: Database) =>
  createMiddleware<{ Variables: TenantVariables }>(async (c, next) => {
    const [session] = await db
      .select({ active: schema.authSessions.activeOrganisationId })
      .from(schema.authSessions)
      .where(eq(schema.authSessions.id, c.var.sessionId));
    const memberships = await db
      .select({ organisationId: schema.members.organisationId, role: schema.members.role })
      .from(schema.members)
      .where(eq(schema.members.userId, c.var.userId))
      .orderBy(asc(schema.members.createdAt));
    const membership =
      memberships.find((m) => m.organisationId === session?.active) ?? memberships[0];
    if (!membership)
      throw new HTTPException(403, { message: "You are not a member of any organisation" });
    if (membership.organisationId !== session?.active) {
      await db
        .update(schema.authSessions)
        .set({ activeOrganisationId: membership.organisationId })
        .where(eq(schema.authSessions.id, c.var.sessionId));
    }
    c.set("organisationId", membership.organisationId);
    c.set("organisationRole", membership.role);
    await next();
  });

export async function membershipOf(db: Database, userId: string, organisationId: string) {
  const [row] = await db
    .select()
    .from(schema.members)
    .where(
      and(eq(schema.members.userId, userId), eq(schema.members.organisationId, organisationId)),
    );
  return row;
}

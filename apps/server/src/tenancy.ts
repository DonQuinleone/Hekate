import { type Database, schema } from "@hekate/db";
import { atLeast, secondFactorRequired, workspaceSettingsOf } from "@hekate/shared";
import { and, asc, eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { Auth } from "./auth.ts";
import { CodedException } from "./errors.ts";

export type { OrganisationRole } from "@hekate/shared";

import type { OrganisationRole } from "@hekate/shared";

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
 * The organisation a signed-in user acts in: their session's active organisation, falling
 * back to their first. Responds 403 when they belong to none.
 */
export async function organisationFor(db: Database, userId: string, sessionId: string) {
  const [session] = await db
    .select({ active: schema.authSessions.activeOrganisationId })
    .from(schema.authSessions)
    .where(eq(schema.authSessions.id, sessionId));
  const memberships = await db
    .select({ organisationId: schema.members.organisationId, role: schema.members.role })
    .from(schema.members)
    .where(eq(schema.members.userId, userId))
    .orderBy(asc(schema.members.createdAt));
  const membership =
    memberships.find((m) => m.organisationId === session?.active) ?? memberships[0];
  if (!membership) {
    throw new HTTPException(403, { message: "You are not a member of any workspace" });
  }
  if (membership.organisationId !== session?.active) {
    await db
      .update(schema.authSessions)
      .set({ activeOrganisationId: membership.organisationId })
      .where(eq(schema.authSessions.id, sessionId));
  }
  return membership;
}

export interface SecondFactorRule {
  /** The instance asks every account for a second factor. */
  instance: boolean;
}

/**
 * Refuses a member without a second factor when the workspace, or the instance, asks for one.
 * The web app sends them to add one; nothing else works until they have.
 */
export async function assertSecondFactor(
  db: Database,
  userId: string,
  membership: { organisationId: string; role: OrganisationRole },
  rule: SecondFactorRule,
) {
  const [row] = await db
    .select({
      enabled: schema.users.twoFactorEnabled,
      settings: schema.organisations.settings,
    })
    .from(schema.users)
    .innerJoin(schema.organisations, eq(schema.organisations.id, membership.organisationId))
    .where(eq(schema.users.id, userId));
  if (!row || row.enabled) return;
  const policy = workspaceSettingsOf(row.settings).secondFactor;
  if (secondFactorRequired({ instance: rule.instance, policy, role: membership.role })) {
    throw new CodedException(
      403,
      "second_factor_required",
      "This workspace asks for a second factor. Add one to continue.",
    );
  }
}

/**
 * Resolves the organisation for the request (`organisationFor`), and holds back a member who
 * still owes a second factor, except at the paths in `owing` (where they learn that they do).
 */
export const requireOrganisation = (
  db: Database,
  rule: SecondFactorRule,
  owing: ReadonlySet<string> = new Set(),
) =>
  createMiddleware<{ Variables: TenantVariables }>(async (c, next) => {
    const membership = await organisationFor(db, c.var.userId, c.var.sessionId);
    if (!owing.has(c.req.path)) await assertSecondFactor(db, c.var.userId, membership, rule);
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

/** Requires an organisation role of at least `required`. Responds 403 otherwise. */
export const requireRole = (required: OrganisationRole) =>
  createMiddleware<{ Variables: TenantVariables }>(async (c, next) => {
    if (!atLeast(c.var.organisationRole, required)) {
      throw new HTTPException(403, { message: "You do not have permission to do that" });
    }
    await next();
  });

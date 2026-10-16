import { type Database, inOrg, schema } from "@hekate/db";
import { atLeast, factorDemand, sessionMeets, workspaceSettingsOf } from "@hekate/shared";
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
 * What a workspace (or the instance) asks of this member's sign-in, and how this session was
 * signed in (decision 048).
 */
export async function factorStanding(
  db: Database,
  sessionId: string,
  membership: { organisationId: string; role: OrganisationRole },
  rule: SecondFactorRule,
) {
  const [row] = await db
    .select({ factor: schema.authSessions.factor, settings: schema.organisations.settings })
    .from(schema.authSessions)
    .innerJoin(schema.organisations, eq(schema.organisations.id, membership.organisationId))
    .where(eq(schema.authSessions.id, sessionId));
  const settings = workspaceSettingsOf(row?.settings);
  const demand = factorDemand({
    instance: rule.instance,
    policy: settings.secondFactor,
    securityKeyForAdmins: settings.securityKeyForAdmins,
    role: membership.role,
  });
  const factor = row?.factor ?? "password";
  return { demand, factor, met: sessionMeets(factor, demand) };
}

/**
 * Refuses a member whose sign-in falls short of what the workspace, or the instance, asks: a
 * second factor, or for owners and admins a hardware security key. The web app sends them to add one,
 * or to confirm with the one they have; nothing else works until they do.
 */
export async function assertSecondFactor(
  db: Database,
  sessionId: string,
  membership: { organisationId: string; role: OrganisationRole },
  rule: SecondFactorRule,
) {
  const { demand, met } = await factorStanding(db, sessionId, membership, rule);
  if (met) return;
  throw new CodedException(
    403,
    "second_factor_required",
    demand.securityKey
      ? "This workspace asks owners and admins to sign in with a passkey or hardware security key."
      : "This workspace asks for a second factor. Add one, or confirm with yours, to continue.",
  );
}

/**
 * Refuses a member, other than an owner, who did not sign in through the single sign-on their
 * workspace makes the only way in (#37). Owners keep their password, so a broken identity
 * provider never locks a workspace out (break-glass).
 */
export async function assertSignedInThrough(
  db: Database,
  sessionId: string,
  membership: { organisationId: string; role: OrganisationRole },
) {
  if (membership.role === "owner") return;
  const [row] = await db
    .select({ via: schema.authSessions.ssoProviderId, required: schema.ssoProviders.providerId })
    .from(schema.authSessions)
    .innerJoin(
      schema.ssoProviders,
      inOrg(
        schema.ssoProviders,
        membership.organisationId,
        eq(schema.ssoProviders.enabled, true),
        eq(schema.ssoProviders.enforce, true),
      ),
    )
    .where(eq(schema.authSessions.id, sessionId));
  if (row && row.via !== row.required)
    throw new CodedException(
      403,
      "sso_required",
      "This workspace signs its members in through single sign-on. Sign in that way to continue.",
    );
}

/**
 * Resolves the organisation for the request (`organisationFor`), and holds back a member who
 * still owes a second factor, or who did not come through the single sign-on the workspace
 * requires, except at the paths in `owing` (where they learn that they do).
 */
export const requireOrganisation = (
  db: Database,
  rule: SecondFactorRule,
  owing: ReadonlySet<string> = new Set(),
) =>
  createMiddleware<{ Variables: TenantVariables }>(async (c, next) => {
    const membership = await organisationFor(db, c.var.userId, c.var.sessionId);
    if (!owing.has(c.req.path)) {
      await assertSignedInThrough(db, c.var.sessionId, membership);
      await assertSecondFactor(db, c.var.sessionId, membership, rule);
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

/** Requires an organisation role of at least `required`. Responds 403 otherwise. */
export const requireRole = (required: OrganisationRole) =>
  createMiddleware<{ Variables: TenantVariables }>(async (c, next) => {
    if (!atLeast(c.var.organisationRole, required)) {
      throw new HTTPException(403, { message: "You do not have permission to do that" });
    }
    await next();
  });

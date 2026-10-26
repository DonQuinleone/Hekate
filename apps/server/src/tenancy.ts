import { type Database, inOrg, schema } from "@hekate/db";
import {
  atLeast,
  factorDemand,
  isDunningReason,
  methodsFor,
  OWNER_DELETION_REASON,
  orList,
  sessionEndsAt,
  sessionMeets,
  sessionMethod,
  signInMethodWords,
  workspaceSettingsOf,
} from "@hekate/shared";
import { and, asc, eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { ApiTokenContext } from "./api-tokens.ts";
import type { Auth } from "./auth.ts";
import { CodedException } from "./errors.ts";
import { pinnedWorkspace } from "./hosts.ts";

export type { OrganisationRole } from "@hekate/shared";

import type { OrganisationRole } from "@hekate/shared";

export interface SessionVariables {
  userId: string;
  sessionId: string;
  /** Set where the request came with an API token (#198) rather than a session. */
  apiToken?: ApiTokenContext;
}

export interface TenantVariables extends SessionVariables {
  organisationId: string;
  organisationRole: OrganisationRole;
}

/**
 * Requires a signed-in member, or an API token (#198) acting as one; a token's "session" is
 * the token itself, so what is bound to a session (a download's link) is bound to it. Responds
 * 401 otherwise.
 */
export const requireSession = (auth: Auth) =>
  createMiddleware<{ Variables: SessionVariables }>(async (c, next) => {
    const token = c.var.apiToken;
    if (token) {
      c.set("userId", token.userId);
      c.set("sessionId", tokenSessionId(token));
      await next();
      return;
    }
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) throw new HTTPException(401, { message: "Sign in to continue" });
    c.set("userId", session.user.id);
    c.set("sessionId", session.session.id);
    await next();
  });

/**
 * The organisation a signed-in user acts in: the one the request's host names (#176), which
 * they must belong to; otherwise their session's active organisation, falling back to their
 * first. Responds 403 when they belong to none, or not to the one the host names.
 */
export async function organisationFor(
  db: Database,
  userId: string,
  sessionId: string,
  pinned?: { id: string; name: string },
) {
  const [session] = await db
    .select({ active: schema.authSessions.activeOrganisationId })
    .from(schema.authSessions)
    .where(eq(schema.authSessions.id, sessionId));
  const memberships = await db
    .select({ organisationId: schema.members.organisationId, role: schema.members.role })
    .from(schema.members)
    .where(eq(schema.members.userId, userId))
    .orderBy(asc(schema.members.createdAt));
  if (pinned && !memberships.some((m) => m.organisationId === pinned.id))
    throw new CodedException(403, "not_member_here", `You are not a member of ${pinned.name}`);
  const membership =
    memberships.find((m) => m.organisationId === (pinned?.id ?? session?.active)) ?? memberships[0];
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
 * Holds a member's session to how the workspace lets its members in (decision 248). One older
 * than the workspace's session length ends, everywhere, as an expired session does, and the
 * answer is 401 so they sign in again. One signed in a way the workspace does not allow is
 * refused here, though it may still work in another workspace that allows it. A token's
 * "session" (#198) has no row, and is held to its own expiry.
 */
export async function assertSessionAllowed(
  db: Database,
  sessionId: string,
  membership: { organisationId: string; role: OrganisationRole },
  options: { methods?: boolean; now?: Date } = {},
) {
  const now = options.now ?? new Date();
  const [row] = await db
    .select({
      method: schema.authSessions.method,
      factor: schema.authSessions.factor,
      ssoProviderId: schema.authSessions.ssoProviderId,
      createdAt: schema.authSessions.createdAt,
      expiresAt: schema.authSessions.expiresAt,
      name: schema.organisations.name,
      settings: schema.organisations.settings,
    })
    .from(schema.authSessions)
    .innerJoin(schema.organisations, eq(schema.organisations.id, membership.organisationId))
    .where(eq(schema.authSessions.id, sessionId));
  if (!row) return;
  const settings = workspaceSettingsOf(row.settings);
  if (sessionEndsAt(row, settings.sessionDays) <= now) {
    await db.delete(schema.authSessions).where(eq(schema.authSessions.id, sessionId));
    const days = settings.sessionDays === 1 ? "a day" : `${settings.sessionDays} days`;
    throw new CodedException(
      401,
      "session_ended",
      `${row.name} ends a session ${days} after signing in. Sign in again to carry on.`,
    );
  }
  if (options.methods === false) return;
  const allowed = methodsFor(settings.signInMethods, membership.role);
  const method = sessionMethod(row);
  if (!allowed.includes(method))
    throw new CodedException(
      403,
      "sign_in_method_refused",
      `${row.name} does not take signing in with ${signInMethodWords[method]}. Sign in with ${orList(allowed.map((m) => signInMethodWords[m]))} to carry on.`,
    );
}

/**
 * Refuses everyone in a workspace an operator has suspended (#174), saying why: nothing is
 * deleted, and nobody gets in until it is reinstated.
 */
export async function assertOpen(
  db: Database,
  organisationId: string,
  /**
   * The suspension this request passes, if any: its owners may still pay when billing (#178)
   * suspended it for a payment overdue, and keep or export it while they are deleting it (#186).
   */
  passes: { paying?: boolean; deleting?: boolean } = {},
) {
  const [row] = await db
    .select({
      suspendedAt: schema.organisations.suspendedAt,
      reason: schema.organisations.suspendedReason,
    })
    .from(schema.organisations)
    .where(eq(schema.organisations.id, organisationId));
  const passed =
    (passes.paying === true && isDunningReason(row?.reason)) ||
    (passes.deleting === true && row?.reason === OWNER_DELETION_REASON);
  if (row?.suspendedAt && !passed)
    throw new CodedException(
      403,
      "workspace_suspended",
      row.reason
        ? `This workspace is suspended: ${row.reason}`
        : "This workspace is suspended. Its owner can ask the instance's operators why.",
    );
}

/**
 * Resolves the organisation for the request (`organisationFor`), and holds back a member of a
 * suspended workspace, or who still owes a second factor, or who did not come through the
 * single sign-on the workspace requires, except at the paths in `owing` (where they learn
 * that they do, and may switch to another workspace).
 */
export const requireOrganisation = (
  db: Database,
  rule: SecondFactorRule,
  owing: ReadonlySet<string> = new Set(),
  /** Where an owner pays for a workspace suspended for a payment overdue (#179). */
  payable: ReadonlySet<string> = new Set(),
  /**
   * Where an owner keeps, or exports, a workspace suspended because its owners are deleting it
   * (#186): paths starting with one of these.
   */
  deletable: readonly string[] = [],
) =>
  createMiddleware<{ Variables: TenantVariables }>(async (c, next) => {
    // A token is its workspace's alone, checked as the request came in (api-tokens.ts).
    const token = c.var.apiToken;
    if (token) {
      c.set("organisationId", token.organisationId);
      c.set("organisationRole", token.role);
      await next();
      return;
    }
    const membership = await organisationFor(db, c.var.userId, c.var.sessionId, pinnedWorkspace(c));
    if (!owing.has(c.req.path)) {
      const owner = membership.role === "owner";
      await assertOpen(db, membership.organisationId, {
        paying: owner && payable.has(c.req.path),
        deleting:
          owner &&
          deletable.some((prefix) => c.req.path === prefix || c.req.path.startsWith(`${prefix}/`)),
      });
      await assertSessionAllowed(db, c.var.sessionId, membership);
      await assertSignedInThrough(db, c.var.sessionId, membership);
      await assertSecondFactor(db, c.var.sessionId, membership, rule);
    }
    // Where they learn what they owe, an ended session still ends; the way they signed in is
    // checked on every other path, as single sign-on is.
    else await assertSessionAllowed(db, c.var.sessionId, membership, { methods: false });
    c.set("organisationId", membership.organisationId);
    c.set("organisationRole", membership.role);
    await next();
  });

/** What a token's requests are bound to where a session's would be. */
export const tokenSessionId = (token: { id: string }) => `token:${token.id}`;

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

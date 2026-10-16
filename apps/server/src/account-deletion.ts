import { type Database, inOrg, schema } from "@hekate/db";
import { type DeleteAccountInput, FORMER_MEMBER } from "@hekate/shared";
import { and, eq, sql } from "drizzle-orm";
import type { Audit, RequestInfo } from "./audit.ts";
import type { Auth } from "./auth.ts";

const {
  accessEvents,
  authAccounts,
  authSessions,
  follows,
  groupMembers,
  invitations,
  members,
  marks,
  notificationPreferences,
  notifications,
  organisations,
  overviewLayouts,
  passkeys,
  projectMembers,
  savedSearches,
  twoFactors,
  users,
} = schema;

export type DeletionResult =
  | { status: "deleted" }
  | { status: "refused" }
  | { status: "sole_owner"; workspaces: string[] };

/**
 * Delete an account (decision 047). What the member did stays, as a former member's: their
 * comments, decisions and access log entries keep their place, under "A former member". What
 * was theirs alone goes: sign-in, sessions, the second factor, memberships, preferences,
 * notifications, follows, marks and saved searches, and the address leaves every invitation
 * that named it. The row itself stays, emptied, so what
 * they wrote keeps an author; no name, address or choice of theirs is left in it.
 *
 * Refused unless the address typed is the account's and the password is right, and refused
 * while they are the only owner of a workspace, which would be left with no one to run it.
 */
export async function deleteAccount(
  db: Database,
  auth: Auth,
  audit: Audit,
  userId: string,
  input: DeleteAccountInput,
  request?: RequestInfo,
): Promise<DeletionResult> {
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  if (!user || user.email.toLowerCase() !== input.email.trim().toLowerCase())
    return { status: "refused" };
  const [credential] = await db
    .select({ hash: authAccounts.password })
    .from(authAccounts)
    .where(and(eq(authAccounts.userId, userId), eq(authAccounts.providerId, "credential")));
  const context = await auth.$context;
  if (
    !credential?.hash ||
    !(await context.password.verify({ hash: credential.hash, password: input.password }))
  )
    return { status: "refused" };

  return db.transaction(async (tx) => {
    // The account's row, locked first: a request still writing to the access log for it waits
    // here, and once this commits the log's trigger labels anything later "A former member"
    // (migration 0040), so nothing written alongside the deletion keeps the name.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
    // An account is no workspace's: go through every workspace (a global table) and ask each,
    // in its own scope, whether the account is a member there and whether it left a trail.
    const all = await tx
      .select({ id: organisations.id, name: organisations.name })
      .from(organisations);
    const memberships: { organisationId: string; role: string; name: string }[] = [];
    const logged: string[] = [];
    for (const workspace of all) {
      const [membership] = await tx
        .select({ role: members.role })
        .from(members)
        .where(inOrg(members, workspace.id, eq(members.userId, userId)));
      if (membership)
        memberships.push({
          organisationId: workspace.id,
          role: membership.role,
          name: workspace.name,
        });
      const [trail] = await tx
        .select({ id: accessEvents.id })
        .from(accessEvents)
        .where(inOrg(accessEvents, workspace.id, eq(accessEvents.userId, userId)))
        .limit(1);
      if (trail) logged.push(workspace.id);
    }
    // The owners of each workspace they own, locked: two owners leaving at once cannot both
    // find the other still there.
    const sole: string[] = [];
    for (const m of memberships.filter((m) => m.role === "owner")) {
      const owners = await tx
        .select({ userId: members.userId })
        .from(members)
        .where(inOrg(members, m.organisationId, eq(members.role, "owner")))
        .for("update");
      if (!owners.some((o) => o.userId !== userId)) sole.push(m.name);
    }
    if (sole.length > 0) return { status: "sole_owner" as const, workspaces: sole };

    // Its trail is wherever it acted, including workspaces it has left.
    const workspaces = [...new Set([...memberships.map((m) => m.organisationId), ...logged])];
    if (logged.length > 0) {
      // The access log allows this one change, to this account's rows, in this transaction
      // (migration 0040): the label that named them now names no one.
      await tx.execute(sql`select set_config('hekate.audit_forget', ${userId}, true)`);
      for (const organisationId of logged) {
        await tx
          .update(accessEvents)
          .set({ actorLabel: FORMER_MEMBER })
          .where(inOrg(accessEvents, organisationId, eq(accessEvents.userId, userId)));
      }
    }
    // Invitations to the address, in every workspace, joined or not: the address goes from
    // each, and one still open can no longer be accepted.
    const formerEmail = `former-${userId}@deleted.invalid`;
    for (const workspace of all) {
      await tx
        .update(invitations)
        .set({ email: formerEmail, revokedAt: sql`coalesce(${invitations.revokedAt}, now())` })
        .where(
          inOrg(
            invitations,
            workspace.id,
            sql`lower(${invitations.email}) = ${user.email.toLowerCase()}`,
          ),
        );
    }
    const former = { type: "member" as const, userId, label: FORMER_MEMBER };
    for (const organisationId of memberships.map((m) => m.organisationId)) {
      await audit.record(organisationId, former, { action: "account.deleted" }, request, tx);
    }
    for (const organisationId of workspaces) {
      for (const table of [
        projectMembers,
        groupMembers,
        notifications,
        notificationPreferences,
        follows,
        overviewLayouts,
        savedSearches,
        marks,
        members,
      ]) {
        await tx.delete(table).where(inOrg(table, organisationId, eq(table.userId, userId)));
      }
    }
    await tx.delete(twoFactors).where(eq(twoFactors.userId, userId));
    await tx.delete(passkeys).where(eq(passkeys.userId, userId));
    await tx.delete(authAccounts).where(eq(authAccounts.userId, userId));
    await tx.delete(authSessions).where(eq(authSessions.userId, userId));
    await tx
      .update(users)
      .set({
        name: FORMER_MEMBER,
        // Unique, and nobody's: it can receive nothing and sign in as no one.
        email: formerEmail,
        emailVerified: false,
        image: null,
        locale: null,
        timeZone: null,
        preferences: null,
        twoFactorEnabled: false,
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
    return { status: "deleted" as const };
  });
}

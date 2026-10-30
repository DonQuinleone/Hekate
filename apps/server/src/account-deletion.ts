import { type Database, inOrg, schema } from "@hekate/db";
import {
  type DeleteAccountInput,
  type DeletionConfirmation,
  FORMER_MEMBER,
  FRESH_SIGN_IN_MS,
} from "@hekate/shared";
import { and, eq, like, ne, or, sql } from "drizzle-orm";
import { revokeMemberTokens } from "./api-tokens.ts";
import type { Audit, RequestInfo } from "./audit.ts";
import type { Auth } from "./auth.ts";
import { directoryConfig, verifyPassword } from "./directory.ts";
import type { Keyring } from "./keyring.ts";
import { dropOwnerships } from "./project-owners.ts";
import { recordInstanceEvent } from "./routes/instance.ts";

const {
  accessEvents,
  authAccounts,
  authSessions,
  comments,
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
  | { status: "sign_in_again" }
  | { status: "sole_owner"; workspaces: string[] }
  | { status: "last_operator" };

/**
 * How an account confirms its deletion: with its password here; with its directory password,
 * for an account made by a workspace's directory (#38); otherwise, for an account that signs
 * in only through single sign-on (#37) or a passkey, with a sign-in in the last ten minutes,
 * as GitHub asks for sudo mode. `fresh` says whether this session is one.
 */
export async function deletionConfirmation(
  db: Database,
  userId: string,
  sessionId: string,
): Promise<DeletionConfirmation> {
  const links = await db
    .select({ providerId: authAccounts.providerId, hash: authAccounts.password })
    .from(authAccounts)
    .where(eq(authAccounts.userId, userId));
  if (links.some((l) => l.providerId === "credential" && l.hash)) return { with: "password" };
  if (links.some((l) => l.providerId.startsWith("directory:"))) return { with: "directory" };
  const [sso] = await db
    .select({ providerId: authAccounts.providerId })
    .from(authAccounts)
    .where(
      and(
        eq(authAccounts.userId, userId),
        ne(authAccounts.providerId, "credential"),
        sql`${authAccounts.providerId} not like 'directory:%'`,
      ),
    )
    .limit(1);
  const [session] = await db
    .select({ createdAt: authSessions.createdAt })
    .from(authSessions)
    .where(and(eq(authSessions.id, sessionId), eq(authSessions.userId, userId)));
  return {
    with: "sign_in",
    providerId: sso?.providerId ?? null,
    fresh: Boolean(session && Date.now() - session.createdAt.getTime() < FRESH_SIGN_IN_MS),
  };
}

/**
 * Whether a password is the account's: its password here, or, for an account made by a
 * workspace's directory (#38) with none here, its password in that directory, checked by
 * binding as the person the account is linked to.
 */
async function passwordIsTheirs(
  db: Database,
  auth: Auth,
  keyring: Keyring | undefined,
  userId: string,
  password: string,
): Promise<boolean> {
  const [credential] = await db
    .select({ hash: authAccounts.password })
    .from(authAccounts)
    .where(and(eq(authAccounts.userId, userId), eq(authAccounts.providerId, "credential")));
  if (credential?.hash) {
    const context = await auth.$context;
    return context.password.verify({ hash: credential.hash, password });
  }
  if (!keyring) return false;
  const links = await db
    .select({ providerId: authAccounts.providerId, dn: authAccounts.accountId })
    .from(authAccounts)
    .where(and(eq(authAccounts.userId, userId), like(authAccounts.providerId, "directory:%")));
  for (const link of links) {
    const organisationId = link.providerId.slice("directory:".length);
    const config = await directoryConfig(db, keyring, organisationId);
    if (!config?.enabled) continue;
    // A directory that cannot be reached cannot vouch: try the next, else refuse.
    if (await verifyPassword(config, link.dn, password).catch(() => false)) return true;
  }
  return false;
}

/**
 * Confirm it is the account's owner at the keyboard, before something as grave as deleting the
 * account or moving a project (#240): their password, their directory password, or, for an
 * account with neither, a sign-in in the last ten minutes, as `deletionConfirmation` says.
 */
export async function confirmIdentity(
  db: Database,
  auth: Auth,
  keyring: Keyring | undefined,
  session: { userId: string; sessionId: string },
  password: string | undefined,
): Promise<"confirmed" | "refused" | "sign_in_again"> {
  const confirm = await deletionConfirmation(db, session.userId, session.sessionId);
  if (confirm.with === "sign_in") return confirm.fresh ? "confirmed" : "sign_in_again";
  if (!password || !(await passwordIsTheirs(db, auth, keyring, session.userId, password)))
    return "refused";
  return "confirmed";
}

/**
 * Delete an account (decision 047). What the member did stays, as a former member's: their
 * comments, decisions and access log entries keep their place, under "A former member". What
 * was theirs alone goes: sign-in, sessions, the second factor, memberships, preferences,
 * notifications, follows, marks and saved searches, and the address leaves every invitation
 * that named it. The row itself stays, emptied, so what
 * they wrote keeps an author; no name, address or choice of theirs is left in it.
 *
 * Refused unless the address typed is the account's and it is confirmed as
 * `deletionConfirmation` says, and refused while they are the only owner of a workspace,
 * which would be left with no one to run it.
 */
export async function deleteAccount(
  db: Database,
  auth: Auth,
  keyring: Keyring | undefined,
  audit: Audit,
  session: { userId: string; sessionId: string },
  input: DeleteAccountInput,
  request?: RequestInfo,
): Promise<DeletionResult> {
  const { userId } = session;
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  if (!user || user.email.toLowerCase() !== input.email.trim().toLowerCase())
    return { status: "refused" };
  const confirmed = await confirmIdentity(db, auth, keyring, session, input.password);
  if (confirmed !== "confirmed") return { status: confirmed };

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
    // The instance keeps an operator: the last one cannot leave by deleting their account, and
    // any other stops being one with it. Locked, so two operators leaving at once cannot both go.
    const operators = await tx
      .select({ userId: schema.instanceOperators.userId })
      .from(schema.instanceOperators)
      .for("update");
    if (operators.some((o) => o.userId === userId)) {
      if (operators.length === 1) return { status: "last_operator" as const };
      await tx.delete(schema.instanceOperators).where(eq(schema.instanceOperators.userId, userId));
      await recordInstanceEvent(tx, {
        actorId: null,
        action: "operator.removed",
        target: FORMER_MEMBER,
        details: { reason: "account deleted" },
      });
    }
    // What the instance's events say of them by address names no one now.
    await tx
      .update(schema.instanceEvents)
      .set({ target: FORMER_MEMBER })
      .where(eq(schema.instanceEvents.target, user.email));
    // Nor do the sign-in and mail logs (#157), which kept the address as it was typed or sent.
    await tx
      .update(schema.authEvents)
      .set({ account: FORMER_MEMBER })
      .where(
        or(
          eq(schema.authEvents.userId, userId),
          sql`lower(${schema.authEvents.account}) = lower(${user.email})`,
        ),
      );
    await tx
      .update(schema.mailEvents)
      .set({ recipient: FORMER_MEMBER })
      .where(sql`lower(${schema.mailEvents.recipient}) = lower(${user.email})`);

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
    // What was assigned to them (#36) is no one's now: triage gives it to someone else.
    for (const workspace of all) {
      await tx
        .update(comments)
        .set({ assigneeId: null })
        .where(inOrg(comments, workspace.id, eq(comments.assigneeId, userId)));
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
      // Their ownership of the workspace's projects goes, each handed to its earliest member,
      // or the workspace's earliest owner, should they have been its last (decision 285). The
      // workspace is left first, so they are not the owner it falls to.
      await tx.delete(members).where(inOrg(members, organisationId, eq(members.userId, userId)));
      await dropOwnerships(tx, organisationId, userId);
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
      // Their API tokens (#198) stop working; the rows stay, for the API log to name.
      await revokeMemberTokens(tx, organisationId, userId, null);
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

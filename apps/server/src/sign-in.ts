import { createHash } from "node:crypto";
import { type Database, inOrg, schema } from "@hekate/db";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { Audit } from "./audit.ts";
import { type Attempts, afterFailure, fresh, standing, waitFor } from "./lockout.ts";

const { signInAttempts, users, members, organisations } = schema;

/** The key an address's attempts are kept under: a hash, so the table names no one. */
export const attemptKey = (email: string) =>
  createHash("sha256").update(email.trim().toLowerCase()).digest("hex");

export async function attemptsFor(db: Database, email: string): Promise<Attempts> {
  const [row] = await db
    .select()
    .from(signInAttempts)
    .where(eq(signInAttempts.key, attemptKey(email)));
  return row
    ? { failures: row.failures, lastFailureAt: row.lastFailureAt, lockedUntil: row.lockedUntil }
    : fresh;
}

/**
 * Admit a sign-in attempt, or say how long to wait. An admitted attempt is counted as a failure
 * at once, under a row lock, so a burst of tries sent together cannot all pass between checking
 * and counting; a success clears the count again (`clearAttempts`). `locks` says this attempt
 * reached the lock: once it has actually failed, the workspaces hear of it (`logLockout`).
 */
export async function admitAttempt(
  db: Database,
  email: string,
  now = new Date(),
): Promise<{ wait: number; locked: boolean; locks: boolean }> {
  const key = attemptKey(email);
  return db.transaction(async (tx) => {
    await tx.insert(signInAttempts).values({ key }).onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(signInAttempts)
      .where(eq(signInAttempts.key, key))
      .for("update");
    const current: Attempts = row
      ? { failures: row.failures, lastFailureAt: row.lastFailureAt, lockedUntil: row.lockedUntil }
      : fresh;
    const wait = waitFor(current, now);
    if (wait > 0) return { wait, locked: isLocked(current, now), locks: false };
    const { next, locked } = afterFailure(current, now);
    await tx
      .update(signInAttempts)
      .set({ ...next, updatedAt: now })
      .where(eq(signInAttempts.key, key));
    return { wait: 0, locked: false, locks: locked };
  });
}

/** Tell each workspace the account belongs to that it is locked. */
export const logLockout = (db: Database, audit: Audit, email: string) =>
  logToWorkspaces(db, audit, email, "account.lockout");

/**
 * Forget attempts nobody has made for a day and that hold no lock, so addresses tried once (or
 * that do not exist) do not pile up. Run hourly.
 */
export async function purgeAttempts(db: Database, now = new Date()) {
  const day = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  await db
    .delete(signInAttempts)
    .where(
      and(
        lt(signInAttempts.updatedAt, day),
        or(isNull(signInAttempts.lockedUntil), lt(signInAttempts.lockedUntil, now)),
      ),
    );
}

/** A success, or a new password, starts the count again. */
export async function clearAttempts(db: Database, email: string) {
  await db.delete(signInAttempts).where(eq(signInAttempts.key, attemptKey(email)));
}

/** Whether the attempts stand locked now, rather than only slowed. */
export const isLocked = (a: Attempts, now = new Date()) => Boolean(standing(a, now).lockedUntil);

type AccountAction =
  | "account.lockout"
  | "account.password_reset"
  | "account.second_factor_added"
  | "account.second_factor_removed"
  | "account.recovery_codes"
  | "account.passkey_added"
  | "account.passkey_removed";

/** Write an account event to the access log of every workspace the account belongs to. */
export async function logToWorkspaces(
  db: Database,
  audit: Audit,
  email: string,
  action: AccountAction,
) {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()));
  if (user) await logForAccount(db, audit, user.id, action);
}

/** The same, for an account known by its id. */
export async function logForAccount(
  db: Database,
  audit: Audit,
  userId: string,
  action: AccountAction,
) {
  const who = await audit.member(userId);
  for (const organisationId of await workspacesOf(db, userId)) {
    await audit.record(organisationId, who, { action });
  }
}

/**
 * The workspaces an account belongs to. An account is no workspace's, so this goes through
 * every workspace (a global table) and asks each, in its own scope, whether it is a member.
 */
export async function workspacesOf(db: Database, userId: string): Promise<string[]> {
  const all = await db.select({ id: organisations.id }).from(organisations);
  const found: string[] = [];
  for (const { id } of all) {
    const [membership] = await db
      .select({ id: members.id })
      .from(members)
      .where(inOrg(members, id, eq(members.userId, userId)));
    if (membership) found.push(id);
  }
  return found;
}

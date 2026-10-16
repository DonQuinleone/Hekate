import { createHash } from "node:crypto";
import { type Database, schema } from "@hekate/db";
import { eq } from "drizzle-orm";
import type { Audit } from "./audit.ts";
import { type Attempts, afterFailure, fresh, standing } from "./lockout.ts";

const { signInAttempts, users, members } = schema;

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
 * Count a failed sign-in, under a row lock so two at once both count. When it locks the
 * account, each workspace the account belongs to hears of it in its access log.
 */
export async function recordFailure(db: Database, email: string, audit?: Audit, now = new Date()) {
  const key = attemptKey(email);
  const locked = await db.transaction(async (tx) => {
    await tx.insert(signInAttempts).values({ key }).onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(signInAttempts)
      .where(eq(signInAttempts.key, key))
      .for("update");
    const { next, locked } = afterFailure(
      row
        ? { failures: row.failures, lastFailureAt: row.lastFailureAt, lockedUntil: row.lockedUntil }
        : fresh,
      now,
    );
    await tx
      .update(signInAttempts)
      .set({ ...next, updatedAt: now })
      .where(eq(signInAttempts.key, key));
    return locked;
  });
  if (locked && audit) await logToWorkspaces(db, audit, email, "account.lockout");
  return locked;
}

/** A success, or a new password, starts the count again. */
export async function clearAttempts(db: Database, email: string) {
  await db.delete(signInAttempts).where(eq(signInAttempts.key, attemptKey(email)));
}

/** Whether the attempts stand locked now, rather than only slowed. */
export const isLocked = (a: Attempts, now = new Date()) => Boolean(standing(a, now).lockedUntil);

/** Write an account event to the access log of every workspace the account belongs to. */
export async function logToWorkspaces(
  db: Database,
  audit: Audit,
  email: string,
  action: "account.lockout" | "account.password_reset",
) {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()));
  if (!user) return;
  const workspaces = await db
    .select({ organisationId: members.organisationId })
    .from(members)
    .where(eq(members.userId, user.id));
  const who = await audit.member(user.id);
  for (const { organisationId } of workspaces) {
    await audit.record(organisationId, who, { action });
  }
}

/**
 * How sign-in attempts on one account are slowed, then stopped (docs/security.md). The first
 * few failures cost nothing; after them each try waits twice as long as the last, up to a
 * minute; ten failures within a quarter of an hour lock the account for a quarter of an hour.
 * A success, or a quiet quarter of an hour, starts again. Pure, so it is tested on its own.
 */

export interface Attempts {
  failures: number;
  lastFailureAt: Date | null;
  lockedUntil: Date | null;
}

export const FREE_FAILURES = 4;
export const LOCK_AFTER = 10;
export const WINDOW_MS = 15 * 60 * 1000;
export const LOCK_MS = 15 * 60 * 1000;
const MAX_DELAY_S = 60;

export const fresh: Attempts = { failures: 0, lastFailureAt: null, lockedUntil: null };

/** The attempts as they stand now: a lock that has run out, or a quiet window, forgets them. */
export function standing(a: Attempts, now: Date): Attempts {
  if (a.lockedUntil && a.lockedUntil.getTime() <= now.getTime()) return fresh;
  if (!a.lockedUntil && a.lastFailureAt && now.getTime() - a.lastFailureAt.getTime() > WINDOW_MS)
    return fresh;
  return a;
}

/** How long, in milliseconds, before the next try is heard; zero when it may go now. */
export function waitFor(stored: Attempts, now: Date): number {
  const a = standing(stored, now);
  if (a.lockedUntil) return a.lockedUntil.getTime() - now.getTime();
  if (a.failures < FREE_FAILURES || !a.lastFailureAt) return 0;
  const delay = Math.min(MAX_DELAY_S, 2 ** (a.failures - FREE_FAILURES)) * 1000;
  return Math.max(0, delay - (now.getTime() - a.lastFailureAt.getTime()));
}

/** The attempts after one more failure, and whether this one locked the account. */
export function afterFailure(stored: Attempts, now: Date): { next: Attempts; locked: boolean } {
  const a = standing(stored, now);
  const failures = a.failures + 1;
  const locked = failures >= LOCK_AFTER;
  return {
    next: {
      failures,
      lastFailureAt: now,
      lockedUntil: locked ? new Date(now.getTime() + LOCK_MS) : null,
    },
    locked,
  };
}

/** What to tell someone made to wait: in seconds or minutes, as a person would say it. */
export function waitMessage(ms: number, locked: boolean): string {
  const seconds = Math.ceil(ms / 1000);
  const when =
    seconds < 60
      ? `${seconds} second${seconds === 1 ? "" : "s"}`
      : `${Math.ceil(seconds / 60)} minutes`;
  return locked
    ? `Too many attempts: this account is locked for ${when}. Forgotten your password? Set a new one.`
    : `Too many attempts. Wait ${when} before trying again.`;
}

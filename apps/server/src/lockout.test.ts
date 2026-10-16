import { describe, expect, it } from "vitest";
import {
  type Attempts,
  afterFailure,
  FREE_FAILURES,
  fresh,
  LOCK_AFTER,
  LOCK_MS,
  WINDOW_MS,
  waitFor,
  waitMessage,
} from "./lockout.ts";

const t0 = new Date("2026-10-16T09:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);

function fail(times: number, start = fresh, gap = 0): Attempts {
  let a = start;
  for (let i = 0; i < times; i++) a = afterFailure(a, at(i * gap)).next;
  return a;
}

describe("sign-in lockout", () => {
  it("lets the first few failures go by without waiting", () => {
    expect(waitFor(fail(FREE_FAILURES - 1), t0)).toBe(0);
  });

  it("then doubles the wait after each failure, up to a minute", () => {
    const a = fail(FREE_FAILURES);
    expect(waitFor(a, t0)).toBe(1000);
    expect(waitFor(fail(FREE_FAILURES + 2), t0)).toBe(4000);
    expect(waitFor(a, at(1000))).toBe(0);
    const many = { ...fail(LOCK_AFTER - 1), lockedUntil: null };
    expect(waitFor({ ...many, failures: 20 }, t0)).toBe(60_000);
  });

  it("locks after ten failures in a quarter of an hour, for a quarter of an hour", () => {
    let a = fail(LOCK_AFTER - 1);
    const last = afterFailure(a, t0);
    expect(last.locked).toBe(true);
    a = last.next;
    expect(waitFor(a, t0)).toBe(LOCK_MS);
    expect(waitFor(a, at(LOCK_MS - 1))).toBe(1);
    // Once the lock runs out, the account starts again.
    expect(waitFor(a, at(LOCK_MS))).toBe(0);
    expect(afterFailure(a, at(LOCK_MS)).next.failures).toBe(1);
  });

  it("forgets failures after a quiet quarter of an hour", () => {
    const a = fail(LOCK_AFTER - 1);
    expect(afterFailure(a, at(WINDOW_MS + 1)).next.failures).toBe(1);
    // Spread out, they never add up to a lock.
    expect(fail(LOCK_AFTER, fresh, WINDOW_MS + 1).lockedUntil).toBeNull();
  });

  it("says how long in words", () => {
    expect(waitMessage(1500, false)).toBe("Too many attempts. Wait 2 seconds before trying again.");
    expect(waitMessage(LOCK_MS, true)).toContain("locked for 15 minutes");
  });
});

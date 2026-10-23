import { describe, expect, it } from "vitest";
import { limitRefusal, monthOf, standing, workspaceLimits } from "./usage.ts";

describe("usage and limits (#175)", () => {
  it("warns from 90% of a limit, and refuses at it", () => {
    expect(standing(899, 1000)).toBe("under");
    expect(standing(900, 1000)).toBe("near");
    expect(standing(999, 1000)).toBe("near");
    expect(standing(1000, 1000)).toBe("reached");
    expect(standing(1200, 1000)).toBe("reached");
    // No limit, nothing to warn of.
    expect(standing(5e15, null)).toBe("under");
  });

  it("says where a refusal stands", () => {
    expect(limitRefusal("storage", 1e12, 1e12)).toMatch(
      /^Storage quota reached: 1\.0 TB of 1\.0 TB\./,
    );
    expect(limitRefusal("members", 25, 25)).toMatch(/^Member limit reached: 25 of 25\./);
  });

  it("keeps a month under its first day, by UTC", () => {
    expect(monthOf(new Date("2026-10-23T10:00:00Z"))).toBe("2026-10-01");
    expect(monthOf(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12-01");
    expect(monthOf(new Date("2027-01-01T00:00:00Z"))).toBe("2027-01-01");
  });

  it("takes whole, positive limits, or none", () => {
    expect(workspaceLimits.safeParse({ storageQuota: 1e12, memberLimit: 25 }).success).toBe(true);
    expect(workspaceLimits.safeParse({ storageQuota: null, memberLimit: null }).success).toBe(true);
    expect(workspaceLimits.safeParse({ storageQuota: 0, memberLimit: null }).success).toBe(false);
    expect(workspaceLimits.safeParse({ storageQuota: null, memberLimit: 2.5 }).success).toBe(false);
  });
});

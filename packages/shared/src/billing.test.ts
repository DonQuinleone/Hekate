import { describe, expect, it } from "vitest";
import { dunningDue, formatMoney } from "./billing.ts";

describe("dunning (#178)", () => {
  const since = new Date("2026-10-01T09:00:00Z");
  const after = (days: number, hours = 0) =>
    new Date(since.getTime() + days * 86_400_000 + hours * 3_600_000);

  it("warns at 7 and 14 days and suspends at 21, each once", () => {
    expect(dunningDue(since, after(6, 23), 0)).toBeNull();
    expect(dunningDue(since, after(7), 0)).toBe(1);
    expect(dunningDue(since, after(8), 1)).toBeNull();
    expect(dunningDue(since, after(14), 1)).toBe(2);
    expect(dunningDue(since, after(21), 2)).toBe(3);
    expect(dunningDue(since, after(40), 3)).toBeNull();
  });

  it("skips a warning it missed for the step its days have reached", () => {
    expect(dunningDue(since, after(15), 0)).toBe(2);
    expect(dunningDue(since, after(30), 0)).toBe(3);
  });
});

describe("money", () => {
  it("reads as people write it, in the minor unit given", () => {
    expect(formatMoney(4900, "gbp")).toBe("£49.00");
    expect(formatMoney(118_000, "GBP")).toBe("£1,180.00");
    expect(formatMoney(-2450, "GBP")).toBe("−£24.50");
    expect(formatMoney(19_000, "CHF")).toBe("190.00 CHF");
  });
});

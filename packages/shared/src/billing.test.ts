import { describe, expect, it } from "vitest";
import {
  DUNNING_REASON,
  dunningDue,
  dunningRule,
  formatMoney,
  isDunningReason,
  minorUnits,
  monthlyAmount,
  promoCodeInput,
  promoRefusal,
  promoSummary,
  suspendsAt,
} from "./billing.ts";

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

  it("takes its days from the instance's rule, each after the one before (#180)", () => {
    const rule = { warn: 3, warnAgain: 10, suspend: 30 };
    expect(dunningDue(since, after(3), 0, rule)).toBe(1);
    expect(dunningDue(since, after(21), 2, rule)).toBeNull();
    expect(dunningDue(since, after(30), 2, rule)).toBe(3);
    expect(suspendsAt(since, rule)).toEqual(after(30));
    expect(dunningRule.safeParse(rule).success).toBe(true);
    expect(dunningRule.safeParse({ warn: 7, warnAgain: 7, suspend: 21 }).success).toBe(false);
    expect(dunningRule.safeParse({ warn: 7, warnAgain: 14, suspend: 10 }).success).toBe(false);
  });

  it("knows a workspace it suspended, under its old words too (#180)", () => {
    expect(isDunningReason(DUNNING_REASON)).toBe(true);
    expect(
      isDunningReason(
        "A payment is 21 days overdue. The workspace opens again as soon as it is paid.",
      ),
    ).toBe(true);
    expect(isDunningReason("The invoice for October is unpaid.")).toBe(false);
    expect(isDunningReason(null)).toBe(false);
  });
});

describe("money", () => {
  it("reads as people write it, in each currency's own minor unit", () => {
    expect(formatMoney(4900, "gbp")).toBe("£49.00");
    expect(formatMoney(118_000, "GBP")).toBe("£1,180.00");
    expect(formatMoney(-2450, "GBP")).toBe("-£24.50");
    expect(formatMoney(4900, "JPY")).toBe("JP¥4,900");
    expect(formatMoney(19_000, "KWD")).toBe("KWD\u00a019.000");
  });

  it("reads an amount as typed in the currency's minor unit (#180)", () => {
    expect(minorUnits("49", "GBP")).toBe(4900);
    expect(minorUnits(" 1,180.5 ", "gbp")).toBe(118_050);
    expect(minorUnits("4900", "JPY")).toBe(4900);
    expect(minorUnits("19.000", "KWD")).toBe(19_000);
    for (const bad of ["", "4.999", "-5", "£49", "49.5.0"])
      expect(minorUnits(bad, "GBP")).toBeNull();
    expect(minorUnits("49.5", "JPY")).toBeNull();
  });

  it("counts a yearly price as a month's share of it (#180)", () => {
    expect(monthlyAmount({ amount: 4900, interval: "month" })).toBe(4900);
    expect(monthlyAmount({ amount: 49_000, interval: "year" })).toBe(4083);
  });
});

describe("promo codes (#178)", () => {
  const now = new Date("2026-10-23T12:00:00Z");
  const base = {
    percentOff: 50,
    amountOff: null,
    currency: null,
    months: 3,
    maxUses: 50,
    uses: 4,
    until: "2026-12-31T00:00:00Z",
    planIds: [] as string[],
    endedAt: null,
  };
  const against = { planId: "studio", currency: "GBP", now };

  it("applies until it ends, is used up, or meets another plan or currency", () => {
    expect(promoRefusal(base, against)).toBeNull();
    expect(promoRefusal({ ...base, until: "2026-10-01T00:00:00Z" }, against)).toBe(
      "That code has ended.",
    );
    expect(promoRefusal({ ...base, endedAt: "2026-10-20T00:00:00Z" }, against)).toBe(
      "That code has ended.",
    );
    expect(promoRefusal({ ...base, uses: 50 }, against)).toBe("That code has been used up.");
    expect(promoRefusal({ ...base, planIds: ["label"] }, against)).toBe(
      "That code is not for this plan.",
    );
    const amount = { ...base, percentOff: null, amountOff: 2000, currency: "EUR" };
    expect(promoRefusal(amount, against)).toBe("That code is for another currency.");
    expect(promoRefusal({ ...amount, currency: "GBP" }, against)).toBeNull();
  });

  it("is one kind of discount or the other, an amount with its currency", () => {
    const code = { code: "launch50" };
    expect(promoCodeInput.parse({ ...code, percentOff: 50 }).code).toBe("LAUNCH50");
    expect(promoCodeInput.safeParse({ ...code }).success).toBe(false);
    expect(promoCodeInput.safeParse({ ...code, percentOff: 50, amountOff: 100 }).success).toBe(
      false,
    );
    expect(promoCodeInput.safeParse({ ...code, amountOff: 2000 }).success).toBe(false);
    expect(promoCodeInput.safeParse({ ...code, amountOff: 2000, currency: "gbp" }).success).toBe(
      true,
    );
  });

  it("reads as the list shows it", () => {
    const date = (iso: string) => iso.slice(0, 10);
    expect(promoSummary(base, date)).toBe("50% off for 3 months · used 4 of 50 · until 2026-12-31");
    expect(
      promoSummary(
        { ...base, percentOff: null, amountOff: 2000, currency: "GBP", months: 1, maxUses: null },
        date,
      ),
    ).toBe("£20.00 off the first invoice · used 4 · until 2026-12-31");
    expect(promoSummary({ ...base, months: null, endedAt: "2026-10-01T00:00:00Z" }, date)).toBe(
      "50% off for good · used 4 of 50 · ended",
    );
  });
});

import type { BillingWorkspaceRow } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { workspaceActionsOf, workspaceBillingLine } from "./instance-billing";

const row: BillingWorkspaceRow = {
  id: "w",
  name: "Endless Hall Records",
  plan: { id: "studio", name: "Studio" },
  status: "active",
  price: { amount: 4900, currency: "GBP", interval: "month" },
  trialEndsAt: null,
  renewsAt: null,
  cancelsAt: null,
  subscribed: true,
  pastDueSince: null,
  overdue: null,
  dunningSuspended: false,
  credits: [],
  latestInvoice: { number: "INV-0412", issuedAt: "2026-10-01T00:00:00Z" },
};

describe("a workspace's billing actions (#445)", () => {
  it("offers a workspace paying through Stripe every action", () => {
    expect(workspaceActionsOf(row, true)).toEqual({
      promo: true,
      credit: true,
      send: true,
      waive: false,
    });
  });

  it("offers a workspace on a plan by agreement only what applies to it", () => {
    const agreed = { ...row, price: null, subscribed: false, latestInvoice: null };
    expect(workspaceActionsOf(agreed, true)).toEqual({
      promo: false,
      credit: true,
      send: false,
      waive: false,
    });
    // Owing, it can be let off.
    expect(workspaceActionsOf({ ...agreed, pastDueSince: "2026-10-01T00:00:00Z" }, false)).toEqual(
      expect.objectContaining({ waive: true }),
    );
  });

  it("offers nothing through Stripe while the gateway is off, nor a credit without a plan", () => {
    expect(workspaceActionsOf(row, false)).toMatchObject({ promo: false, credit: false });
    expect(
      workspaceActionsOf({ ...row, subscribed: false, plan: null, price: null }, false),
    ).toMatchObject({ credit: false });
  });

  it("says what credit is held for the next invoice by hand", () => {
    expect(
      workspaceBillingLine({
        ...row,
        subscribed: false,
        price: null,
        credits: [{ amount: 2500, currency: "GBP" }],
      }),
    ).toBe("Studio · invoiced by hand · £25.00 credit held");
  });
});

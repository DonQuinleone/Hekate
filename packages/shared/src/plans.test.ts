import { describe, expect, it } from "vitest";
import { formatBytes } from "./format.ts";
import {
  entitled,
  internalPlan,
  notEntitledMessage,
  planInput,
  planSummary,
  severityAllowed,
  workspacePlanInput,
} from "./plans.ts";

const studio = {
  storageQuota: 1e12,
  memberLimit: 25,
  projectLimit: null,
  features: ["forensicMarking" as const],
  severities: ["low" as const, "normal" as const, "high" as const],
};

describe("plans and entitlements (#177)", () => {
  it("includes everything on the internal plan, and only what a plan names on others", () => {
    expect(entitled(internalPlan, "sso")).toBe(true);
    expect(severityAllowed(internalPlan, "emergency")).toBe(true);
    expect(entitled(studio, "sso")).toBe(false);
    expect(entitled(studio, "forensicMarking")).toBe(true);
    expect(severityAllowed(studio, "high")).toBe(true);
    expect(severityAllowed(studio, "urgent")).toBe(false);
    expect(notEntitledMessage("sso")).toBe("Single sign-on is not on this workspace's plan.");
  });

  it("sums a plan up in a line", () => {
    expect(planSummary(studio, formatBytes)).toBe("1.0 TB · 25 members · forensic marking");
    expect(planSummary(internalPlan, formatBytes)).toMatch(/^no storage quota · no member limit/);
  });

  it("takes a plan with a key, a name and a price, or none", () => {
    const plan = {
      key: " Studio ",
      name: "Studio",
      price: { amount: 4900, currency: "gbp", interval: "month" },
      storageQuota: 1e12,
      memberLimit: 25,
      projectLimit: null,
      features: ["forensicMarking"],
      severities: ["low", "normal", "high"],
    };
    expect(planInput.parse(plan)).toMatchObject({
      key: "studio",
      price: { currency: "GBP" },
      hidden: false,
    });
    expect(planInput.safeParse({ ...plan, price: null }).success).toBe(true);
    expect(planInput.safeParse({ ...plan, key: "a b" }).success).toBe(false);
    expect(planInput.safeParse({ ...plan, features: ["teleport"] }).success).toBe(false);
    expect(planInput.safeParse({ ...plan, memberLimit: 0 }).success).toBe(false);
    expect(workspacePlanInput.parse({ planId: null })).toEqual({
      planId: null,
      status: "active",
      trialEndsAt: null,
      renewsAt: null,
    });
  });
});

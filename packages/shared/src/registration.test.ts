import { describe, expect, it } from "vitest";
import { signUpAllowed, signUpInput, slugFrom, trialEnd } from "./registration.ts";

describe("registration (#184)", () => {
  it("lets a sign-up finish only as the instance's registration allows", () => {
    expect(signUpAllowed("closed", false)).toBe(false);
    // Closed is closed: an invitation sent while it was open no longer works.
    expect(signUpAllowed("closed", true)).toBe(false);
    expect(signUpAllowed("invite", false)).toBe(false);
    expect(signUpAllowed("invite", true)).toBe(true);
    expect(signUpAllowed("open", false)).toBe(true);
    expect(signUpAllowed("open", true)).toBe(true);
  });

  it("ends a trial its days after it starts, or has none", () => {
    const now = new Date("2026-10-23T09:00:00Z");
    expect(trialEnd(14, now)?.toISOString()).toBe("2026-11-06T09:00:00.000Z");
    expect(trialEnd(0, now)).toBeNull();
  });

  it("suggests a subdomain from a name, never a kept one", () => {
    expect(slugFrom("Endless Hall Records")).toBe("endless-hall-records");
    expect(slugFrom("  Café Ensemble! ")).toBe("cafe-ensemble");
    expect(slugFrom("www")).toBe("");
    expect(slugFrom("a".repeat(60))).toHaveLength(40);
  });

  it("asks a new owner for a password of twelve characters or more", () => {
    const made = { workspace: "Endless Hall Records", slug: "endless-hall" };
    expect(signUpInput.safeParse(made).success).toBe(true);
    expect(signUpInput.safeParse({ ...made, password: "short" }).success).toBe(false);
    expect(signUpInput.safeParse({ ...made, slug: "-hall" }).success).toBe(false);
    expect(signUpInput.safeParse({ ...made, workspace: " " }).success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  applyWorkspaceSettings,
  defaultWorkspaceSettings,
  type OrganisationRole,
  reviewerDefaults,
  type SecondFactorPolicy,
  secondFactorRequired,
  workspaceSettingsInput,
  workspaceSettingsOf,
} from "./organisation.ts";

describe("workspace settings", () => {
  it("reads nothing as the defaults", () => {
    expect(workspaceSettingsOf(null)).toEqual(defaultWorkspaceSettings);
    expect(workspaceSettingsOf({})).toEqual(defaultWorkspaceSettings);
  });

  it("keeps what is valid and drops what is not, field by field", () => {
    const read = workspaceSettingsOf({
      guestLinkDays: 14,
      locale: "tlh",
      reviewer: { decide: false, comments: "everyone", windowDays: 30 },
      emailSubjects: { invitation: "Join {workspace}", decision: "{nonsense}", stale: "x" },
      stale: true,
    });
    expect(read).toEqual({
      defaultProfile: "music",
      guestLinkDays: 14,
      guestVerification: "link",
      locale: null,
      carriedCommentsShown: true,
      emailSubjects: { invitation: "Join {workspace}" },
      secondFactor: "off",
      reviewer: { comment: true, decide: false, comments: "all", windowDays: 30 },
    });
  });

  it("accepts only the offered lifetimes and windows", () => {
    expect(workspaceSettingsInput.safeParse({ guestLinkDays: 7 }).success).toBe(false);
    expect(workspaceSettingsInput.safeParse({ reviewer: { windowDays: 7 } }).success).toBe(false);
    expect(workspaceSettingsInput.safeParse({ reviewer: { windowDays: null } }).success).toBe(true);
  });

  it("refuses an empty change and unknown keys", () => {
    expect(workspaceSettingsInput.safeParse({}).success).toBe(false);
    expect(workspaceSettingsInput.safeParse({ reviewer: {} }).success).toBe(false);
    expect(workspaceSettingsInput.safeParse({ storageBackend: "s3" }).success).toBe(false);
  });

  it("merges a change into what was there", () => {
    const next = applyWorkspaceSettings(defaultWorkspaceSettings, {
      locale: "de-DE",
      carriedCommentsShown: false,
      reviewer: { decide: false },
    });
    expect(next.locale).toBe("de-DE");
    expect(next.carriedCommentsShown).toBe(false);
    expect(next.defaultProfile).toBe("music");
    expect(next.reviewer).toEqual({ ...defaultWorkspaceSettings.reviewer, decide: false });
    expect(applyWorkspaceSettings(next, { locale: null }).locale).toBeNull();
  });

  it("gives a new reviewer the defaults, with the window counted from now", () => {
    const now = new Date("2026-10-16T09:00:00Z");
    const settings = applyWorkspaceSettings(defaultWorkspaceSettings, {
      reviewer: { comments: "own", windowDays: 14 },
    });
    expect(reviewerDefaults(settings, now)).toMatchObject({
      comment: true,
      decide: true,
      comments: "own",
      startsAt: null,
      expiresAt: "2026-10-30T09:00:00.000Z",
    });
    expect(reviewerDefaults(defaultWorkspaceSettings, now).expiresAt).toBeNull();
  });
});

describe("secondFactorRequired", () => {
  const ask = (policy: SecondFactorPolicy, role: OrganisationRole, instance = false) =>
    secondFactorRequired({ instance, policy, role });

  it("asks no one when neither the workspace nor the instance does", () => {
    expect(ask("off", "owner")).toBe(false);
  });

  it("asks owners and admins first, then everyone", () => {
    expect(ask("admins", "owner")).toBe(true);
    expect(ask("admins", "admin")).toBe(true);
    expect(ask("admins", "member")).toBe(false);
    expect(ask("everyone", "member")).toBe(true);
  });

  it("asks every account when the instance does, whatever the workspace says", () => {
    expect(ask("off", "member", true)).toBe(true);
  });

  it("reads a stored policy, and falls back to off", () => {
    expect(workspaceSettingsOf({ secondFactor: "admins" }).secondFactor).toBe("admins");
    expect(workspaceSettingsOf({ secondFactor: "sometimes" }).secondFactor).toBe("off");
  });
});

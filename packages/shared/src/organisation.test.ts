import { describe, expect, it } from "vitest";
import {
  applyWorkspaceSettings,
  defaultWorkspaceSettings,
  factorDemand,
  methodsFor,
  type OrganisationRole,
  orList,
  reviewerDefaults,
  type SecondFactorPolicy,
  secondFactorRequired,
  sessionEndsAt,
  sessionMeets,
  sessionMethod,
  workspaceSettingsInput,
  workspaceSettingsOf,
} from "./organisation.ts";

describe("sign-in methods (decision 248)", () => {
  it("reads a session from before it kept its way in from how it was signed in", () => {
    expect(sessionMethod({ method: "directory", factor: "password" })).toBe("directory");
    expect(sessionMethod({ factor: "passkey" })).toBe("passkey");
    expect(sessionMethod({ factor: "second_factor" })).toBe("password");
    expect(sessionMethod({ factor: "password", ssoProviderId: "acme" })).toBe("sso");
  });

  it("lets an owner keep their own way in where only another system's is allowed", () => {
    expect(methodsFor(["sso"], "member")).toEqual(["sso"]);
    expect(methodsFor(["sso"], "admin")).toEqual(["sso"]);
    expect(methodsFor(["directory", "sso"], "owner")).toEqual([
      "password",
      "passkey",
      "sso",
      "directory",
    ]);
    // Where a password or a passkey is allowed, an owner is held to the set like anyone.
    expect(methodsFor(["passkey", "sso"], "owner")).toEqual(["passkey", "sso"]);
  });

  it("is allowed every way until the workspace says otherwise, and never none", () => {
    expect(workspaceSettingsOf({}).signInMethods).toEqual([
      "password",
      "passkey",
      "sso",
      "directory",
    ]);
    expect(workspaceSettingsOf({ signInMethods: [] }).signInMethods).toHaveLength(4);
    expect(workspaceSettingsInput.safeParse({ signInMethods: [] }).success).toBe(false);
    expect(workspaceSettingsInput.safeParse({ signInMethods: ["ldap"] }).success).toBe(false);
    expect(workspaceSettingsInput.safeParse({ signInMethods: ["passkey"] }).success).toBe(true);
  });

  it("lists the ways in as a sentence does", () => {
    expect(orList(["a password"])).toBe("a password");
    expect(orList(["a password", "a passkey", "single sign-on"])).toBe(
      "a password, a passkey or single sign-on",
    );
  });
});

describe("session length (decision 248)", () => {
  const day = 24 * 60 * 60 * 1000;
  const createdAt = new Date("2026-10-01T09:00:00Z");
  const expiresAt = new Date(createdAt.getTime() + 14 * day);
  it("ends at the instance's expiry, or the workspace's days from signing in if sooner", () => {
    expect(sessionEndsAt({ createdAt, expiresAt }, null)).toEqual(expiresAt);
    expect(sessionEndsAt({ createdAt, expiresAt }, 1)).toEqual(new Date(createdAt.getTime() + day));
    expect(sessionEndsAt({ createdAt, expiresAt }, 30)).toEqual(expiresAt);
  });

  it("takes only the lengths offered", () => {
    expect(workspaceSettingsOf({}).sessionDays).toBeNull();
    expect(workspaceSettingsOf({ sessionDays: 3 }).sessionDays).toBeNull();
    expect(workspaceSettingsInput.safeParse({ sessionDays: 7 }).success).toBe(true);
    expect(workspaceSettingsInput.safeParse({ sessionDays: 3 }).success).toBe(false);
    expect(workspaceSettingsInput.safeParse({ sessionDays: null }).success).toBe(true);
  });
});

describe("workspace settings", () => {
  it("reads nothing as the defaults", () => {
    expect(workspaceSettingsOf(null)).toEqual(defaultWorkspaceSettings);
    expect(workspaceSettingsOf({})).toEqual(defaultWorkspaceSettings);
  });

  it("keeps what is valid and drops what is not, field by field", () => {
    const read = workspaceSettingsOf({
      guestLinkDays: 14,
      locale: "tlh",
      reviewer: {
        decide: false,
        comments: "everyone",
        download: "all",
        history: true,
        windowDays: 30,
      },
      emailSubjects: { invitation: "Join {workspace}", decision: "{nonsense}", stale: "x" },
      deliveryProfile: "vinyl",
      roleTools: { Reviewer: ["score"], Viewer: ["x-ray"], Mixer: ["qa"] },
      dateFormat: "day-month-year",
      timeFormat: "13h",
      stale: true,
    });
    expect(read).toEqual({
      defaultProfile: "music",
      guestLinkDays: 14,
      guestVerification: "link",
      locale: null,
      dateFormat: "day-month-year",
      timeFormat: null,
      carriedCommentsShown: true,
      deliveryProfile: null,
      emailSubjects: { invitation: "Join {workspace}" },
      secondFactor: "off",
      securityKeyForAdmins: false,
      signInMethods: defaultWorkspaceSettings.signInMethods,
      sessionDays: null,
      forensicAudio: false,
      roleTools: { ...defaultWorkspaceSettings.roleTools, Reviewer: ["score"] },
      reviewer: {
        comment: true,
        decide: false,
        comments: "all",
        history: true,
        download: "none",
        windowDays: 30,
      },
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
    // Forensic marking is the owners' alone, through its own route.
    expect(workspaceSettingsInput.safeParse({ forensicAudio: false }).success).toBe(false);
  });

  it("starts the default roles on their usual tools, and takes a change role by role (#55)", () => {
    expect(defaultWorkspaceSettings.roleTools.Producer).toContain("qa");
    expect(defaultWorkspaceSettings.roleTools.Reviewer).toEqual([
      "score",
      "compare",
      "loops",
      "normalise",
    ]);
    expect(defaultWorkspaceSettings.roleTools.Viewer).toEqual(["score"]);
    const next = applyWorkspaceSettings(defaultWorkspaceSettings, {
      roleTools: { Viewer: [] },
    });
    expect(next.roleTools).toEqual({ ...defaultWorkspaceSettings.roleTools, Viewer: [] });
    expect(workspaceSettingsInput.safeParse({ roleTools: {} }).success).toBe(false);
    expect(workspaceSettingsInput.safeParse({ roleTools: { Mixer: [] } }).success).toBe(false);
    expect(workspaceSettingsInput.safeParse({ roleTools: { Viewer: ["x-ray"] } }).success).toBe(
      false,
    );
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

describe("what a sign-in must have been", () => {
  const demand = (
    policy: SecondFactorPolicy,
    role: OrganisationRole,
    securityKeyForAdmins = false,
  ) => factorDemand({ instance: false, policy, securityKeyForAdmins, role });

  it("takes a password alone where nothing is asked", () => {
    expect(sessionMeets("password", demand("off", "owner"))).toBe(true);
  });

  it("takes a code app or a passkey where a second factor is asked", () => {
    const asked = demand("everyone", "member");
    expect(sessionMeets("password", asked)).toBe(false);
    expect(sessionMeets("second_factor", asked)).toBe(true);
    expect(sessionMeets("passkey", asked)).toBe(true);
  });

  it("takes only a passkey from owners and admins where a hardware security key is asked", () => {
    const admin = demand("off", "admin", true);
    expect(admin).toEqual({ secondFactor: true, securityKey: true });
    expect(sessionMeets("second_factor", admin)).toBe(false);
    expect(sessionMeets("passkey", admin)).toBe(true);
    expect(demand("off", "member", true)).toEqual({ secondFactor: false, securityKey: false });
  });
});

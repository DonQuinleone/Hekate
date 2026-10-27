import { describe, expect, it } from "vitest";
import {
  assetPolicyOf,
  cappedDownload,
  defaultAssetPolicy,
  narrowedByPolicy,
} from "./asset-policy.ts";
import { defaultWorkflowNotices, withinChannels, workflowNoticesOf } from "./notifications.ts";
import { type ProjectPermission, projectPermissions } from "./roles.ts";
import { exceptedTools, toolExceptionInput } from "./tool-exceptions.ts";

const every = new Set<ProjectPermission>(projectPermissions);

describe("a project's downloads and deletion (decision 257)", () => {
  it("reads the default until the project chooses, and anything malformed as the default", () => {
    expect(assetPolicyOf(null)).toEqual(defaultAssetPolicy);
    expect(assetPolicyOf({ downloads: "everyone" })).toEqual(defaultAssetPolicy);
    expect(defaultAssetPolicy).toMatchObject({ keepReviewed: true, forensicDownloads: true });
  });

  it("only narrows what a role grants", () => {
    expect(narrowedByPolicy(every, defaultAssetPolicy, "member")).toEqual(every);
    const nobody = narrowedByPolicy(every, { ...defaultAssetPolicy, downloads: "nobody" }, "owner");
    expect(nobody.has("download_proxy") || nobody.has("download_original")).toBe(false);
    const never = narrowedByPolicy(every, { ...defaultAssetPolicy, originals: "never" }, "owner");
    expect([never.has("download_proxy"), never.has("download_original")]).toEqual([true, false]);
    const owners = { ...defaultAssetPolicy, originals: "owners", deletion: "owners" } as const;
    expect(narrowedByPolicy(every, owners, "admin")).toEqual(every);
    const member = narrowedByPolicy(every, owners, "member");
    expect([member.has("download_original"), member.has("delete_files")]).toEqual([false, false]);
    // Nothing the role lacked is given.
    expect(narrowedByPolicy(new Set(["view"]), defaultAssetPolicy, "member")).toEqual(
      new Set(["view"]),
    );
  });

  it("caps a guest's download from their review", () => {
    expect(cappedDownload("original", defaultAssetPolicy)).toBe("original");
    expect(cappedDownload("original", { ...defaultAssetPolicy, originals: "owners" })).toBe(
      "proxy",
    );
    expect(cappedDownload("proxy", { ...defaultAssetPolicy, originals: "never" })).toBe("proxy");
    expect(cappedDownload("original", { ...defaultAssetPolicy, downloads: "nobody" })).toBe("none");
    expect(cappedDownload("none", defaultAssetPolicy)).toBe("none");
  });
});

describe("exceptions to the player tools (decision 258)", () => {
  const role = new Set(["score", "loops"] as const);
  it("takes a person's own exception, else their groups' together, else their role's", () => {
    expect(exceptedTools(role, null, [])).toEqual(role);
    expect(exceptedTools(role, ["qa"], [["meters"]])).toEqual(new Set(["qa"]));
    expect(exceptedTools(role, null, [["meters"], ["qa", "meters"]])).toEqual(
      new Set(["qa", "meters"]),
    );
    expect(exceptedTools(role, [], [])).toEqual(new Set());
    // Tools that no longer exist are dropped.
    expect(exceptedTools(role, ["takes", "score"], [])).toEqual(new Set(["score"]));
  });

  it("never gives a guest a tool their review does not", () => {
    expect(exceptedTools(role, ["qa", "score"], [], true)).toEqual(new Set(["score"]));
    expect(exceptedTools(role, null, [["qa"]], true)).toEqual(new Set());
  });

  it("names exactly one person or group", () => {
    expect(toolExceptionInput.safeParse({ tools: [] }).success).toBe(false);
    expect(
      toolExceptionInput.safeParse({
        userId: "u1",
        groupId: "01929b8e-5c1a-7d3e-9f40-2b6c8d1e4a57",
        tools: [],
      }).success,
    ).toBe(false);
    expect(toolExceptionInput.parse({ userId: "u1", tools: ["qa", "qa"] }).tools).toEqual(["qa"]);
    expect(toolExceptionInput.safeParse({ userId: "u1", tools: ["takes"] }).success).toBe(false);
  });
});

describe("who a project's workflow tells (decision 259)", () => {
  it("reads the default until the project chooses", () => {
    expect(workflowNoticesOf(undefined)).toEqual(defaultWorkflowNotices);
    expect(defaultWorkflowNotices).toEqual({ app: true, mail: true, everyoneOnStatus: false });
  });

  it("keeps each person's choice within what the sender allows", () => {
    expect(withinChannels({ app: true, mail: true }, undefined)).toEqual({ app: true, mail: true });
    expect(withinChannels({ app: true, mail: false }, { app: false, mail: true })).toEqual({
      app: false,
      mail: false,
    });
  });
});

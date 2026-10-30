import { describe, expect, it } from "vitest";
import { leaveRefusal, managesOwners, projectLeaveInput, stepDownRefusal } from "./owners.ts";
import { permissionsFor, playerTools, projectPermissions, toolsFor } from "./roles.ts";

describe("project owners", () => {
  it("hold every permission and every tool, whatever their role says", () => {
    expect(permissionsFor("member", ["view"], true)).toEqual(new Set(projectPermissions));
    expect(permissionsFor("member", null, true)).toEqual(new Set(projectPermissions));
    expect(toolsFor("member", [], true)).toEqual(new Set(playerTools));
    // The same role, held by someone who is not an owner, gives only itself.
    expect(permissionsFor("member", ["view"])).toEqual(new Set(["view"]));
    expect(toolsFor("member", ["score"])).toEqual(new Set(["score"]));
  });

  it("let an owner step down only while another owner remains", () => {
    expect(stepDownRefusal(["a", "b"], "a")).toBeNull();
    expect(stepDownRefusal(["a"], "a")).toBe("last_owner");
    expect(stepDownRefusal(["a"], "b")).toBe("not_owner");
  });

  it("ask the last owner who takes over before they leave", () => {
    expect(leaveRefusal(["a"], "a", undefined)).toBe("successor_needed");
    expect(leaveRefusal(["a"], "a", "a")).toBe("successor_is_you");
    expect(leaveRefusal(["a"], "a", "b")).toBeNull();
    // Another owner remains, or they are not one: they simply go.
    expect(leaveRefusal(["a", "b"], "a", undefined)).toBeNull();
    expect(leaveRefusal(["a"], "c", undefined)).toBeNull();
  });

  it("are made and unmade by owners and the workspace's owners and admins", () => {
    expect(managesOwners("member", true)).toBe(true);
    expect(managesOwners("admin", false)).toBe(true);
    expect(managesOwners("owner", false)).toBe(true);
    expect(managesOwners("member", false)).toBe(false);
    expect(managesOwners(null, false)).toBe(false);
  });

  it("validate a leaving", () => {
    expect(projectLeaveInput.parse({})).toEqual({});
    expect(projectLeaveInput.safeParse({ successorId: "" }).success).toBe(false);
  });
});

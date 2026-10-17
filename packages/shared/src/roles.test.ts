import { describe, expect, it } from "vitest";
import {
  defaultProjectRoles,
  defaultRoleLevels,
  levelsOf,
  type ProjectPermission,
  permissionsFor,
  permissionsOfLevels,
  projectPermissions,
  roleInput,
} from "./roles.ts";

const role = (name: string) => defaultProjectRoles.find((r) => r.name === name)?.permissions ?? [];
const can = (name: string, permission: ProjectPermission) =>
  permissionsFor("member", role(name)).has(permission);

describe("default project roles", () => {
  it("match the matrix in docs/domain.md", () => {
    const all = ["Producer", "Engineer", "Editor", "Reviewer", "Viewer"];
    const team = ["Producer", "Engineer", "Editor"];
    const matrix: Record<ProjectPermission, string[]> = {
      view: all,
      upload: team,
      organise: team,
      delete_files: ["Producer"],
      read_comments: all,
      comment: ["Producer", "Engineer", "Editor", "Reviewer"],
      triage: team,
      decide: ["Producer", "Reviewer"],
      request_reviews: ["Producer"],
      manage_reviewers: ["Producer"],
      download_proxy: team,
      download_original: team,
      view_takes: all,
      edit_takes: team,
      view_production: team,
      edit_production: ["Producer"],
      view_workflows: all,
      edit_workflows: ["Producer"],
      view_people: all,
      manage_roles: ["Producer"],
      edit_project: ["Producer"],
      delete_project: ["Producer"],
    };
    for (const permission of projectPermissions) {
      const holders = defaultProjectRoles.map((r) => r.name).filter((n) => can(n, permission));
      expect(holders, permission).toEqual(matrix[permission]);
    }
  });
});

describe("permissions", () => {
  it("lets organisation owners and admins do everything, with or without a role", () => {
    expect(permissionsFor("owner", null).size).toBe(projectPermissions.length);
    expect(permissionsFor("admin", role("Viewer")).size).toBe(projectPermissions.length);
  });

  it("gives members nothing without a role, or with a role that cannot view", () => {
    expect(permissionsFor("member", null).size).toBe(0);
    expect(permissionsFor("member", ["comment", "upload"]).size).toBe(0);
  });

  it("ignores permissions it does not know", () => {
    expect([...permissionsFor("member", ["view", "fly"])]).toEqual(["view"]);
  });

  it("orders, de-duplicates and closes a role's permissions on input", () => {
    expect(
      roleInput.parse({ name: " Mixer ", permissions: ["comment", "view", "comment"] }),
    ).toEqual({ name: "Mixer", permissions: ["view", "read_comments", "comment"] });
    expect(roleInput.safeParse({ name: "x", permissions: ["fly"] }).success).toBe(false);
  });
});

describe("access levels", () => {
  it("grant each level's permissions and everything below it, and read back", () => {
    const viewer = defaultRoleLevels.find((r) => r.name === "Viewer")?.levels;
    if (!viewer) throw new Error("No Viewer");
    const permissions = permissionsOfLevels({ ...viewer, comments: "triage", downloads: "proxy" });
    expect(permissions).toEqual(
      expect.arrayContaining(["read_comments", "comment", "triage", "download_proxy"]),
    );
    expect(permissions).not.toContain("download_original");
    expect(levelsOf(permissions)).toEqual({ ...viewer, comments: "triage", downloads: "proxy" });
  });

  it("close a list of permissions upwards, so a role is always one level per area", () => {
    const made = roleInput.parse({ name: "Copyist", permissions: ["view", "triage"] });
    expect(made.permissions).toEqual(["view", "read_comments", "comment", "triage"]);
    expect(roleInput.safeParse({ name: "Nothing" }).success).toBe(false);
  });
});

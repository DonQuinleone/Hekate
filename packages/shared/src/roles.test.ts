import { describe, expect, it } from "vitest";
import {
  defaultProjectRoles,
  type ProjectPermission,
  permissionsFor,
  projectPermissions,
  roleInput,
} from "./roles.ts";

const role = (name: string) => defaultProjectRoles.find((r) => r.name === name)?.permissions ?? [];
const can = (name: string, permission: ProjectPermission) =>
  permissionsFor("member", role(name)).has(permission);

describe("default project roles", () => {
  it("match the matrix in docs/domain.md", () => {
    const matrix: Record<ProjectPermission, string[]> = {
      view: ["Producer", "Engineer", "Editor", "Reviewer", "Viewer"],
      upload: ["Producer", "Engineer", "Editor"],
      organise: ["Producer", "Engineer", "Editor"],
      comment: ["Producer", "Engineer", "Editor", "Reviewer"],
      request_reviews: ["Producer"],
      manage_reviewers: ["Producer"],
      triage: ["Producer", "Engineer", "Editor"],
      decide: ["Producer", "Reviewer"],
      edit_workflows: ["Producer"],
      manage_roles: ["Producer"],
      download_proxy: ["Producer", "Engineer", "Editor"],
      download_original: ["Producer", "Engineer", "Editor"],
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

  it("orders and de-duplicates a role's permissions on input", () => {
    expect(
      roleInput.parse({ name: " Mixer ", permissions: ["comment", "view", "comment"] }),
    ).toEqual({ name: "Mixer", permissions: ["view", "comment"] });
    expect(roleInput.safeParse({ name: "x", permissions: ["fly"] }).success).toBe(false);
  });
});

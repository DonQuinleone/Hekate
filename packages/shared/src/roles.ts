import { z } from "zod";
import type { OrganisationRole } from "./organisation.ts";

/**
 * What a project role may do. The list is fixed: roles are named sets of these, made per
 * project (docs/domain.md, Access).
 */
export const projectPermissions = [
  "view",
  "upload",
  "organise",
  "comment",
  "request_reviews",
  "manage_reviewers",
  "triage",
  "decide",
  "edit_workflows",
  "manage_roles",
] as const;
export const projectPermission = z.enum(projectPermissions);
export type ProjectPermission = z.infer<typeof projectPermission>;

/** How each permission reads in the roles screen. */
export const permissionNames: Record<ProjectPermission, string> = {
  view: "View files and tracks",
  upload: "Upload files, versions, takes",
  organise: "Organise folders and tracks",
  comment: "Comment",
  request_reviews: "Request reviews",
  manage_reviewers: "Add or remove reviewers and guests",
  triage: "Triage feedback (resolve, assign)",
  decide: "Record an approval decision",
  edit_workflows: "Edit workflows",
  manage_roles: "Manage roles and members",
};

/** The roles every new project starts with, in order, as in docs/domain.md. */
export const defaultProjectRoles: { name: string; permissions: ProjectPermission[] }[] = [
  { name: "Producer", permissions: [...projectPermissions] },
  { name: "Engineer", permissions: ["view", "upload", "organise", "comment", "triage"] },
  { name: "Editor", permissions: ["view", "upload", "organise", "comment", "triage"] },
  { name: "Reviewer", permissions: ["view", "comment", "decide"] },
  { name: "Viewer", permissions: ["view"] },
];

/** The role a project's creator takes. */
export const creatorRole = "Producer";

/**
 * What someone may do in a project. Organisation owners and admins may do everything in
 * every project; anyone else, what their project role allows, and nothing (not even see
 * the project) without one. A role without `view` grants nothing either: seeing a project
 * comes first.
 */
export function permissionsFor(
  organisationRole: OrganisationRole,
  projectRolePermissions: readonly string[] | null,
): Set<ProjectPermission> {
  if (organisationRole === "owner" || organisationRole === "admin") {
    return new Set(projectPermissions);
  }
  const granted = new Set(
    (projectRolePermissions ?? []).filter((p): p is ProjectPermission =>
      (projectPermissions as readonly string[]).includes(p),
    ),
  );
  return granted.has("view") ? granted : new Set();
}

export const roleInput = z.object({
  name: z.string().trim().min(1).max(60),
  permissions: z
    .array(projectPermission)
    .max(projectPermissions.length)
    .transform((list) => projectPermissions.filter((p) => list.includes(p))),
});

export const projectMemberInput = z.object({
  roleId: z.uuid(),
});

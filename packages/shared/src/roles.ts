import { z } from "zod";
import type { OrganisationRole } from "./organisation.ts";

/**
 * What a project role may do. The list is fixed: roles are named sets of these, made per
 * project (docs/domain.md, Access). People choose them as a level in each area (below);
 * the permissions are what the server checks.
 */
export const projectPermissions = [
  "view",
  "upload",
  "organise",
  "delete_files",
  "read_comments",
  "comment",
  "triage",
  "decide",
  "request_reviews",
  "manage_reviewers",
  "download_proxy",
  "download_original",
  "view_takes",
  "edit_takes",
  "view_production",
  "edit_production",
  "view_workflows",
  "edit_workflows",
  "view_people",
  "manage_roles",
  "edit_project",
  "delete_project",
] as const;
export const projectPermission = z.enum(projectPermissions);

/** The permissions that only look: what a role keeps while its project is archived. */
export const lookingPermissions: readonly ProjectPermission[] = [
  "view",
  "read_comments",
  "view_takes",
  "view_production",
  "view_workflows",
  "view_people",
];
export type ProjectPermission = z.infer<typeof projectPermission>;

/** How each permission reads where one is named on its own. */
export const permissionNames: Record<ProjectPermission, string> = {
  view: "View files and tracks",
  upload: "Upload files, versions, takes",
  organise: "Organise folders and tracks",
  delete_files: "Delete files and folders",
  read_comments: "Read comments",
  comment: "Comment",
  triage: "Triage feedback (resolve, assign)",
  decide: "Respond to reviews and record decisions",
  request_reviews: "Request reviews",
  manage_reviewers: "Add or remove reviewers and guests",
  download_proxy: "Download proxies, marked and logged",
  download_original: "Download originals, marked and logged",
  view_takes: "See sessions and takes",
  edit_takes: "Edit sessions and takes",
  view_production: "See the production tools",
  edit_production: "Use the production tools",
  view_workflows: "See the workflow",
  edit_workflows: "Edit workflows",
  view_people: "See who is in the project",
  manage_roles: "Manage roles and members",
  edit_project: "Edit the project's settings",
  delete_project: "Archive and delete the project",
};

/**
 * Access by area (#142): each area has levels, each level grants its own permissions and
 * everything below it, and a role holds one level in each area.
 */
export const accessAreas = [
  {
    id: "files",
    label: "Files",
    hint: "Folders, tracks, versions and variations",
    levels: [
      { id: "none", label: "None", grants: [] },
      { id: "view", label: "View", grants: ["view"] },
      { id: "upload", label: "Upload", grants: ["upload"] },
      { id: "organise", label: "Organise", grants: ["organise"] },
      { id: "delete", label: "Delete", grants: ["delete_files"] },
    ],
  },
  {
    id: "comments",
    label: "Comments",
    hint: "Reading, writing, and triaging anyone's",
    levels: [
      { id: "none", label: "None", grants: [] },
      { id: "read", label: "Read", grants: ["read_comments"] },
      { id: "write", label: "Write", grants: ["comment"] },
      { id: "triage", label: "Triage", grants: ["triage"] },
    ],
  },
  {
    id: "reviews",
    label: "Reviews",
    hint: "Responding, requesting, inviting and revoking reviewers",
    levels: [
      { id: "none", label: "None", grants: [] },
      { id: "respond", label: "Respond", grants: ["decide"] },
      { id: "request", label: "Request", grants: ["request_reviews"] },
      { id: "manage", label: "Manage", grants: ["manage_reviewers"] },
    ],
  },
  {
    id: "downloads",
    label: "Downloads",
    hint: "The proxy, or the original, made for each person and logged",
    levels: [
      { id: "none", label: "None", grants: [] },
      { id: "proxy", label: "Proxy", grants: ["download_proxy"] },
      { id: "original", label: "Original", grants: ["download_original"] },
    ],
  },
  {
    id: "takes",
    label: "Sessions and takes",
    hint: "Seeing the take manager, or editing it",
    levels: [
      { id: "none", label: "None", grants: [] },
      { id: "view", label: "View", grants: ["view_takes"] },
      { id: "edit", label: "Edit", grants: ["edit_takes"] },
    ],
  },
  {
    id: "production",
    label: "Production tools",
    hint: "Schedule, take log, score marking, stage plan",
    levels: [
      { id: "none", label: "None", grants: [] },
      { id: "view", label: "View", grants: ["view_production"] },
      { id: "edit", label: "Edit", grants: ["edit_production"] },
    ],
  },
  {
    id: "workflow",
    label: "Workflow",
    hint: "Stages, statuses, categories and upload checks",
    levels: [
      { id: "none", label: "None", grants: [] },
      { id: "view", label: "View", grants: ["view_workflows"] },
      { id: "edit", label: "Edit", grants: ["edit_workflows"] },
    ],
  },
  {
    id: "people",
    label: "Roles and people",
    hint: "Who is in the project and what they may do",
    levels: [
      { id: "none", label: "None", grants: [] },
      { id: "view", label: "View", grants: ["view_people"] },
      { id: "manage", label: "Manage", grants: ["manage_roles"] },
    ],
  },
  {
    id: "project",
    label: "Project",
    hint: "Settings, archiving and deletion",
    levels: [
      { id: "none", label: "None", grants: [] },
      { id: "settings", label: "Edit", grants: ["edit_project"] },
      { id: "delete", label: "Delete", grants: ["delete_project"] },
    ],
  },
] as const satisfies readonly {
  id: string;
  label: string;
  hint: string;
  levels: readonly { id: string; label: string; grants: readonly ProjectPermission[] }[];
}[];
export type AccessArea = (typeof accessAreas)[number]["id"];
export type AccessLevels = {
  [A in (typeof accessAreas)[number] as A["id"]]: A["levels"][number]["id"];
};

/** The permissions a set of levels grants: each level's own and those below it. */
export function permissionsOfLevels(levels: AccessLevels): ProjectPermission[] {
  const granted = new Set<ProjectPermission>();
  for (const area of accessAreas) {
    const at = area.levels.findIndex((l) => l.id === levels[area.id]);
    for (const level of area.levels.slice(0, at + 1)) for (const p of level.grants) granted.add(p);
  }
  return projectPermissions.filter((p) => granted.has(p));
}

/** The level a role holds in each area: the highest whose permissions it has. */
export function levelsOf(permissions: readonly string[]): AccessLevels {
  const held = new Set(permissions);
  const levels: Record<string, string> = {};
  for (const area of accessAreas) {
    let reached: string = area.levels[0].id;
    for (const level of area.levels) if (level.grants.some((p) => held.has(p))) reached = level.id;
    levels[area.id] = reached;
  }
  return levels as AccessLevels;
}

export const accessLevelsInput = z.object(
  Object.fromEntries(
    accessAreas.map((a) => [a.id, z.enum(a.levels.map((l) => l.id) as [string, ...string[]])]),
  ),
) as unknown as z.ZodType<AccessLevels>;

/** The roles every new project starts with, in order, as in docs/domain.md. */
export const defaultRoleLevels: { name: string; levels: AccessLevels }[] = [
  {
    name: "Producer",
    levels: {
      files: "delete",
      comments: "triage",
      reviews: "manage",
      downloads: "original",
      takes: "edit",
      production: "edit",
      workflow: "edit",
      people: "manage",
      project: "delete",
    },
  },
  ...["Engineer", "Editor"].map((name) => ({
    name,
    levels: {
      files: "organise",
      comments: "triage",
      reviews: "none",
      downloads: "original",
      takes: "edit",
      production: "view",
      workflow: "view",
      people: "view",
      project: "none",
    } as AccessLevels,
  })),
  {
    name: "Reviewer",
    levels: {
      files: "view",
      comments: "write",
      reviews: "respond",
      downloads: "none",
      takes: "view",
      production: "none",
      workflow: "view",
      people: "view",
      project: "none",
    },
  },
  {
    name: "Viewer",
    levels: {
      files: "view",
      comments: "read",
      reviews: "none",
      downloads: "none",
      takes: "view",
      production: "none",
      workflow: "view",
      people: "view",
      project: "none",
    },
  },
];

/** The default roles as the permissions they hold. */
/**
 * The player's tools, on or off per role (#240): what the recording page shows each role.
 * QA, meters and the spectrogram are refused by the server too; the rest are interface.
 */
export const playerTools = [
  "qa",
  "meters",
  "spectrogram",
  "score",
  "compare",
  "loops",
  "normalise",
] as const;
export type PlayerTool = (typeof playerTools)[number];
export const playerTool = z.enum(playerTools);

/** What a role that only looks and listens has: the score, compare, loops and normalising. */
export const listeningTools: PlayerTool[] = ["score", "compare", "loops", "normalise"];

/** The tools each default role starts with: the engineer's for those who make the record. */
const defaultTools: Record<string, PlayerTool[]> = {
  Reviewer: listeningTools,
  Viewer: ["score"],
};

export const defaultProjectRoles: {
  name: string;
  permissions: ProjectPermission[];
  tools: PlayerTool[];
}[] = defaultRoleLevels.map((r) => ({
  name: r.name,
  permissions: permissionsOfLevels(r.levels),
  tools: defaultTools[r.name] ?? [...playerTools],
}));

/** The tools someone has in a project: every one for owners and admins, else their role's. */
export function toolsFor(
  organisationRole: OrganisationRole,
  roleTools: readonly string[] | null,
): Set<PlayerTool> {
  if (organisationRole === "owner" || organisationRole === "admin") return new Set(playerTools);
  return new Set(
    (roleTools ?? []).filter((t): t is PlayerTool =>
      (playerTools as readonly string[]).includes(t),
    ),
  );
}

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

/**
 * A role as people make it: a name and either a level in each area or a list of
 * permissions, which is closed upwards the same way (triage brings comment and reading),
 * so a role always reads as one level per area.
 */
export const roleInput = z
  .object({
    name: z.string().trim().min(1).max(60),
    levels: accessLevelsInput.optional(),
    permissions: z.array(projectPermission).max(projectPermissions.length).optional(),
    /** Its player tools; left out, a new role listens and a changed one keeps its own. */
    tools: z.array(playerTool).max(playerTools.length).optional(),
  })
  .refine((r) => r.levels || r.permissions, { message: "Say what the role may do" })
  .transform((r) => ({
    name: r.name,
    permissions: permissionsOfLevels(r.levels ?? levelsOf(r.permissions ?? [])),
    tools: r.tools && [...new Set(r.tools)],
  }));

export const projectMemberInput = z.object({
  roleId: z.uuid(),
});

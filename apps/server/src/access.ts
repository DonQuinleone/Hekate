import { type Database, inOrg, schema } from "@hekate/db";
import { type OrganisationRole, type ProjectPermission, permissionsFor } from "@hekate/shared";
import { and, eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { NotFound } from "./errors.ts";

const { projects, projectMembers, projectRoles, files } = schema;

/** Who is asking: the session's user, in the organisation the request is scoped to. */
export interface Actor {
  userId: string;
  organisationId: string;
  organisationRole: OrganisationRole;
}

/** The actor's tenant variables, as every `/api` route has them. */
export const actorOf = (vars: Actor): Actor => ({
  userId: vars.userId,
  organisationId: vars.organisationId,
  organisationRole: vars.organisationRole,
});

/**
 * What the actor may do in a project, or null when they may not see it (or it does not
 * exist in their organisation). Organisation owners and admins may do everything.
 */
export async function projectAccess(
  db: Pick<Database, "select">,
  actor: Actor,
  projectId: string,
): Promise<{ projectId: string; permissions: Set<ProjectPermission> } | null> {
  const [row] = await db
    .select({ id: projects.id, permissions: projectRoles.permissions })
    .from(projects)
    .leftJoin(
      projectMembers,
      and(
        eq(projectMembers.projectId, projects.id),
        eq(projectMembers.organisationId, actor.organisationId),
        eq(projectMembers.userId, actor.userId),
      ),
    )
    .leftJoin(
      projectRoles,
      and(
        eq(projectRoles.id, projectMembers.roleId),
        eq(projectRoles.organisationId, actor.organisationId),
      ),
    )
    .where(inOrg(projects, actor.organisationId, eq(projects.id, projectId)));
  if (!row) return null;
  const permissions = permissionsFor(actor.organisationRole, row.permissions);
  return permissions.has("view") ? { projectId: row.id, permissions } : null;
}

/**
 * The one check every project route makes: the project as the actor may see it, or 404
 * (a project you cannot see does not exist for you), and 403 when the actor sees it but
 * lacks the permission.
 */
export async function can(
  db: Pick<Database, "select">,
  actor: Actor,
  permission: ProjectPermission,
  projectId: string,
) {
  const access = await projectAccess(db, actor, projectId);
  if (!access) throw new NotFound("Project");
  if (!access.permissions.has(permission)) {
    throw new HTTPException(403, { message: "Your role in this project does not allow that" });
  }
  return access;
}

/** What the actor may do with a file, or null when they may not see it. */
export async function fileAccess(db: Pick<Database, "select">, actor: Actor, fileId: string) {
  const [file] = await db
    .select({ projectId: files.projectId })
    .from(files)
    .where(inOrg(files, actor.organisationId, eq(files.id, fileId)));
  return file ? projectAccess(db, actor, file.projectId) : null;
}

/** As `can`, for a file: 404 for a file the actor cannot see. Returns the file's project. */
export async function canOnFile(
  db: Pick<Database, "select">,
  actor: Actor,
  permission: ProjectPermission,
  fileId: string,
) {
  const access = await fileAccess(db, actor, fileId);
  if (!access) throw new NotFound("File");
  if (!access.permissions.has(permission)) {
    throw new HTTPException(403, { message: "Your role in this project does not allow that" });
  }
  return access;
}

/**
 * A condition for project lists: the projects the actor may see. Owners and admins see
 * every project in the organisation; members, those where their role allows viewing.
 */
export function visibleProjects(actor: Actor) {
  if (actor.organisationRole === "owner" || actor.organisationRole === "admin") return undefined;
  return sql`exists (
    select 1 from ${projectMembers}
    join ${projectRoles} on ${projectRoles.id} = ${projectMembers.roleId}
      and ${projectRoles.organisationId} = ${actor.organisationId}
    where ${projectMembers.projectId} = ${projects.id}
      and ${projectMembers.organisationId} = ${actor.organisationId}
      and ${projectMembers.userId} = ${actor.userId}
      and 'view' = any(${projectRoles.permissions})
  )`;
}

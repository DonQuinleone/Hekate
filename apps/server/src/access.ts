import { type Database, inOrg, schema } from "@hekate/db";
import {
  mergeGrants,
  type OrganisationRole,
  type ProjectPermission,
  permissionsFor,
  type ReviewerPermissions,
  withinWindow,
} from "@hekate/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { NotFound } from "./errors.ts";

const {
  projects,
  projectMembers,
  projectRoles,
  files,
  reviews,
  reviewItems,
  reviewReviewers,
  versions,
  variations,
} = schema;

/** A signed-in member, in the organisation the request is scoped to. */
export interface MemberActor {
  kind?: "member";
  userId: string;
  organisationId: string;
  organisationRole: OrganisationRole;
}

/**
 * A guest reviewer, signed in with a magic link (docs/security.md). Guests see no projects:
 * only the items of the open reviews they are asked to, where they may view, comment and,
 * in approvals, decide.
 */
export interface GuestActor {
  kind: "guest";
  guestId: string;
  organisationId: string;
}

/** Who is asking. */
export type Actor = MemberActor | GuestActor;

/** The member behind a member route's tenant variables. */
export const actorOf = (vars: MemberActor): MemberActor => ({
  kind: "member",
  userId: vars.userId,
  organisationId: vars.organisationId,
  organisationRole: vars.organisationRole,
});

/** What a guest may do, from what their review grants them: always view, the rest if allowed. */
const guestPermissions = (grant: { comment: boolean; decide?: boolean }): Set<ProjectPermission> =>
  new Set<ProjectPermission>([
    "view",
    ...(grant.comment ? (["comment"] as const) : []),
    ...(grant.decide ? (["decide"] as const) : []),
  ]);

/** What a guest may use on a file: the widest grant among the reviews that give it them. */
export type GuestGrant = NonNullable<ReturnType<typeof mergeGrants>>;

/**
 * The files a guest may open: everything the open reviews they are asked to contain. A
 * track item gives the variations of its version (a given one, or the latest).
 */
export async function guestFileIds(
  db: Pick<Database, "select">,
  guest: GuestActor,
): Promise<Set<string>> {
  return new Set((await guestFileReviews(db, guest)).keys());
}

/**
 * For each file a guest may reach, the open reviews that give it to them, newest first:
 * the access log names the review a guest came through.
 */
export async function guestFileReviews(
  db: Pick<Database, "select">,
  guest: GuestActor,
): Promise<Map<string, string[]>> {
  const reach = await guestReach(db, guest);
  return new Map([...reach].map(([fileId, through]) => [fileId, through.map((t) => t.reviewId)]));
}

/**
 * For each file a guest may reach, the reviews that give it to them (newest first) with
 * what each lets them do. A review whose access window is not open for them gives nothing.
 */
async function guestReach(
  db: Pick<Database, "select">,
  guest: GuestActor,
): Promise<Map<string, { reviewId: string; permissions: ReviewerPermissions }[]>> {
  const now = new Date();
  const rows = await db
    .select({
      reviewId: reviews.id,
      permissions: reviewReviewers.permissions,
      fileId: reviewItems.fileId,
      trackId: reviewItems.trackId,
      versionId: reviewItems.versionId,
    })
    .from(reviewItems)
    .innerJoin(reviews, eq(reviews.id, reviewItems.reviewId))
    .innerJoin(
      reviewReviewers,
      and(
        eq(reviewReviewers.reviewId, reviews.id),
        eq(reviewReviewers.organisationId, guest.organisationId),
        eq(reviewReviewers.guestId, guest.guestId),
      ),
    )
    .where(inOrg(reviewItems, guest.organisationId, eq(reviews.status, "open")))
    .orderBy(desc(reviews.createdAt), desc(reviews.id));
  const items = rows.filter((r) => withinWindow(r.permissions, now));
  const ids = new Map<string, { reviewId: string; permissions: ReviewerPermissions }[]>();
  const add = (fileId: string, item: { reviewId: string; permissions: ReviewerPermissions }) => {
    const list = ids.get(fileId) ?? [];
    if (!list.some((x) => x.reviewId === item.reviewId))
      list.push({ reviewId: item.reviewId, permissions: item.permissions });
    ids.set(fileId, list);
  };
  for (const item of items) {
    if (item.fileId) {
      add(item.fileId, item);
      continue;
    }
    if (!item.trackId) continue;
    const [version] = await db
      .select({ id: versions.id })
      .from(versions)
      .where(
        inOrg(
          versions,
          guest.organisationId,
          item.versionId ? eq(versions.id, item.versionId) : eq(versions.trackId, item.trackId),
        ),
      )
      .orderBy(desc(versions.number))
      .limit(1);
    if (!version) continue;
    const variants = await db
      .select({ fileId: variations.fileId })
      .from(variations)
      .where(inOrg(variations, guest.organisationId, eq(variations.versionId, version.id)));
    for (const v of variants) add(v.fileId, item);
  }
  return ids;
}

/**
 * What the actor may do in a project, or null when they may not see it (or it does not
 * exist in their organisation). Organisation owners and admins may do everything.
 */
export async function projectAccess(
  db: Pick<Database, "select">,
  actor: Actor,
  projectId: string,
): Promise<{
  projectId: string;
  /** What the actor may do now: only look, while the project is archived. */
  permissions: Set<ProjectPermission>;
  /** What their role grants, archived or not: what unarchiving it is decided by. */
  granted: Set<ProjectPermission>;
  archived: boolean;
} | null> {
  // Guests see no projects; they reach files only through their reviews.
  if (actor.kind === "guest") return null;
  const [row] = await db
    .select({
      id: projects.id,
      archivedAt: projects.archivedAt,
      permissions: projectRoles.permissions,
    })
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
  const granted = permissionsFor(actor.organisationRole, row.permissions);
  if (!granted.has("view")) return null;
  // An archived project is read-only for everyone until it is unarchived.
  const archived = row.archivedAt !== null;
  const permissions = archived ? new Set<ProjectPermission>(["view"]) : granted;
  return { projectId: row.id, permissions, granted, archived };
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
  if (!file) return null;
  if (actor.kind === "guest") {
    const grant = mergeGrants(
      ((await guestReach(db, actor)).get(fileId) ?? []).map((t) => t.permissions),
    );
    return grant
      ? { projectId: file.projectId, permissions: guestPermissions(grant), grant }
      : null;
  }
  const access = await projectAccess(db, actor, file.projectId);
  return access && { ...access, grant: null };
}

/**
 * What the actor may do in a review: a member, what their project role allows; a guest,
 * what the review grants them, but only while they are one of its reviewers and their
 * access window is open.
 */
export async function reviewAccess(
  db: Pick<Database, "select">,
  actor: Actor,
  review: { id: string; projectId: string },
) {
  if (actor.kind !== "guest") return projectAccess(db, actor, review.projectId);
  const [mine] = await db
    .select({ id: reviewReviewers.id, grant: reviewReviewers.permissions })
    .from(reviewReviewers)
    .where(
      inOrg(
        reviewReviewers,
        actor.organisationId,
        eq(reviewReviewers.reviewId, review.id),
        eq(reviewReviewers.guestId, actor.guestId),
      ),
    );
  if (!mine || !withinWindow(mine.grant, new Date())) return null;
  return { projectId: review.projectId, permissions: guestPermissions(mine.grant) };
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
 * A condition for project lists: the projects the actor may see, or (with another
 * permission) may act in that way. Owners and admins have every project in the
 * organisation; members, those where their role allows it.
 */
export function visibleProjects(actor: MemberActor, permission: ProjectPermission = "view") {
  if (actor.organisationRole === "owner" || actor.organisationRole === "admin") return undefined;
  return sql`exists (
    select 1 from ${projectMembers}
    join ${projectRoles} on ${projectRoles.id} = ${projectMembers.roleId}
      and ${projectRoles.organisationId} = ${actor.organisationId}
    where ${projectMembers.projectId} = ${projects.id}
      and ${projectMembers.organisationId} = ${actor.organisationId}
      and ${projectMembers.userId} = ${actor.userId}
      and ${permission} = any(${projectRoles.permissions})
  )`;
}

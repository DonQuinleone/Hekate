import { type Database, inOrg, schema } from "@hekate/db";
import {
  type AssetPolicy,
  assetPolicyOf,
  cappedDownload,
  type DownloadLevel,
  exceptedTools,
  lookingPermissions,
  mergeGrants,
  narrowedByPolicy,
  type OrganisationRole,
  type PlayerTool,
  type ProjectPermission,
  permissionsFor,
  type ReviewerPermissions,
  type ReviewerTool,
  readGrant,
  toolsFor,
  withinWindow,
} from "@hekate/shared";
import { and, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { NotFound } from "./errors.ts";
import { type CoveredFile, coveredBy } from "./review-scope.ts";

const {
  comments,
  commentCarries,
  commentTakes,
  projects,
  projectMembers,
  projectOwners,
  projectRoles,
  files,
  groupMembers,
  projectToolExceptions,
  reviews,
  reviewItems,
  reviewReviewers,
  tracks,
  versions,
  variants,
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
    // What they read follows their review's comment scope.
    "read_comments",
    ...(grant.comment ? (["comment"] as const) : []),
    ...(grant.decide ? (["decide"] as const) : []),
  ]);

/**
 * How a guest reaches a file: the review that gives it them, with its grant; `shared` when only
 * because a take is shared on a thread they can see (#133), to listen and nothing more.
 */
export interface Reach {
  reviewId: string;
  permissions: ReviewerPermissions;
  shared?: boolean;
}

/** What a guest may use on a file: the widest grant among the reviews that give it them. */
export type GuestGrant = NonNullable<ReturnType<typeof mergeGrants>>;

/**
 * The files a guest may open: everything the open reviews they are asked to contain. A
 * track item gives the variants of its version (a given one, or the latest).
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
export async function guestReach(
  db: Pick<Database, "select">,
  guest: GuestActor,
): Promise<Map<string, Reach[]>> {
  const now = new Date();
  const rows = await db
    .select({
      reviewId: reviews.id,
      projectId: reviews.projectId,
      itemId: reviewItems.id,
      permissions: reviewReviewers.permissions,
      fileId: reviewItems.fileId,
      trackId: reviewItems.trackId,
      versionId: reviewItems.versionId,
      folderId: reviewItems.folderId,
      scope: reviewItems.scope,
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
  // A folder or workspace item covers what is beneath it now (#501), in its own project or in
  // every project; each file is narrowed by the project it is in.
  const scoped = new Map<string, CoveredFile[]>();
  for (const r of rows) {
    if (r.folderId || r.scope) scoped.set(r.itemId, await coveredBy(db, guest.organisationId, r));
  }
  // Within their window, and among the items their review shows them (#55); with what their
  // review gives them narrowed by each project's downloads and tool exceptions (decisions 257, 258).
  const narrowing = await guestNarrowing(db, guest, [
    ...new Set([
      ...rows.map((r) => r.projectId),
      ...[...scoped.values()].flat().map((c) => c.projectId),
    ]),
  ]);
  const items = rows
    .map((r) => ({
      ...r,
      granted: readGrant(r.permissions),
      permissions: narrowing(r.projectId, readGrant(r.permissions)),
    }))
    .filter(
      (r) =>
        withinWindow(r.permissions, now) &&
        (r.permissions.items === null || r.permissions.items.includes(r.itemId)),
    );
  const ids = new Map<string, Reach[]>();
  const add = (fileId: string, item: Reach) => {
    const list = ids.get(fileId) ?? [];
    if (!list.some((x) => x.reviewId === item.reviewId))
      list.push({ reviewId: item.reviewId, permissions: item.permissions, shared: item.shared });
    ids.set(fileId, list);
  };
  for (const item of items) {
    if (item.fileId) {
      add(item.fileId, item);
      continue;
    }
    const covers = scoped.get(item.itemId);
    if (covers) {
      for (const c of covers) {
        add(c.fileId, {
          ...item,
          permissions:
            c.projectId === item.projectId
              ? item.permissions
              : narrowing(c.projectId, item.granted),
        });
      }
      continue;
    }
    if (!item.trackId) continue;
    // The version under review (the one named, else the latest); with history, it and the
    // ones before it, never a version added after the one the review names.
    const [pinned] = item.versionId
      ? await db
          .select({ number: versions.number })
          .from(versions)
          .where(inOrg(versions, guest.organisationId, eq(versions.id, item.versionId)))
      : [];
    if (item.versionId && !pinned) continue;
    const found = await db
      .select({ id: versions.id })
      .from(versions)
      .where(
        inOrg(
          versions,
          guest.organisationId,
          item.versionId && !item.permissions.history
            ? eq(versions.id, item.versionId)
            : and(
                eq(versions.trackId, item.trackId),
                pinned ? lte(versions.number, pinned.number) : undefined,
              ),
        ),
      )
      .orderBy(desc(versions.number))
      .limit(item.permissions.history ? 1000 : 1);
    if (found.length === 0) continue;
    const ofVersions = await db
      .select({ fileId: variants.fileId })
      .from(variants)
      .where(
        inOrg(
          variants,
          guest.organisationId,
          inArray(
            variants.versionId,
            found.map((v) => v.id),
          ),
        ),
      );
    for (const v of ofVersions) add(v.fileId, item);
    // The track's score, as a page beside the recording, for those given it.
    if (item.permissions.tools.includes("score")) {
      const [track] = await db
        .select({ scoreFileId: tracks.scoreFileId })
        .from(tracks)
        .where(inOrg(tracks, guest.organisationId, eq(tracks.id, item.trackId)));
      if (track?.scoreFileId) add(track.scoreFileId, item);
    }
  }
  // Takes shared on a thread they can see (#133), to hear and nothing more: no comment of
  // their own, no download, and none of the take's own comments.
  for (const [fileId, item] of await sharedTakeReach(db, guest, ids)) add(fileId, item);
  return ids;
}

/**
 * How each project narrows what a guest's reviews give them: no download beyond what its
 * policy allows (decision 257), and no tool its exceptions for them, or their groups, leave out
 * (decision 258). An exception never gives a guest a tool their review does not.
 */
async function guestNarrowing(
  db: Pick<Database, "select">,
  guest: GuestActor,
  projectIds: string[],
) {
  const org = guest.organisationId;
  const [policies, exceptions] =
    projectIds.length === 0
      ? [[], []]
      : await Promise.all([
          db
            .select({ id: projects.id, assetPolicy: projects.assetPolicy })
            .from(projects)
            .where(inOrg(projects, org, inArray(projects.id, projectIds))),
          db
            .select({
              projectId: projectToolExceptions.projectId,
              guestId: projectToolExceptions.guestId,
              tools: projectToolExceptions.tools,
            })
            .from(projectToolExceptions)
            .where(
              inOrg(
                projectToolExceptions,
                org,
                inArray(projectToolExceptions.projectId, projectIds),
                or(
                  eq(projectToolExceptions.guestId, guest.guestId),
                  inArray(
                    projectToolExceptions.groupId,
                    db
                      .select({ id: groupMembers.groupId })
                      .from(groupMembers)
                      .where(inOrg(groupMembers, org, eq(groupMembers.guestId, guest.guestId))),
                  ),
                ),
              ),
            ),
        ]);
  const policyOf = new Map(policies.map((p) => [p.id, assetPolicyOf(p.assetPolicy)]));
  return <G extends { tools: ReviewerTool[]; download: DownloadLevel }>(
    projectId: string,
    grant: G,
  ): G => {
    const policy = policyOf.get(projectId) ?? assetPolicyOf(null);
    const here = exceptions.filter((e) => e.projectId === projectId);
    const own = here.find((e) => e.guestId !== null)?.tools ?? null;
    const groups = here.filter((e) => e.guestId === null).map((e) => e.tools);
    const allowed = exceptedTools(new Set(grant.tools), own, groups, true);
    return {
      ...grant,
      tools: grant.tools.filter((t) => allowed.has(t)),
      download: cappedDownload(grant.download, policy),
    };
  };
}

/**
 * The tools a member has in a project once its exceptions apply (decision 258): their own
 * exception, else their groups', else their role's. The workspace's owners and admins, and the
 * project's own owners (decision 285), keep every tool.
 */
async function memberTools(
  db: Pick<Database, "select">,
  actor: MemberActor,
  projectId: string,
  base: Set<PlayerTool>,
  projectOwner: boolean,
): Promise<Set<PlayerTool>> {
  if (projectOwner || actor.organisationRole === "owner" || actor.organisationRole === "admin")
    return base;
  const org = actor.organisationId;
  const found = await db
    .select({ userId: projectToolExceptions.userId, tools: projectToolExceptions.tools })
    .from(projectToolExceptions)
    .where(
      inOrg(
        projectToolExceptions,
        org,
        eq(projectToolExceptions.projectId, projectId),
        or(
          eq(projectToolExceptions.userId, actor.userId),
          inArray(
            projectToolExceptions.groupId,
            db
              .select({ id: groupMembers.groupId })
              .from(groupMembers)
              .where(inOrg(groupMembers, org, eq(groupMembers.userId, actor.userId))),
          ),
        ),
      ),
    );
  if (found.length === 0) return base;
  const own = found.find((e) => e.userId !== null)?.tools ?? null;
  return exceptedTools(
    base,
    own,
    found.filter((e) => e.userId === null).map((e) => e.tools),
  );
}

/**
 * The files of takes shared on threads a guest sees on the files they reach: threads on those
 * files or carried to them where they show, within the comment scope of the review that gives
 * the file. Each is reached as the thread's file is, for listening only.
 */
async function sharedTakeReach(
  db: Pick<Database, "select">,
  guest: GuestActor,
  reach: Map<string, Reach[]>,
): Promise<[string, Reach][]> {
  const reached = [...reach.keys()];
  if (reached.length === 0) return [];
  const org = guest.organisationId;
  const carried = await db
    .select({ commentId: commentCarries.commentId, fileId: commentCarries.fileId })
    .from(commentCarries)
    .where(
      inOrg(
        commentCarries,
        org,
        inArray(commentCarries.fileId, reached),
        eq(commentCarries.visible, true),
      ),
    );
  const shares = await db
    .select({
      commentId: commentTakes.commentId,
      threadFileId: comments.fileId,
      guestAuthorId: comments.guestAuthorId,
      takeFileId: files.id,
    })
    .from(commentTakes)
    .innerJoin(
      comments,
      and(eq(comments.id, commentTakes.commentId), eq(comments.organisationId, org)),
    )
    .innerJoin(files, and(eq(files.takeId, commentTakes.takeId), eq(files.organisationId, org)))
    .where(
      inOrg(
        commentTakes,
        org,
        or(
          inArray(comments.fileId, reached),
          carried.length > 0
            ? inArray(
                commentTakes.commentId,
                carried.map((k) => k.commentId),
              )
            : undefined,
        ),
      ),
    );
  const found: [string, Reach][] = [];
  for (const share of shares) {
    const on = [
      share.threadFileId,
      ...carried.filter((k) => k.commentId === share.commentId).map((k) => k.fileId),
    ];
    for (const fileId of on)
      for (const item of reach.get(fileId) ?? []) {
        const p = item.permissions;
        // A thread they cannot see shares nothing with them.
        if (p.comments !== "all" && share.guestAuthorId !== guest.guestId) continue;
        found.push([
          share.takeFileId,
          {
            reviewId: item.reviewId,
            permissions: {
              ...p,
              comment: false,
              decide: false,
              comments: "own",
              download: "none",
              items: null,
            },
            shared: true,
          },
        ]);
      }
  }
  return found;
}

/**
 * What the actor may do in a project, or null when they may not see it (or it does not
 * exist in their organisation). Organisation owners and admins may do everything, and so may
 * the project's own owners (decision 285), whatever their role says.
 */
export async function projectAccess(
  db: Pick<Database, "select">,
  actor: Actor,
  projectId: string,
): Promise<{
  projectId: string;
  /** What the actor may do now: only look (as their role allows), while it is archived. */
  permissions: Set<ProjectPermission>;
  /** What their role grants, archived or not: what unarchiving it is decided by. */
  granted: Set<ProjectPermission>;
  /** The player tools their role has on (#240), or an exception gives them (decision 258). */
  tools: Set<PlayerTool>;
  /** The project's downloads and deletion (decision 257). */
  assetPolicy: AssetPolicy;
  archived: boolean;
  /** Whether the actor is one of the project's owners (decision 285). */
  owner: boolean;
} | null> {
  // Guests see no projects; they reach files only through their reviews.
  if (actor.kind === "guest") return null;
  const [row] = await db
    .select({
      id: projects.id,
      archivedAt: projects.archivedAt,
      assetPolicy: projects.assetPolicy,
      permissions: projectRoles.permissions,
      tools: projectRoles.tools,
      ownerId: projectOwners.id,
    })
    .from(projects)
    .leftJoin(
      projectOwners,
      and(
        eq(projectOwners.projectId, projects.id),
        eq(projectOwners.organisationId, actor.organisationId),
        eq(projectOwners.userId, actor.userId),
      ),
    )
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
  const assetPolicy = assetPolicyOf(row.assetPolicy);
  const owner = row.ownerId !== null;
  // What the role grants (everything, to an owner), less what the project's downloads and
  // deletion leave to nobody, or to the workspace's owners and admins (decision 257).
  const granted = narrowedByPolicy(
    permissionsFor(actor.organisationRole, row.permissions, owner),
    assetPolicy,
    actor.organisationRole,
  );
  if (!granted.has("view")) return null;
  // An archived project is read-only for everyone until it is unarchived.
  const archived = row.archivedAt !== null;
  const permissions = archived
    ? new Set(lookingPermissions.filter((p) => granted.has(p)))
    : granted;
  return {
    projectId: row.id,
    permissions,
    granted,
    tools: await memberTools(
      db,
      actor,
      row.id,
      toolsFor(actor.organisationRole, row.tools, owner),
      owner,
    ),
    assetPolicy,
    archived,
    owner,
  };
}

/**
 * The one check every project route makes: the project as the actor may see it, or 404
 * (a project you cannot see does not exist for you), and 403 when the actor sees it but
 * lacks the permission (or, given several, every one of them).
 */
export async function can(
  db: Pick<Database, "select">,
  actor: Actor,
  permission: ProjectPermission | readonly ProjectPermission[],
  projectId: string,
) {
  const access = await projectAccess(db, actor, projectId);
  if (!access) throw new NotFound("Project");
  const any = typeof permission === "string" ? [permission] : permission;
  if (!any.some((p) => access.permissions.has(p))) {
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
    const through = (await guestReach(db, actor)).get(fileId) ?? [];
    const grant = mergeGrants(through.map((t) => t.permissions));
    if (!grant) return null;
    // A take they reach only as shared on a thread is theirs to hear, and nothing more: none
    // of its comments, their own from an earlier review included.
    const listenOnly = through.every((t) => t.shared);
    return {
      projectId: file.projectId,
      permissions: listenOnly ? new Set<ProjectPermission>(["view"]) : guestPermissions(grant),
      grant: { ...grant, listenOnly },
    };
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

/**
 * Whether the actor may use a player tool on a file (#240): a guest, if their review gives it
 * them; a member, if their role has it on.
 */
export function mayUseTool(
  access: { grant: { tools: readonly string[] } | null; tools?: ReadonlySet<PlayerTool> },
  tool: PlayerTool,
): boolean {
  return access.grant ? access.grant.tools.includes(tool) : (access.tools?.has(tool) ?? false);
}

/** The refusal of a tool, in the words of where it comes from: a review, or a role. */
export const toolRefused = (access: { grant: unknown }) =>
  new HTTPException(403, {
    message: access.grant
      ? "This review does not include that tool"
      : "Your role in this project does not include that tool",
  });

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
 * organisation; a project's own owners, theirs (decision 285); members, those where their
 * role allows it.
 */
export function visibleProjects(actor: MemberActor, permission: ProjectPermission = "view") {
  if (actor.organisationRole === "owner" || actor.organisationRole === "admin") return undefined;
  return sql`(exists (
    select 1 from ${projectOwners}
    where ${projectOwners.projectId} = ${projects.id}
      and ${projectOwners.organisationId} = ${actor.organisationId}
      and ${projectOwners.userId} = ${actor.userId}
  ) or exists (
    select 1 from ${projectMembers}
    join ${projectRoles} on ${projectRoles.id} = ${projectMembers.roleId}
      and ${projectRoles.organisationId} = ${actor.organisationId}
    where ${projectMembers.projectId} = ${projects.id}
      and ${projectMembers.organisationId} = ${actor.organisationId}
      and ${projectMembers.userId} = ${actor.userId}
      and ${permission} = any(${projectRoles.permissions})
  ))`;
}

/**
 * Inside a transaction that adds to a project: holds the project against being archived
 * meanwhile (archiving takes the row for update), and refuses one already archived.
 */
/**
 * Takes are numbered one at a time across a project (#51): whichever way a take gets its
 * number (logged live, made from a file, imported), the transaction waits here first, so a
 * take numbered on from the project's last never shares a number with one numbered at once on
 * another track.
 */
export async function lockTakeNumbers(tx: Pick<Database, "execute">, projectId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`take-numbers:${projectId}`}))`);
}

export async function lockLiveProject(
  tx: Pick<Database, "select">,
  organisationId: string,
  projectId: string,
) {
  const [row] = await tx
    .select({ archivedAt: projects.archivedAt })
    .from(projects)
    .where(inOrg(projects, organisationId, eq(projects.id, projectId)))
    .for("share");
  if (!row) throw new NotFound("Project");
  if (row.archivedAt) throw new HTTPException(409, { message: "This project is archived" });
}

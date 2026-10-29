import { type Database, inOrg, schema } from "@hekate/db";
import {
  and,
  type Column,
  count,
  countDistinct,
  eq,
  inArray,
  isNull,
  max,
  or,
  sql,
} from "drizzle-orm";
import { listedFile } from "./take-files.ts";

const { files, tracks, versions, comments, reviews, reviewItems, projectMembers, users } = schema;

/** Faces shown on a project's card; the rest are a count. */
const FACES = 4;

/** Numbers keyed by project, from a grouped count. */
const byProject = (rows: { projectId: string; n: number }[]) =>
  new Map(rows.map((r) => [r.projectId, r.n]));

export interface ProjectFigures {
  files: number;
  tracks: number;
  /** Tracks with at least one version, and of those, the ones approved at their latest. */
  versionedTracks: number;
  approvedTracks: number;
  /** Threads (comments that start one) not yet resolved. */
  openComments: number;
  openReviews: number;
  members: number;
  /** The first few members, for the card's faces. */
  faces: { id: string; name: string }[];
  /** When the newest file arrived, if any has. */
  lastFileAt: Date | null;
}

/**
 * What a project's card shows, for each of `ids`: counts, progress and faces. The caller has
 * already decided which projects the member may see; everything here stays in the workspace.
 */
export async function projectFigures(db: Database, organisationId: string, ids: string[]) {
  const inVisible = (column: Column) => inArray(column, ids);
  // A track counts as approved when an approval that settled as approved covers its latest
  // version: by naming it, or by following the latest when that version was already there
  // as the review settled (a version uploaded since has not been reviewed).
  const latest = (column: typeof versions.id | typeof versions.createdAt) =>
    sql`(select ${column} from ${versions}
      where ${versions.trackId} = ${tracks.id} and ${versions.organisationId} = ${organisationId}
      order by ${versions.number} desc limit 1)`;
  const [
    fileRows,
    trackRows,
    versionedRows,
    approvedRows,
    threadRows,
    reviewRows,
    memberRows,
    faceRows,
  ] = await Promise.all([
    db
      .select({ projectId: files.projectId, n: count(), last: max(files.createdAt) })
      .from(files)
      // The files as the project lists them: a take's file is counted with its track's takes.
      .where(inOrg(files, organisationId, inVisible(files.projectId), listedFile))
      .groupBy(files.projectId),
    db
      .select({ projectId: tracks.projectId, n: count() })
      .from(tracks)
      .where(inOrg(tracks, organisationId, inVisible(tracks.projectId)))
      .groupBy(tracks.projectId),
    db
      .select({ projectId: tracks.projectId, n: countDistinct(tracks.id) })
      .from(tracks)
      .innerJoin(
        versions,
        and(eq(versions.trackId, tracks.id), eq(versions.organisationId, organisationId)),
      )
      .where(inOrg(tracks, organisationId, inVisible(tracks.projectId)))
      .groupBy(tracks.projectId),
    db
      .select({ projectId: tracks.projectId, n: countDistinct(tracks.id) })
      .from(tracks)
      .innerJoin(
        reviewItems,
        and(eq(reviewItems.trackId, tracks.id), eq(reviewItems.organisationId, organisationId)),
      )
      .innerJoin(
        reviews,
        and(eq(reviews.id, reviewItems.reviewId), eq(reviews.organisationId, organisationId)),
      )
      .where(
        inOrg(
          tracks,
          organisationId,
          inVisible(tracks.projectId),
          eq(reviews.kind, "approval"),
          eq(reviews.status, "completed"),
          eq(reviews.outcome, "approved"),
          or(
            and(
              isNull(reviewItems.versionId),
              sql`${latest(versions.createdAt)} <= ${reviews.completedAt}`,
            ),
            sql`${reviewItems.versionId} = ${latest(versions.id)}`,
          ),
        ),
      )
      .groupBy(tracks.projectId),
    // Open threads: comments that start a thread and are not resolved.
    db
      .select({ projectId: files.projectId, n: count() })
      .from(comments)
      .innerJoin(
        files,
        and(eq(files.id, comments.fileId), eq(files.organisationId, organisationId)),
      )
      .where(
        inOrg(
          comments,
          organisationId,
          isNull(comments.parentId),
          isNull(comments.resolvedAt),
          inVisible(files.projectId),
        ),
      )
      .groupBy(files.projectId),
    db
      .select({ projectId: reviews.projectId, n: count() })
      .from(reviews)
      .where(
        inOrg(reviews, organisationId, eq(reviews.status, "open"), inVisible(reviews.projectId)),
      )
      .groupBy(reviews.projectId),
    db
      .select({ projectId: projectMembers.projectId, n: count() })
      .from(projectMembers)
      .where(inOrg(projectMembers, organisationId, inVisible(projectMembers.projectId)))
      .groupBy(projectMembers.projectId),
    db
      .select({ projectId: projectMembers.projectId, id: users.id, name: users.name })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(inOrg(projectMembers, organisationId, inVisible(projectMembers.projectId)))
      .orderBy(projectMembers.createdAt),
  ]);
  const filesBy = byProject(fileRows);
  const lastBy = new Map(fileRows.map((r) => [r.projectId, r.last]));
  const tracksBy = byProject(trackRows);
  const versionedBy = byProject(versionedRows);
  const approvedBy = byProject(approvedRows);
  const threadsBy = byProject(threadRows);
  const reviewsBy = byProject(reviewRows);
  const membersBy = byProject(memberRows);
  const facesBy = new Map<string, { id: string; name: string }[]>();
  for (const f of faceRows) {
    const list = facesBy.get(f.projectId) ?? [];
    if (list.length < FACES) list.push({ id: f.id, name: f.name });
    facesBy.set(f.projectId, list);
  }
  return {
    of: (id: string): ProjectFigures => ({
      files: filesBy.get(id) ?? 0,
      tracks: tracksBy.get(id) ?? 0,
      versionedTracks: versionedBy.get(id) ?? 0,
      approvedTracks: approvedBy.get(id) ?? 0,
      openComments: threadsBy.get(id) ?? 0,
      openReviews: reviewsBy.get(id) ?? 0,
      members: membersBy.get(id) ?? 0,
      faces: facesBy.get(id) ?? [],
      lastFileAt: lastBy.get(id) ?? null,
    }),
    /** Open threads across all of them. */
    openComments: threadRows.reduce((n, r) => n + r.n, 0),
  };
}

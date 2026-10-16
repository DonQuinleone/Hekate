import { type Database, inOrg, schema } from "@hekate/db";
import { and, type Column, desc, eq, inArray, isNotNull } from "drizzle-orm";

const { files, tracks, versions, comments, reviews, users, guests } = schema;

/** Entries in an activity list, and how far back each source is read to fill it. */
const ACTIVITY = 8;
const ACTIVITY_READ = 40;

const iso = (d: Date) => d.toISOString();

/** Who did something: a member or a guest, by name; null once they have left. */
type Who = { id: string; name: string } | null;
const who = (id: string | null, name: string | null): Who => (id && name ? { id, name } : null);

export type HomeActivity =
  | {
      kind: "comment";
      id: string;
      at: string;
      who: Who;
      projectId: string;
      fileId: string;
      fileName: string;
      /** Comments in a row by the same person on the same file, shown as one line. */
      count: number;
    }
  | {
      kind: "version";
      id: string;
      at: string;
      who: Who;
      projectId: string;
      trackId: string;
      trackName: string;
      number: number;
    }
  | {
      kind: "review";
      id: string;
      at: string;
      who: Who;
      projectId: string;
      reviewId: string;
      title: string;
    }
  | {
      kind: "review_completed";
      id: string;
      at: string;
      who: null;
      projectId: string;
      reviewId: string;
      title: string;
      outcome: string | null;
    };

/**
 * The newest first, a few of them: what has moved across the projects a member can see. A run
 * of comments by one person on one file reads as one line, so a busy listening session does
 * not push everything else out.
 */
export function latestActivity(entries: HomeActivity[], limit = ACTIVITY): HomeActivity[] {
  const out: HomeActivity[] = [];
  for (const entry of [...entries].sort((a, b) => b.at.localeCompare(a.at))) {
    const last = out.at(-1);
    if (
      entry.kind === "comment" &&
      last?.kind === "comment" &&
      last.fileId === entry.fileId &&
      last.who?.id === entry.who?.id
    ) {
      out[out.length - 1] = { ...last, count: last.count + entry.count };
      continue;
    }
    if (out.length === limit) break;
    out.push(entry);
  }
  return out;
}

/**
 * What has happened lately across the given projects, newest first: comments, new versions,
 * reviews asked for and reviews settled. The caller has already decided which projects the
 * member may see; everything here stays in the workspace.
 */
export async function recentActivity(
  db: Database,
  organisationId: string,
  ids: string[],
  limit = ACTIVITY,
): Promise<HomeActivity[]> {
  if (ids.length === 0) return [];
  const inVisible = (column: Column) => inArray(column, ids);
  const [commentActivity, versionActivity, reviewActivity, settledActivity] = await Promise.all([
    db
      .select({
        id: comments.id,
        at: comments.createdAt,
        userId: users.id,
        userName: users.name,
        guestId: guests.id,
        guestName: guests.name,
        projectId: files.projectId,
        fileId: files.id,
        fileName: files.name,
      })
      .from(comments)
      .innerJoin(
        files,
        and(eq(files.id, comments.fileId), eq(files.organisationId, organisationId)),
      )
      .leftJoin(users, eq(users.id, comments.authorId))
      .leftJoin(
        guests,
        and(eq(guests.id, comments.guestAuthorId), eq(guests.organisationId, organisationId)),
      )
      .where(inOrg(comments, organisationId, inVisible(files.projectId)))
      .orderBy(desc(comments.createdAt))
      .limit(ACTIVITY_READ),
    db
      .select({
        id: versions.id,
        at: versions.createdAt,
        userId: users.id,
        userName: users.name,
        projectId: tracks.projectId,
        trackId: tracks.id,
        trackName: tracks.name,
        number: versions.number,
      })
      .from(versions)
      .innerJoin(
        tracks,
        and(eq(tracks.id, versions.trackId), eq(tracks.organisationId, organisationId)),
      )
      .leftJoin(users, eq(users.id, versions.createdBy))
      .where(inOrg(versions, organisationId, inVisible(tracks.projectId)))
      .orderBy(desc(versions.createdAt))
      .limit(ACTIVITY_READ),
    db
      .select({
        id: reviews.id,
        at: reviews.createdAt,
        userId: users.id,
        userName: users.name,
        projectId: reviews.projectId,
        title: reviews.title,
      })
      .from(reviews)
      .leftJoin(users, eq(users.id, reviews.createdBy))
      .where(inOrg(reviews, organisationId, inVisible(reviews.projectId)))
      .orderBy(desc(reviews.createdAt))
      .limit(ACTIVITY_READ),
    db
      .select({
        id: reviews.id,
        at: reviews.completedAt,
        projectId: reviews.projectId,
        title: reviews.title,
        outcome: reviews.outcome,
      })
      .from(reviews)
      .where(
        inOrg(
          reviews,
          organisationId,
          inVisible(reviews.projectId),
          eq(reviews.status, "completed"),
          isNotNull(reviews.completedAt),
        ),
      )
      .orderBy(desc(reviews.completedAt))
      .limit(ACTIVITY_READ),
  ]);
  return latestActivity(
    [
      ...commentActivity.map(
        (a): HomeActivity => ({
          kind: "comment",
          id: a.id,
          at: iso(a.at),
          who: who(a.userId, a.userName) ?? who(a.guestId, a.guestName),
          projectId: a.projectId,
          fileId: a.fileId,
          fileName: a.fileName,
          count: 1,
        }),
      ),
      ...versionActivity.map(
        (a): HomeActivity => ({
          kind: "version",
          id: a.id,
          at: iso(a.at),
          who: who(a.userId, a.userName),
          projectId: a.projectId,
          trackId: a.trackId,
          trackName: a.trackName,
          number: a.number,
        }),
      ),
      ...reviewActivity.map(
        (a): HomeActivity => ({
          kind: "review",
          id: a.id,
          at: iso(a.at),
          who: who(a.userId, a.userName),
          projectId: a.projectId,
          reviewId: a.id,
          title: a.title,
        }),
      ),
      ...settledActivity.flatMap((a): HomeActivity[] =>
        a.at
          ? [
              {
                kind: "review_completed",
                id: `${a.id}:completed`,
                at: iso(a.at),
                who: null,
                projectId: a.projectId,
                reviewId: a.id,
                title: a.title,
                outcome: a.outcome,
              },
            ]
          : [],
      ),
    ],
    limit,
  );
}

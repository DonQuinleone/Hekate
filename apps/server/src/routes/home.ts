import { type Database, inOrg, schema } from "@hekate/db";
import { and, type Column, count, desc, eq, gt, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { Hono } from "hono";
import { actorOf, visibleProjects } from "../access.ts";
import { projectFigures } from "../project-figures.ts";
import type { TenantVariables } from "../tenancy.ts";

const { projects, files, tracks, versions, comments, reviews, users, guests } = schema;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Entries in the activity list, and how far back each source is read to fill it. */
const ACTIVITY = 8;
const ACTIVITY_READ = 40;

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

const iso = (d: Date) => d.toISOString();

/**
 * What the home page needs beyond the reviews waiting on you: each visible project's
 * figures, the open threads and new versions across them, files that failed to process and
 * what has happened lately. Everything is scoped to the workspace and to the projects this
 * member may see.
 */
export const homeRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>().get("/", async (c) => {
    const organisationId = c.var.organisationId;
    const visible = await db
      .select({
        id: projects.id,
        name: projects.name,
        profile: projects.profile,
        description: projects.description,
        createdAt: projects.createdAt,
      })
      .from(projects)
      .where(
        inOrg(
          projects,
          organisationId,
          isNull(projects.archivedAt),
          visibleProjects(actorOf(c.var)),
        ),
      );
    const ids = visible.map((p) => p.id);
    if (ids.length === 0) {
      return c.json({ projects: [], openComments: 0, newVersions: 0, failed: [], activity: [] });
    }
    const inVisible = (column: Column) => inArray(column, ids);

    const [
      figures,
      newVersions,
      failed,
      commentActivity,
      versionActivity,
      reviewActivity,
      settledActivity,
    ] = await Promise.all([
      projectFigures(db, organisationId, ids),
      db
        .select({ n: count() })
        .from(versions)
        .innerJoin(
          tracks,
          and(eq(tracks.id, versions.trackId), eq(tracks.organisationId, organisationId)),
        )
        .where(
          inOrg(
            versions,
            organisationId,
            inVisible(tracks.projectId),
            gt(versions.createdAt, new Date(Date.now() - WEEK_MS)),
          ),
        ),
      // Files that failed, for those who can replace them: all of them, newest first.
      db
        .select({ id: files.id, name: files.name, projectId: files.projectId })
        .from(files)
        .innerJoin(
          projects,
          and(eq(projects.id, files.projectId), eq(projects.organisationId, organisationId)),
        )
        .where(
          inOrg(
            files,
            organisationId,
            inVisible(files.projectId),
            visibleProjects(actorOf(c.var), "upload"),
            or(eq(files.streamStatus, "failed"), eq(files.analysisStatus, "failed")),
          ),
        )
        .orderBy(desc(files.createdAt)),
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

    const activity = latestActivity([
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
    ]);

    return c.json({
      projects: visible
        .map((p) => ({
          ...p,
          ...figures.of(p.id),
          updatedAt: iso(figures.of(p.id).lastFileAt ?? p.createdAt),
        }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      openComments: figures.openComments,
      newVersions: newVersions[0]?.n ?? 0,
      failed,
      activity,
    });
  });

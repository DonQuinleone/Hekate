import { type Database, inOrg, schema } from "@hekate/db";
import { and, type Column, count, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { Hono } from "hono";
import { actorOf, visibleProjects } from "../access.ts";
import { recentActivity } from "../activity.ts";
import { projectFigures } from "../project-figures.ts";
import type { TenantVariables } from "../tenancy.ts";

const { projects, files, tracks, versions } = schema;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export { type HomeActivity, latestActivity } from "../activity.ts";

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

    const [figures, newVersions, failed, activity] = await Promise.all([
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
      recentActivity(db, organisationId, ids),
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

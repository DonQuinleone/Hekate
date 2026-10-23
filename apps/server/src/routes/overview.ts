import { type Database, inOrg, schema } from "@hekate/db";
import { overviewLayoutInput, profileFor } from "@hekate/shared";
import { and, count, desc, eq, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, can } from "../access.ts";
import { recentActivity } from "../activity.ts";
import { customProfilesOf } from "../delivery-profiles.ts";
import { zValidator } from "../openapi/validator.ts";
import { projectFigures } from "../project-figures.ts";
import { failingChecks } from "../qa-summary.ts";
import type { TenantVariables } from "../tenancy.ts";
import { trackStandings } from "../track-standing.ts";

const { projects, files, projectMembers, projectRoles, overviewLayouts } = schema;

const idParam = zValidator("param", z.object({ id: z.uuid() }));
const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * `/api/projects/:id/overview`: a project's first page. What needs attention, its figures,
 * where each track stands, what is in review, what has happened lately, and the viewer's
 * own arrangement of it. Each figure follows the viewer's role: open comments only for those
 * who triage them, files that failed only for those who can replace them.
 */
export const projectOverviewRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/:id/overview", idParam, async (c) => {
      const { organisationId, userId, organisationRole } = c.var;
      const access = await can(db, actorOf(c.var), "view", c.req.valid("param").id);
      const projectId = access.projectId;
      const now = new Date();

      const [
        [project],
        figures,
        [processing],
        failed,
        qaFailing,
        standing,
        activity,
        [role],
        [layout],
      ] = await Promise.all([
        db
          .select({ deliveryProfile: projects.deliveryProfile, createdAt: projects.createdAt })
          .from(projects)
          .where(inOrg(projects, organisationId, eq(projects.id, projectId))),
        projectFigures(db, organisationId, [projectId]),
        db
          .select({ n: count() })
          .from(files)
          .where(
            inOrg(
              files,
              organisationId,
              eq(files.projectId, projectId),
              or(eq(files.streamStatus, "pending"), eq(files.analysisStatus, "pending")),
            ),
          ),
        access.permissions.has("upload")
          ? db
              .select({ id: files.id, name: files.name })
              .from(files)
              .where(
                inOrg(
                  files,
                  organisationId,
                  eq(files.projectId, projectId),
                  or(eq(files.streamStatus, "failed"), eq(files.analysisStatus, "failed")),
                ),
              )
              .orderBy(desc(files.createdAt))
          : Promise.resolve([]),
        failingChecks(db, organisationId, projectId),
        trackStandings(db, organisationId, projectId),
        recentActivity(db, organisationId, [projectId]),
        db
          .select({ name: projectRoles.name })
          .from(projectMembers)
          .innerJoin(
            projectRoles,
            and(
              eq(projectRoles.id, projectMembers.roleId),
              eq(projectRoles.organisationId, organisationId),
            ),
          )
          .where(
            inOrg(
              projectMembers,
              organisationId,
              eq(projectMembers.projectId, projectId),
              eq(projectMembers.userId, userId),
            ),
          ),
        db
          .select({ sections: overviewLayouts.sections })
          .from(overviewLayouts)
          .where(
            inOrg(
              overviewLayouts,
              organisationId,
              eq(overviewLayouts.userId, userId),
              eq(overviewLayouts.projectId, projectId),
            ),
          ),
      ]);

      const { tracks: trackList, openReviews, waitingOn } = standing;
      const counted = figures.of(projectId);
      const nextDue = openReviews.find((r) => r.dueAt)?.dueAt ?? null;
      return c.json({
        figures: {
          tracks: counted.tracks,
          versionedTracks: counted.versionedTracks,
          approvedTracks: counted.approvedTracks,
          files: counted.files,
          openReviews: counted.openReviews,
          nextDueAt: iso(nextDue),
          // Counting threads is for those who work through them.
          openComments: access.permissions.has("triage") ? counted.openComments : null,
          processing: processing?.n ?? 0,
          members: counted.members,
          faces: counted.faces,
        },
        failed,
        qaFailing,
        overdue: openReviews
          .filter((r) => r.dueAt && r.dueAt < now)
          .map((r) => ({
            id: r.id,
            title: r.title,
            dueAt: iso(r.dueAt),
            waitingOn: waitingOn.get(r.id) ?? [],
          })),
        tracks: trackList.map(({ version, ...t }) => ({
          ...t,
          version: version && {
            number: version.number,
            createdAt: version.createdAt,
            fileId: version.fileId,
          },
        })),
        activity,
        deliveryProfile: project?.deliveryProfile ?? null,
        // Its name, a workspace's own profile included.
        deliveryProfileLabel:
          profileFor(project?.deliveryProfile, await customProfilesOf(db, organisationId))?.label ??
          null,
        createdAt: iso(project?.createdAt ?? null),
        role:
          role?.name ??
          (organisationRole === "owner"
            ? "Workspace owner"
            : organisationRole === "admin"
              ? "Workspace admin"
              : null),
        layout: layout?.sections ?? null,
      });
    })
    // Anyone who can see the project may arrange their own overview of it.
    .put("/:id/overview/layout", idParam, zValidator("json", overviewLayoutInput), async (c) => {
      const { organisationId, userId } = c.var;
      const { projectId } = await can(db, actorOf(c.var), "view", c.req.valid("param").id);
      const { sections } = c.req.valid("json");
      await db
        .insert(overviewLayouts)
        .values({ organisationId, userId, projectId, sections })
        .onConflictDoUpdate({
          target: [
            overviewLayouts.organisationId,
            overviewLayouts.userId,
            overviewLayouts.projectId,
          ],
          set: { sections, updatedAt: new Date() },
        });
      return c.json({ layout: sections });
    });

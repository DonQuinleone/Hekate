import { type Database, inOrg, schema } from "@hekate/db";
import {
  activeReviewers,
  overviewLayoutInput,
  type TrackReviewItem,
  type TrackState,
  trackState,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { and, asc, count, desc, eq, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, can } from "../access.ts";
import { recentActivity } from "../activity.ts";
import { projectFigures } from "../project-figures.ts";
import { failingChecks } from "../qa-summary.ts";
import type { TenantVariables } from "../tenancy.ts";
import { reviewersOf } from "./reviews.ts";

const {
  projects,
  files,
  tracks,
  versions,
  variations,
  reviews,
  reviewItems,
  projectMembers,
  projectRoles,
  overviewLayouts,
} = schema;

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
        trackRows,
        itemRows,
        openReviews,
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
        // Each track with its latest version and that version's primary file.
        db
          .select({
            id: tracks.id,
            name: tracks.name,
            versionId: versions.id,
            number: versions.number,
            versionAt: versions.createdAt,
            fileId: variations.fileId,
          })
          .from(tracks)
          .leftJoin(
            versions,
            and(
              eq(versions.trackId, tracks.id),
              eq(versions.organisationId, organisationId),
              sql`${versions.number} = (select max(v2.number) from versions v2
                where v2.track_id = ${tracks.id} and v2.organisation_id = ${organisationId})`,
            ),
          )
          .leftJoin(
            variations,
            and(
              eq(variations.versionId, versions.id),
              eq(variations.organisationId, organisationId),
              eq(variations.isPrimary, true),
            ),
          )
          .where(inOrg(tracks, organisationId, eq(tracks.projectId, projectId)))
          .orderBy(asc(tracks.position), asc(tracks.createdAt)),
        db
          .select({
            trackId: reviewItems.trackId,
            reviewId: reviews.id,
            versionId: reviewItems.versionId,
            kind: reviews.kind,
            status: reviews.status,
            outcome: reviews.outcome,
            completedAt: reviews.completedAt,
          })
          .from(reviewItems)
          .innerJoin(
            reviews,
            and(eq(reviews.id, reviewItems.reviewId), eq(reviews.organisationId, organisationId)),
          )
          .where(
            inOrg(
              reviewItems,
              organisationId,
              eq(reviews.projectId, projectId),
              sql`${reviewItems.trackId} is not null`,
            ),
          ),
        db
          .select({
            id: reviews.id,
            title: reviews.title,
            dueAt: reviews.dueAt,
            order: reviews.order,
          })
          .from(reviews)
          .where(
            inOrg(
              reviews,
              organisationId,
              eq(reviews.projectId, projectId),
              eq(reviews.status, "open"),
            ),
          )
          .orderBy(asc(reviews.dueAt), desc(reviews.createdAt)),
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

      // Who each open review waits on now: the reviewers of its current step who are asked to
      // act (in a sequence, later steps have not begun; observers decide nothing).
      const waitingOn = new Map<string, { id: string; name: string }[]>();
      for (const r of openReviews) {
        const { rows, facts } = await reviewersOf(db, organisationId, r.id);
        const active = activeReviewers(r.order, facts);
        waitingOn.set(
          r.id,
          rows
            .filter((row) => active.has(row.id))
            .flatMap((row) => {
              const id = row.userId ?? row.guestId;
              return id && row.name ? [{ id, name: row.name }] : [];
            }),
        );
      }

      const itemsBy = new Map<string, (TrackReviewItem & { reviewId: string })[]>();
      for (const i of itemRows) {
        if (!i.trackId) continue;
        itemsBy.set(i.trackId, [
          ...(itemsBy.get(i.trackId) ?? []),
          { ...i, completedAt: iso(i.completedAt) },
        ]);
      }
      const trackList = trackRows.map((t) => {
        const latest =
          t.versionId && t.versionAt
            ? { id: t.versionId, createdAt: t.versionAt.toISOString() }
            : null;
        const items = itemsBy.get(t.id) ?? [];
        const state: TrackState = trackState(latest, items);
        // Those yet to answer an open review of it.
        const people = new Map<string, { id: string; name: string }>();
        if (state === "in_review") {
          for (const i of items)
            if (i.status === "open")
              for (const p of waitingOn.get(i.reviewId) ?? []) people.set(p.id, p);
        }
        return {
          id: t.id,
          name: t.name,
          version:
            latest && t.number !== null
              ? { number: t.number, createdAt: latest.createdAt, fileId: t.fileId }
              : null,
          state,
          waitingOn: [...people.values()],
        };
      });

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
        tracks: trackList,
        activity,
        deliveryProfile: project?.deliveryProfile ?? null,
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

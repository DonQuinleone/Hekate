import { type Database, inOrg, schema } from "@hekate/db";
import {
  type Board,
  type BoardCard,
  type BoardDecision,
  boardColumns,
  sameStatus,
  type WorkflowDefinition,
} from "@hekate/shared";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, can } from "../access.ts";
import { zValidator } from "../openapi/validator.ts";
import type { TenantVariables } from "../tenancy.ts";
import { trackStandings } from "../track-standing.ts";

const {
  comments,
  projects,
  guests,
  reviewDecisionLog,
  reviewItems,
  reviewReviewers,
  reviews,
  tasks,
  tracks,
  users,
  variations,
  workflowRuns,
  workflows,
} = schema;

const idParam = zValidator("param", z.object({ id: z.uuid() }));

/**
 * What each track's latest review says of it, for all of them in two queries: every reviewer who
 * has answered, by name, with their last decision (or feedback where they gave none).
 */
async function decisionsOf(
  db: Database,
  organisationId: string,
  reviewIds: string[],
): Promise<Map<string, BoardDecision[]>> {
  const out = new Map<string, BoardDecision[]>();
  if (reviewIds.length === 0) return out;
  const [rows, logged] = await Promise.all([
    db
      .select({
        id: reviewReviewers.id,
        reviewId: reviewReviewers.reviewId,
        name: sql<string | null>`coalesce(${users.name}, ${guests.name})`,
      })
      .from(reviewReviewers)
      .leftJoin(users, eq(users.id, reviewReviewers.userId))
      .leftJoin(
        guests,
        and(eq(guests.id, reviewReviewers.guestId), eq(guests.organisationId, organisationId)),
      )
      .where(
        inOrg(
          reviewReviewers,
          organisationId,
          inArray(reviewReviewers.reviewId, reviewIds),
          isNotNull(reviewReviewers.submittedAt),
        ),
      )
      .orderBy(
        asc(reviewReviewers.position),
        asc(reviewReviewers.createdAt),
        asc(reviewReviewers.id),
      ),
    db
      .select({ reviewerId: reviewDecisionLog.reviewerId, decision: reviewDecisionLog.decision })
      .from(reviewDecisionLog)
      .where(
        inOrg(reviewDecisionLog, organisationId, inArray(reviewDecisionLog.reviewId, reviewIds)),
      )
      .orderBy(asc(reviewDecisionLog.createdAt), asc(reviewDecisionLog.id)),
  ]);
  const last = new Map(logged.map((d) => [d.reviewerId, d.decision]));
  for (const r of rows) {
    if (!r.name) continue;
    const d = last.get(r.id);
    const decision = d === "approved" || d === "changes_requested" ? d : "feedback";
    out.set(r.reviewId, [...(out.get(r.reviewId) ?? []), { name: r.name, decision }]);
  }
  return out;
}

/**
 * `/api/projects/:id/board` (#141): every track of the project as a card, with where it stands
 * (the status its workflow gave it, the step it waits at), whom it waits on and by when, what its
 * latest review's reviewers said, its open tasks and, for those who read comments, how many of
 * its threads are open. The columns in both groupings come with it, from the project's
 * workflows that are switched on.
 */
export const projectBoardRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>().get("/:id/board", idParam, async (c) => {
    const organisationId = c.var.organisationId;
    const access = await can(db, actorOf(c.var), "view", c.req.valid("param").id);
    const projectId = access.projectId;
    const [standing, statusRows, flows, running, open, [project]] = await Promise.all([
      trackStandings(db, organisationId, projectId),
      db
        .select({ id: tracks.id, status: tracks.workflowStatus })
        .from(tracks)
        .where(inOrg(tracks, organisationId, eq(tracks.projectId, projectId))),
      db
        .select({ name: workflows.name, definition: workflows.definition })
        .from(workflows)
        .where(
          inOrg(
            workflows,
            organisationId,
            eq(workflows.projectId, projectId),
            eq(workflows.active, true),
          ),
        )
        // The project's own first, then those of single tracks.
        .orderBy(sql`${workflows.trackId} is not null`, asc(workflows.createdAt)),
      db
        .select({
          trackId: workflowRuns.trackId,
          engine: workflowRuns.engine,
          definition: workflowRuns.definition,
        })
        .from(workflowRuns)
        .where(
          inOrg(
            workflowRuns,
            organisationId,
            eq(workflowRuns.projectId, projectId),
            eq(workflowRuns.state, "running"),
          ),
        )
        .orderBy(desc(workflowRuns.createdAt)),
      // Every review of the project's tracks, newest first: the open ones give a due date, the
      // latest of each track's latest version its decisions.
      db
        .select({
          trackId: reviewItems.trackId,
          versionId: reviewItems.versionId,
          reviewId: reviews.id,
          status: reviews.status,
          dueAt: reviews.dueAt,
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
            ne(reviews.status, "cancelled"),
            sql`${reviewItems.trackId} is not null`,
          ),
        )
        .orderBy(desc(reviews.createdAt)),
      db
        .select({ statuses: projects.workflowStatuses })
        .from(projects)
        .where(inOrg(projects, organisationId, eq(projects.id, projectId))),
    ]);
    const statusOf = new Map(statusRows.map((r) => [r.id, r.status]));
    const versionIds = standing.tracks.flatMap((t) => (t.version ? [t.version.id] : []));
    const versionFiles =
      versionIds.length === 0
        ? []
        : await db
            .select({ versionId: variations.versionId, fileId: variations.fileId })
            .from(variations)
            .where(inOrg(variations, organisationId, inArray(variations.versionId, versionIds)));
    const fileIds = versionFiles.map((v) => v.fileId);
    const trackIds = standing.tracks.map((t) => t.id);
    const [openTasks, threads] = await Promise.all([
      trackIds.length === 0
        ? []
        : db
            .select({
              id: tasks.id,
              title: tasks.title,
              trackId: tasks.trackId,
              fileId: tasks.fileId,
              assigneeId: tasks.assigneeId,
              assigneeName: users.name,
            })
            .from(tasks)
            .leftJoin(users, eq(users.id, tasks.assigneeId))
            .where(
              inOrg(
                tasks,
                organisationId,
                eq(tasks.projectId, projectId),
                ne(tasks.status, "done"),
                or(
                  inArray(tasks.trackId, trackIds),
                  fileIds.length > 0 ? inArray(tasks.fileId, fileIds) : sql`false`,
                ),
              ),
            )
            .orderBy(asc(tasks.number)),
      // Counting threads is for those who may read them.
      fileIds.length === 0 || !access.permissions.has("read_comments")
        ? []
        : db
            .select({ fileId: comments.fileId, n: sql<number>`count(*)::int` })
            .from(comments)
            .where(
              inOrg(
                comments,
                organisationId,
                inArray(comments.fileId, fileIds),
                isNull(comments.parentId),
                isNull(comments.resolvedAt),
              ),
            )
            .groupBy(comments.fileId),
    ]);
    const threadsOn = new Map(threads.map((t) => [t.fileId, t.n]));
    // Each track's latest review of its latest version: one pinned to it, or one that follows
    // the track (no version of its own) and so covers whichever is latest.
    const latestOf = new Map<string, string>();
    for (const t of standing.tracks) {
      const latest = t.version
        ? open.find(
            (r) => r.trackId === t.id && (r.versionId === null || r.versionId === t.version?.id),
          )
        : undefined;
      if (latest) latestOf.set(t.id, latest.reviewId);
    }
    const said = await decisionsOf(db, organisationId, [...new Set(latestOf.values())]);
    const cards: BoardCard[] = [];
    for (const t of standing.tracks) {
      const files = new Set(
        versionFiles.filter((v) => v.versionId === t.version?.id).map((v) => v.fileId),
      );
      const run = running.find((r) => r.trackId === t.id);
      const stageId = run?.engine.active[0];
      const stage = stageId ? run?.definition.nodes.find((n) => n.id === stageId)?.name : null;
      const ofTrack = open.filter((r) => r.trackId === t.id);
      const due = ofTrack
        .filter((r) => r.status === "open" && r.dueAt)
        .map((r) => r.dueAt as Date)
        .sort((a, b) => a.getTime() - b.getTime())[0];
      cards.push({
        id: t.id,
        name: t.name,
        version: t.version
          ? { number: t.version.number, fileId: t.version.fileId, createdAt: t.version.createdAt }
          : null,
        status: statusOf.get(t.id) ?? null,
        stage: stage ?? null,
        waitingOn: t.waitingOn,
        dueAt: due ? due.toISOString() : null,
        decisions: said.get(latestOf.get(t.id) ?? "") ?? [],
        tasks: openTasks
          .filter((k) => k.trackId === t.id || (k.fileId !== null && files.has(k.fileId)))
          .map((k) => ({
            id: k.id,
            title: k.title,
            assignee: k.assigneeId ? { id: k.assigneeId, name: k.assigneeName ?? "" } : null,
          })),
        openComments: [...files].reduce((n, f) => n + (threadsOn.get(f) ?? 0), 0),
      });
    }
    const definitions: WorkflowDefinition[] = flows.map((f) => f.definition);
    const held = [...new Set(cards.flatMap((k) => (k.status ? [k.status] : [])))];
    const statusColumns = boardColumns(definitions, "status", held, project?.statuses ?? []);
    const board: Board = {
      workflows: flows.map((f) => f.name),
      columns: {
        status: statusColumns,
        stage: boardColumns(definitions, "stage", [
          ...new Set(cards.flatMap((k) => (k.stage ? [k.stage] : []))),
        ]),
      },
      // Each card's status as its column spells it, so one held in another case still lands.
      cards: cards.map((k) => {
        const status = k.status;
        return status
          ? { ...k, status: statusColumns.find((col) => sameStatus(col.id, status))?.id ?? status }
          : k;
      }),
    };
    return c.json(board);
  });

import { type Database, inOrg, schema } from "@hekate/db";
import {
  type TaskEventDetail,
  type TaskStatus,
  taskChangeInput,
  taskGroupOrder,
  taskInput,
  taskNoteInput,
  tasksCsv,
} from "@hekate/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, can, lockLiveProject } from "../access.ts";
import { NotFound } from "../errors.ts";
import { projectPeople } from "../notifications.ts";
import { zValidator } from "../openapi/validator.ts";
import {
  nameOf,
  nextTaskNumber,
  recordTaskEvent,
  rightsFor,
  selectTasks,
  type TaskMail,
  taskDetail,
  tellAssigned,
  tellAwaitingApproval,
} from "../tasks.ts";
import type { TenantVariables } from "../tenancy.ts";
import { lockRun, type RunnerDeps, stageTaskDone } from "../workflow-runner.ts";
import { attachment } from "./comments.ts";

const { comments, files, projects, tasks, tracks } = schema;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const idParam = zValidator("param", z.object({ id: z.uuid() }));

/** Refuses an owner who is not one of the project's people. */
async function checkAssignee(
  db: Database,
  organisationId: string,
  projectId: string,
  assigneeId: string | null | undefined,
) {
  if (!assigneeId) return;
  const people = await projectPeople(db, organisationId, projectId);
  if (!people.some((p) => p.id === assigneeId))
    throw new HTTPException(422, { message: "Give it to someone in this project" });
}

/** Refuses a track or file that is not the project's own. */
async function checkSubject(
  tx: Tx,
  organisationId: string,
  projectId: string,
  input: { trackId?: string | null; fileId?: string | null },
) {
  if (input.trackId) {
    const [track] = await tx
      .select({ id: tracks.id })
      .from(tracks)
      .where(
        inOrg(
          tracks,
          organisationId,
          eq(tracks.id, input.trackId),
          eq(tracks.projectId, projectId),
        ),
      );
    if (!track) throw new HTTPException(422, { message: "That track is not in this project" });
  }
  if (input.fileId) {
    const [file] = await tx
      .select({ id: files.id })
      .from(files)
      .where(
        inOrg(files, organisationId, eq(files.id, input.fileId), eq(files.projectId, projectId)),
      );
    if (!file) throw new HTTPException(422, { message: "That file is not in this project" });
  }
}

/** The list's order: by group (waiting on a decision first, done last), then by number. */
const listed = <T extends { status: TaskStatus; number: number }>(rows: T[]) =>
  [...rows].sort(
    (a, b) =>
      taskGroupOrder.indexOf(a.status) - taskGroupOrder.indexOf(b.status) || a.number - b.number,
  );

/**
 * A project's tasks (#140), under `/api/projects/:id/tasks`: the list, a task made by hand, and
 * the list as a spreadsheet. Whoever sees the project sees its tasks (decision 024); making
 * one is writing in it (`comment`).
 */
export const projectTaskRoutes = (deps: TaskMail) => {
  const { db } = deps;
  return new Hono<{ Variables: TenantVariables }>()
    .get("/:id/tasks", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const projectId = c.req.valid("param").id;
      const access = await can(db, actorOf(c.var), "view", projectId);
      const viewer = { userId: c.var.userId, permissions: access.permissions };
      const rows = await selectTasks(db, organisationId, eq(tasks.projectId, projectId), viewer);
      // Whom a task may be given to, for those who may make or run one.
      const people = access.permissions.has("comment")
        ? await projectPeople(db, organisationId, projectId)
        : [];
      return c.json({ tasks: listed(rows), people });
    })
    .get("/:id/tasks.csv", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const projectId = c.req.valid("param").id;
      const access = await can(db, actorOf(c.var), "view", projectId);
      const viewer = { userId: c.var.userId, permissions: access.permissions };
      const rows = await selectTasks(db, organisationId, eq(tasks.projectId, projectId), viewer);
      const [project] = await db
        .select({ name: projects.name })
        .from(projects)
        .where(inOrg(projects, organisationId, eq(projects.id, projectId)));
      return c.body(tasksCsv(listed(rows)), 200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": attachment(`${project?.name ?? "Project"} tasks.csv`),
        "Cache-Control": "no-store",
      });
    })
    .post("/:id/tasks", idParam, zValidator("json", taskInput), async (c) => {
      const organisationId = c.var.organisationId;
      const projectId = c.req.valid("param").id;
      const access = await can(db, actorOf(c.var), "comment", projectId);
      const input = c.req.valid("json");
      await checkAssignee(db, organisationId, projectId, input.assigneeId);
      const userId = c.var.userId;
      const made = await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, projectId);
        await checkSubject(tx, organisationId, projectId, input);
        const [row] = await tx
          .insert(tasks)
          .values({
            organisationId,
            projectId,
            number: await nextTaskNumber(tx, organisationId, projectId),
            title: input.title,
            notes: input.notes || null,
            priority: input.priority,
            assigneeId: input.assigneeId ?? null,
            dueOn: input.dueOn ?? null,
            trackId: input.trackId ?? null,
            fileId: input.fileId ?? null,
            createdById: userId,
          })
          .returning();
        if (!row) throw new Error("A task was not made");
        await recordTaskEvent(tx, organisationId, row.id, userId, "created");
        if (row.assigneeId)
          await recordTaskEvent(tx, organisationId, row.id, userId, "assigned", {
            assignee: await nameOf(tx, row.assigneeId),
            self: row.assigneeId === userId,
          });
        return row;
      });
      if (made.assigneeId && made.assigneeId !== userId)
        await tellAssigned(deps, made, made.assigneeId, userId);
      const viewer = { userId, permissions: access.permissions };
      return c.json({ task: await taskDetail(db, organisationId, made.id, viewer) }, 201);
    });
};

/** A task of this workspace that the member may see, with what they may do in its project. */
async function taskOf(db: Database, vars: TenantVariables, id: string) {
  const [row] = await db
    .select()
    .from(tasks)
    .where(inOrg(tasks, vars.organisationId, eq(tasks.id, id)));
  if (!row) throw new NotFound("Task");
  // A project they cannot see hides its tasks: 404, as for the project itself.
  const access = await can(db, actorOf(vars), "view", row.projectId).catch((error: unknown) => {
    if (error instanceof HTTPException && error.status === 404) throw new NotFound("Task");
    throw error;
  });
  return { row, viewer: { userId: vars.userId, permissions: access.permissions } };
}

/** Names of the fields a change touches, as its activity line says them. */
const fieldNames: Record<string, string> = {
  title: "title",
  notes: "notes",
  priority: "priority",
  dueOn: "due date",
  trackId: "track",
  fileId: "file",
};

/**
 * One task (#140), under `/api/tasks/:id`: reading it with its activity, changing it, adding a
 * note and deleting it. What each member may do is `taskRights`, checked again on the row as
 * it is locked, so a change made meanwhile is decided on what it is now.
 */
export const taskRoutes = (deps: TaskMail & { runner?: RunnerDeps }) => {
  const { db } = deps;
  return new Hono<{ Variables: TenantVariables }>()
    .get("/:id", idParam, async (c) => {
      const { row, viewer } = await taskOf(db, c.var, c.req.valid("param").id);
      return c.json({ task: await taskDetail(db, c.var.organisationId, row.id, viewer) });
    })
    .patch("/:id", idParam, zValidator("json", taskChangeInput), async (c) => {
      const organisationId = c.var.organisationId;
      const id = c.req.valid("param").id;
      const input = c.req.valid("json");
      const userId = c.var.userId;
      const { row: seen, viewer } = await taskOf(db, c.var, id);
      await checkAssignee(db, organisationId, seen.projectId, input.assigneeId);
      const outcome = await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, seen.projectId);
        // A workflow's task: its run first, as a step ending by hand takes them (run, then task).
        if (seen.runId && deps.runner) await lockRun(tx, organisationId, seen.runId);
        const [task] = await tx
          .select()
          .from(tasks)
          .where(inOrg(tasks, organisationId, eq(tasks.id, id)))
          .for("update");
        if (!task) throw new NotFound("Task");
        const rights = rightsFor(task, viewer);
        const edits = Object.keys(fieldNames).filter((k) => {
          const v = input[k as keyof typeof input];
          return (
            v !== undefined && (k === "notes" ? v || null : v) !== task[k as keyof typeof task]
          );
        });
        const reassigned = input.assigneeId !== undefined && input.assigneeId !== task.assigneeId;
        const moved = input.status !== undefined && input.status !== task.status;
        if ((edits.length > 0 || reassigned) && !rights.edit)
          throw new HTTPException(403, { message: "Only whoever runs this task can change it" });
        if (moved && !rights.statusTo.includes(input.status as TaskStatus))
          throw new HTTPException(403, {
            message:
              task.status === "needs_approval" && input.status === "done"
                ? "Whoever runs this task approves it"
                : "This task is not yours to move",
          });
        await checkSubject(tx, organisationId, task.projectId, input);
        const status = moved ? (input.status as TaskStatus) : task.status;
        const now = new Date();
        await tx
          .update(tasks)
          .set({
            ...(input.title !== undefined && { title: input.title }),
            ...(input.notes !== undefined && { notes: input.notes || null }),
            ...(input.priority !== undefined && { priority: input.priority }),
            // A new date starts its reminders afresh, even one set back to a date reminded before.
            ...(input.dueOn !== undefined &&
              input.dueOn !== task.dueOn && {
                dueOn: input.dueOn,
                dueRemindedOn: null,
                lateRemindedOn: null,
              }),
            ...(input.trackId !== undefined && { trackId: input.trackId }),
            ...(input.fileId !== undefined && { fileId: input.fileId }),
            ...(reassigned && { assigneeId: input.assigneeId ?? null }),
            ...(moved && {
              status,
              doneAt: status === "done" ? now : null,
              doneById: status === "done" ? userId : null,
            }),
            updatedAt: now,
          })
          .where(inOrg(tasks, organisationId, eq(tasks.id, id)));
        // A thread's task is for whoever the thread is for: giving one gives the other.
        if (reassigned && task.commentId)
          await tx
            .update(comments)
            .set({ assigneeId: input.assigneeId ?? null, updatedAt: now })
            .where(inOrg(comments, organisationId, eq(comments.id, task.commentId)));
        if (edits.length > 0)
          await recordTaskEvent(tx, organisationId, id, userId, "edited", {
            fields: edits.map((k) => fieldNames[k] ?? k),
          });
        if (reassigned)
          await recordTaskEvent(tx, organisationId, id, userId, "assigned", {
            assignee: await nameOf(tx, input.assigneeId ?? null),
            self: input.assigneeId === userId,
          });
        if (moved) {
          const detail: TaskEventDetail = { from: task.status, to: status };
          await recordTaskEvent(tx, organisationId, id, userId, "status", detail);
        }
        // A task a workflow's task stage made, done: the stage ends done with it (#140, #25), in
        // this transaction, so the task is never done while its stage still waits.
        const afterCommit =
          moved && status === "done" && task.runId && task.nodeId && deps.runner
            ? await stageTaskDone(
                tx,
                deps.runner,
                { id, organisationId, runId: task.runId, nodeId: task.nodeId },
                userId,
              )
            : null;
        return { task, reassigned, moved, status, afterCommit };
      });
      const { task } = outcome;
      if (outcome.reassigned && input.assigneeId && input.assigneeId !== userId)
        await tellAssigned(
          deps,
          { ...task, title: input.title ?? task.title },
          input.assigneeId,
          userId,
        );
      if (outcome.moved && outcome.status === "needs_approval" && task.createdById !== userId)
        await tellAwaitingApproval(deps, { ...task, title: input.title ?? task.title }, userId);
      await outcome.afterCommit?.();
      return c.json({ task: await taskDetail(db, organisationId, id, viewer) });
    })
    .post("/:id/notes", idParam, zValidator("json", taskNoteInput), async (c) => {
      const organisationId = c.var.organisationId;
      const id = c.req.valid("param").id;
      const { row, viewer } = await taskOf(db, c.var, id);
      if (!viewer.permissions.has("comment"))
        throw new HTTPException(403, { message: "Your role in this project does not allow that" });
      await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, row.projectId);
        await recordTaskEvent(
          tx,
          organisationId,
          id,
          c.var.userId,
          "note",
          null,
          c.req.valid("json").note,
        );
      });
      return c.json({ task: await taskDetail(db, organisationId, id, viewer) }, 201);
    })
    .delete("/:id", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const id = c.req.valid("param").id;
      const { row, viewer } = await taskOf(db, c.var, id);
      await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, row.projectId);
        const [task] = await tx
          .select()
          .from(tasks)
          .where(inOrg(tasks, organisationId, eq(tasks.id, id)))
          .for("update");
        if (!task) throw new NotFound("Task");
        if (!rightsFor(task, viewer).delete)
          throw new HTTPException(403, { message: "Only whoever runs this task can delete it" });
        await tx.delete(tasks).where(inOrg(tasks, organisationId, eq(tasks.id, id)));
      });
      return c.body(null, 204);
    });
};

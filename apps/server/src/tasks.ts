import { type Database, inOrg, schema } from "@hekate/db";
import {
  type ProjectPermission,
  type TaskDetail,
  type TaskEventDetail,
  type TaskEventKind,
  type TaskStatus,
  type TaskSummary,
  taskEventText,
  taskKey,
  taskReminder,
  taskRights,
} from "@hekate/shared";
import { and, asc, eq, isNotNull, lte, ne, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { LinkRoots } from "./hosts.ts";
import type { Mailer } from "./mail.ts";
import { notifyNow, recordNotification } from "./notifications.ts";

const { comments, files, guests, organisations, projects, taskEvents, tasks, tracks, users } =
  schema;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Db = Database | Tx;

const assignee = alias(users, "task_assignee");
const creator = alias(users, "task_creator");

/** Who is looking at a project's tasks, and what their role lets them do there. */
export interface TaskViewer {
  userId: string;
  permissions: ReadonlySet<ProjectPermission>;
}

/** What the viewer may do with a task, by their role and their part in it. */
export const rightsFor = (
  row: { createdById: string | null; assigneeId: string | null; status: TaskStatus },
  viewer: TaskViewer,
) =>
  taskRights(row, {
    userId: viewer.userId,
    comment: viewer.permissions.has("comment"),
    triage: viewer.permissions.has("triage"),
  });

/**
 * The next number in a project's tasks, inside the transaction that adds one. The project's
 * count is taken as it is raised, so two tasks made at once never share a number, and one
 * deleted never gives its number to the next.
 */
export async function nextTaskNumber(tx: Tx, organisationId: string, projectId: string) {
  const [row] = await tx
    .update(projects)
    .set({ tasksNumbered: sql`${projects.tasksNumbered} + 1` })
    .where(inOrg(projects, organisationId, eq(projects.id, projectId)))
    .returning({ n: projects.tasksNumbered });
  if (!row) throw new Error("No project to number a task in");
  return row.n;
}

/** A line in a task's activity, with the actor's name as it is now. */
export async function recordTaskEvent(
  tx: Db,
  organisationId: string,
  taskId: string,
  actorId: string | null,
  kind: TaskEventKind,
  detail: TaskEventDetail | null = null,
  note: string | null = null,
) {
  const [actor] = actorId
    ? await tx.select({ name: users.name }).from(users).where(eq(users.id, actorId))
    : [];
  await tx.insert(taskEvents).values({
    organisationId,
    taskId,
    actorId,
    actorName: actor?.name ?? null,
    kind,
    detail,
    note,
  });
}

/** A member's name, for an activity line about them. */
export async function nameOf(db: Db, userId: string | null) {
  if (!userId) return null;
  const [row] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  return row?.name ?? null;
}

const summaryColumns = {
  id: tasks.id,
  projectId: tasks.projectId,
  projectName: projects.name,
  number: tasks.number,
  title: tasks.title,
  notes: tasks.notes,
  status: tasks.status,
  priority: tasks.priority,
  assigneeId: tasks.assigneeId,
  assigneeName: assignee.name,
  dueOn: tasks.dueOn,
  trackId: tasks.trackId,
  trackName: tracks.name,
  fileId: tasks.fileId,
  fileName: files.name,
  commentId: tasks.commentId,
  runId: tasks.runId,
  createdById: tasks.createdById,
  createdByName: creator.name,
  createdAt: tasks.createdAt,
  doneAt: tasks.doneAt,
};

/** Tasks of this workspace, as their list shows them, in the order given. */
export async function selectTasks(
  db: Db,
  organisationId: string,
  where: SQL | undefined,
  viewer: TaskViewer,
): Promise<TaskSummary[]> {
  const rows = await db
    .select(summaryColumns)
    .from(tasks)
    .innerJoin(
      projects,
      and(eq(projects.id, tasks.projectId), eq(projects.organisationId, organisationId)),
    )
    .leftJoin(assignee, eq(assignee.id, tasks.assigneeId))
    .leftJoin(creator, eq(creator.id, tasks.createdById))
    .leftJoin(tracks, and(eq(tracks.id, tasks.trackId), eq(tracks.organisationId, organisationId)))
    .leftJoin(files, and(eq(files.id, tasks.fileId), eq(files.organisationId, organisationId)))
    .where(inOrg(tasks, organisationId, where))
    .orderBy(asc(tasks.number));
  return rows.map((r) => ({
    id: r.id,
    projectId: r.projectId,
    number: r.number,
    key: taskKey(r.projectName, r.number),
    title: r.title,
    notes: r.notes,
    status: r.status,
    priority: r.priority,
    assignee: r.assigneeId ? { id: r.assigneeId, name: r.assigneeName ?? "" } : null,
    dueOn: r.dueOn,
    track: r.trackId ? { id: r.trackId, name: r.trackName ?? "" } : null,
    file: r.fileId ? { id: r.fileId, name: r.fileName ?? "" } : null,
    commentId: r.commentId,
    fromWorkflow: r.runId !== null,
    createdBy: r.createdById ? { id: r.createdById, name: r.createdByName ?? "" } : null,
    createdAt: r.createdAt.toISOString(),
    doneAt: r.doneAt?.toISOString() ?? null,
    rights: rightsFor(r, viewer),
  }));
}

/** One task in full, or null: the comment it came from where the viewer may read it. */
export async function taskDetail(
  db: Db,
  organisationId: string,
  id: string,
  viewer: TaskViewer,
): Promise<TaskDetail | null> {
  const [task] = await selectTasks(db, organisationId, eq(tasks.id, id), viewer);
  if (!task) return null;
  const [comment] =
    task.commentId && viewer.permissions.has("read_comments")
      ? await db
          .select({
            body: comments.body,
            authorName: sql<string | null>`coalesce(${users.name}, ${guests.name})`,
            createdAt: comments.createdAt,
          })
          .from(comments)
          .leftJoin(users, eq(users.id, comments.authorId))
          .leftJoin(guests, eq(guests.id, comments.guestAuthorId))
          .where(inOrg(comments, organisationId, eq(comments.id, task.commentId)))
      : [];
  const events = await db
    .select()
    .from(taskEvents)
    .where(inOrg(taskEvents, organisationId, eq(taskEvents.taskId, id)))
    .orderBy(asc(taskEvents.createdAt), asc(taskEvents.id));
  return {
    ...task,
    comment: comment ? { ...comment, createdAt: comment.createdAt.toISOString() } : null,
    events: events.map((e) => ({
      id: e.id,
      at: e.createdAt.toISOString(),
      actorName: e.actorName,
      kind: e.kind,
      text: taskEventText(e.kind, e.detail),
      note: e.note,
    })),
  };
}

/** The task a thread became, if any (one to a thread), held until the transaction ends. */
export async function taskOfComment(tx: Tx, organisationId: string, commentId: string) {
  const [row] = await tx
    .select()
    .from(tasks)
    .where(inOrg(tasks, organisationId, eq(tasks.commentId, commentId)))
    .for("update");
  return row ?? null;
}

export interface TaskMail extends LinkRoots {
  db: Database;
  mailer: Mailer;
}

/** Tell someone a task is theirs now. Run after the change commits; a failure is logged. */
export async function tellAssigned(
  deps: TaskMail,
  task: { id: string; organisationId: string; projectId: string; title: string },
  assigneeId: string,
  actorId: string,
) {
  await notifyNow(deps, {
    organisationId: task.organisationId,
    kind: "task",
    recipients: [assigneeId],
    actor: { userId: actorId },
    projectId: task.projectId,
    text: "gave you a task",
    detail: task.title,
    link: `/projects/${task.projectId}/tasks?task=${task.id}`,
  }).catch((error: unknown) =>
    console.warn(`Could not tell someone about a task: ${String(error)}`),
  );
}

/** Tell whoever runs a task that it waits for their approval. */
export async function tellAwaitingApproval(
  deps: TaskMail,
  task: {
    id: string;
    organisationId: string;
    projectId: string;
    title: string;
    createdById: string | null;
  },
  actorId: string,
) {
  if (!task.createdById) return;
  await notifyNow(deps, {
    organisationId: task.organisationId,
    kind: "task",
    recipients: [task.createdById],
    actor: { userId: actorId },
    projectId: task.projectId,
    text: "finished a task, waiting for your approval",
    detail: task.title,
    link: `/projects/${task.projectId}/tasks?task=${task.id}`,
  }).catch((error: unknown) =>
    console.warn(`Could not tell someone about a task: ${String(error)}`),
  );
}

/** The day and hour where someone is, in their time zone; UTC where they chose none. */
function localNow(now: Date, timeZone: string | null): { today: string; hour: number } {
  const parts = (zone: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
  let read: Intl.DateTimeFormatPart[];
  try {
    read = parts(timeZone ?? "UTC");
  } catch {
    read = parts("UTC");
  }
  const part = (type: string) => read.find((p) => p.type === type)?.value ?? "";
  return { today: `${part("year")}-${part("month")}-${part("day")}`, hour: Number(part("hour")) };
}

/**
 * Remind whoever each open task is for of its date (#140, #110): on the day it is due, and once
 * it is late, each once, from eight in the morning where they are (`taskReminder`). Each
 * reminder is claimed on the task as it is recorded, in one transaction, so two runs never send
 * it twice. Hourly, with the review reminders.
 */
export async function remindTasksDue(db: Database, now = new Date()) {
  let reminded = 0;
  // A day ahead of UTC covers every time zone's today.
  const horizon = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  for (const workspace of await db.select({ id: organisations.id }).from(organisations)) {
    const due = await db
      .select({
        id: tasks.id,
        projectId: tasks.projectId,
        projectName: projects.name,
        number: tasks.number,
        title: tasks.title,
        status: tasks.status,
        dueOn: tasks.dueOn,
        dueRemindedOn: tasks.dueRemindedOn,
        lateRemindedOn: tasks.lateRemindedOn,
        assigneeId: tasks.assigneeId,
        timeZone: users.timeZone,
      })
      .from(tasks)
      .innerJoin(
        projects,
        and(eq(projects.id, tasks.projectId), eq(projects.organisationId, workspace.id)),
      )
      .innerJoin(users, eq(users.id, tasks.assigneeId))
      .where(
        inOrg(
          tasks,
          workspace.id,
          ne(tasks.status, "done"),
          isNotNull(tasks.dueOn),
          lte(tasks.dueOn, horizon),
        ),
      );
    for (const task of due) {
      const { today, hour } = localNow(now, task.timeZone);
      const which = taskReminder(task, today, hour);
      if (!which || !task.dueOn || !task.assigneeId) continue;
      const dueOn = task.dueOn;
      const assigneeId = task.assigneeId;
      const told = await db.transaction(async (tx) => {
        // Claimed as it was read: done, given away or moved meanwhile, it is not sent.
        const column = which === "due" ? tasks.dueRemindedOn : tasks.lateRemindedOn;
        const [claimed] = await tx
          .update(tasks)
          .set(which === "due" ? { dueRemindedOn: dueOn } : { lateRemindedOn: dueOn })
          .where(
            inOrg(
              tasks,
              workspace.id,
              eq(tasks.id, task.id),
              ne(tasks.status, "done"),
              eq(tasks.dueOn, dueOn),
              eq(tasks.assigneeId, assigneeId),
              sql`${column} is distinct from ${dueOn}`,
            ),
          )
          .returning({ id: tasks.id });
        if (!claimed) return false;
        await recordNotification(tx, {
          organisationId: workspace.id,
          kind: "task",
          recipients: [assigneeId],
          actor: null,
          projectId: task.projectId,
          text: `your task ${taskKey(task.projectName, task.number)} is ${which === "due" ? "due today" : "overdue"}`,
          detail: task.title,
          link: `/projects/${task.projectId}/tasks?task=${task.id}`,
        });
        return true;
      });
      if (told) reminded++;
    }
  }
  return reminded;
}

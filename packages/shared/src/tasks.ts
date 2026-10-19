import { z } from "zod";

/**
 * Tasks (#140): a project's tracker. Each has an owner, a priority, a status and a date, and
 * may be about a track or a file, or have come from a comment's thread (which it replaces as a
 * thread's to-do, decision 124), or from a workflow's task stage (#25).
 */

export const taskStatuses = ["pending", "in_progress", "needs_approval", "done"] as const;
export type TaskStatus = (typeof taskStatuses)[number];
export const taskStatus = z.enum(taskStatuses);

export const taskStatusNames: Record<TaskStatus, string> = {
  pending: "To do",
  in_progress: "In progress",
  needs_approval: "Needs approval",
  done: "Done",
};

export const taskPriorities = ["low", "normal", "high"] as const;
export type TaskPriority = (typeof taskPriorities)[number];
export const taskPriority = z.enum(taskPriorities);

const title = z.string().trim().min(1, "A task needs a title").max(200);
const notes = z.string().trim().max(4000);
const userId = z.string().min(1).max(64);

/** A task made by hand. */
export const taskInput = z.object({
  title,
  notes: notes.nullable().optional(),
  assigneeId: userId.nullable().optional(),
  priority: taskPriority.default("normal"),
  /** The day it is due: 2026-10-21. */
  dueOn: z.iso.date().nullable().optional(),
  /** What it is about: a track, or a file, of the same project. */
  trackId: z.uuid().nullable().optional(),
  fileId: z.uuid().nullable().optional(),
});
export type TaskInput = z.infer<typeof taskInput>;

/** What changes on a task; anything left out stays as it is. */
export const taskChangeInput = z.object({
  title: title.optional(),
  notes: notes.nullable().optional(),
  assigneeId: userId.nullable().optional(),
  priority: taskPriority.optional(),
  dueOn: z.iso.date().nullable().optional(),
  trackId: z.uuid().nullable().optional(),
  fileId: z.uuid().nullable().optional(),
  status: taskStatus.optional(),
});
export type TaskChange = z.infer<typeof taskChangeInput>;

/** A note added to a task's activity. */
export const taskNoteInput = z.object({ note: z.string().trim().min(1).max(4000) });

/** What a member may do with a task: the edges of their role and their part in it. */
export interface TaskRights {
  /** Its title, notes, owner, priority, date and what it is about. */
  edit: boolean;
  /** Moving it between to do, in progress, needs approval and done, within `statusTo`. */
  status: boolean;
  /** The statuses they may move it to from where it is. */
  statusTo: TaskStatus[];
  delete: boolean;
  /** Adding a note to its activity. */
  note: boolean;
}

/**
 * Who may do what with a task. Writing in the project (`comment`) is the floor; on top of
 * it, its creator and those who triage run it, and whoever it is for may move it along, as
 * they could a thread's to-do (decision 067), except that a task waiting for approval is
 * approved (made done) by its creator or triage, never by its own owner, even one who also
 * runs it.
 */
export function taskRights(
  task: { createdById: string | null; assigneeId: string | null; status: TaskStatus },
  viewer: { userId: string; comment: boolean; triage: boolean },
): TaskRights {
  const runs = viewer.comment && (viewer.triage || task.createdById === viewer.userId);
  const owns = viewer.comment && task.assigneeId === viewer.userId;
  // Whoever it is for never approves their own, even where they also run it.
  const statusTo =
    runs || owns
      ? taskStatuses.filter(
          (s) => s !== task.status && !(owns && task.status === "needs_approval" && s === "done"),
        )
      : [];
  return {
    edit: runs,
    status: statusTo.length > 0,
    statusTo,
    delete: runs,
    note: viewer.comment,
  };
}

/** A task's key, as its list shows it: the project's initials and its number, "JR-3". */
export function taskKey(projectName: string, number: number): string {
  const initials = projectName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((w) => (w[0] ?? "").toUpperCase())
    .join("");
  return `${initials || "T"}-${number}`;
}

/** A task's title from the comment it is made from: its first line, made to fit. */
export function taskTitleFromComment(body: string, fallback: string): string {
  const line =
    body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  const words = line.replace(/\s+/g, " ");
  if (!words) return fallback;
  return words.length <= 120 ? words : `${words.slice(0, 119).trimEnd()}…`;
}

/** Whether a task is late: due before today and not done. `today` is a date, 2026-10-19. */
export const isOverdue = (task: { dueOn: string | null; status: TaskStatus }, today: string) =>
  task.dueOn !== null && task.status !== "done" && task.dueOn < today;

/** The filters the list offers. */
export const taskFilters = ["open", "mine", "unassigned", "overdue", "all"] as const;
export type TaskFilter = (typeof taskFilters)[number];

/** The tasks a filter keeps. */
export function filterTasks<
  T extends { status: TaskStatus; dueOn: string | null; assignee: { id: string } | null },
>(tasks: T[], filter: TaskFilter, viewerId: string, today: string): T[] {
  return tasks.filter((t) =>
    filter === "mine"
      ? t.assignee?.id === viewerId && t.status !== "done"
      : filter === "unassigned"
        ? t.assignee === null && t.status !== "done"
        : filter === "overdue"
          ? isOverdue(t, today)
          : filter === "open"
            ? t.status !== "done"
            : true,
  );
}

/** The order the list groups tasks in: what waits on a decision first, done last. */
export const taskGroupOrder: readonly TaskStatus[] = [
  "needs_approval",
  "in_progress",
  "pending",
  "done",
];

/** Something that happened to a task, as its activity tells it. */
export type TaskEventKind =
  | "created"
  | "from_comment"
  | "from_workflow"
  | "assigned"
  | "status"
  | "edited"
  | "note";

export interface TaskEventDetail {
  /** Whom it was given to; null when it was left with nobody. */
  assignee?: string | null;
  from?: TaskStatus;
  to?: TaskStatus;
  /** What was changed, for an edit: "title", "due date"… */
  fields?: string[];
}

/** How an event reads after the name of whoever did it. */
export function taskEventText(kind: TaskEventKind, detail: TaskEventDetail | null): string {
  switch (kind) {
    case "created":
      return "created the task";
    case "from_comment":
      return "made it from a comment";
    case "from_workflow":
      return "made it as a workflow stage";
    case "assigned":
      return detail?.assignee ? `gave it to ${detail.assignee}` : "left it with nobody";
    case "status":
      if (detail?.from === "needs_approval" && detail.to === "done")
        return "approved and closed it";
      if (detail?.from === "needs_approval" && detail.to !== "done") return "sent it back";
      if (detail?.to === "needs_approval") return "marked it done, waiting for approval";
      if (detail?.to === "done") return "marked it done";
      if (detail?.to === "in_progress") return "started on it";
      return "opened it again";
    case "edited":
      return `changed the ${(detail?.fields ?? ["task"]).join(" and ")}`;
    case "note":
      return "added a note";
  }
}

/** A task as its project's list shows it. */
export interface TaskSummary {
  id: string;
  projectId: string;
  number: number;
  key: string;
  title: string;
  notes: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: { id: string; name: string } | null;
  dueOn: string | null;
  track: { id: string; name: string } | null;
  file: { id: string; name: string } | null;
  /** The thread it came from, if any, and the file that thread is on. */
  commentId: string | null;
  /** The workflow stage that made it, if any (#25). */
  fromWorkflow: boolean;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  doneAt: string | null;
  rights: TaskRights;
}

export interface TaskEvent {
  id: string;
  at: string;
  actorName: string | null;
  kind: TaskEventKind;
  text: string;
  /** A note's own words. */
  note: string | null;
}

/** One task in full: the comment it came from, as the viewer may read it, and its activity. */
export interface TaskDetail extends TaskSummary {
  comment: { body: string; authorName: string | null; createdAt: string } | null;
  events: TaskEvent[];
}

const csvCell = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
/** People's words in a spreadsheet cell: never read as a formula (OWASP's CSV injection). */
const spreadsheetText = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);

/** A project's tasks as a spreadsheet, one row each, in the order given. */
export function tasksCsv(tasks: TaskSummary[]): string {
  const header = ["Key", "Title", "Status", "Priority", "Owner", "Due", "About", "From", "Created"];
  const rows = tasks.map((t) => [
    t.key,
    spreadsheetText(t.title),
    taskStatusNames[t.status],
    t.priority,
    spreadsheetText(t.assignee?.name ?? ""),
    t.dueOn ?? "",
    spreadsheetText(t.track?.name ?? t.file?.name ?? ""),
    t.commentId ? "A comment" : t.fromWorkflow ? "The workflow" : "By hand",
    t.createdAt.slice(0, 10),
  ]);
  return `${[header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

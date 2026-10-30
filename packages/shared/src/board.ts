import { z } from "zod";
import { flowShape, type WorkflowDefinition } from "./workflows.ts";

/**
 * A project's board (#141): its tracks in columns by the status their workflow gave them, or by
 * the stage each waits at, as Linear's board groups issues. What the cards carry is each
 * person's own, kept with their account.
 */

export const boardGroupings = ["status", "stage"] as const;
export type BoardGrouping = (typeof boardGroupings)[number];

export const boardDisplaySchema = z.object({
  groupBy: z.enum(boardGroupings),
  /** On the cards: open tasks about the track, open comments, decisions and feedback. */
  tasks: z.boolean(),
  comments: z.boolean(),
  decisions: z.boolean(),
  fields: z.object({
    version: z.boolean(),
    stage: z.boolean(),
    reviewers: z.boolean(),
    due: z.boolean(),
  }),
  /** Columns put away, by name. */
  hidden: z.array(z.string().max(120)).max(50),
});
export type BoardDisplay = z.infer<typeof boardDisplaySchema>;

export const defaultBoardDisplay: BoardDisplay = {
  groupBy: "status",
  tasks: true,
  comments: true,
  decisions: true,
  fields: { version: true, stage: true, reviewers: true, due: true },
  hidden: [],
};

/** Setting a project's own arrangement of its board, for those who have not chosen theirs. */
export const boardDefaultInput = z.object({ display: boardDisplaySchema }).strict();
export type BoardDefaultInput = z.infer<typeof boardDefaultInput>;

/** Whether two arrangements of a board are the same, hidden columns in any order. */
export function sameBoardDisplay(a: BoardDisplay, b: BoardDisplay): boolean {
  const hidden = (d: BoardDisplay) => [...d.hidden].sort().join("\n");
  return (
    a.groupBy === b.groupBy &&
    a.tasks === b.tasks &&
    a.comments === b.comments &&
    a.decisions === b.decisions &&
    a.fields.version === b.fields.version &&
    a.fields.stage === b.fields.stage &&
    a.fields.reviewers === b.fields.reviewers &&
    a.fields.due === b.fields.due &&
    hidden(a) === hidden(b)
  );
}

/**
 * How someone sees a project's board (decision 256): their own arrangement once they have
 * chosen one, else the project's default where it has one, else the built-in arrangement.
 */
export function boardDisplayFor(
  own: { board: BoardDisplay; boardChosen: boolean },
  projectDefault: BoardDisplay | null | undefined,
): BoardDisplay {
  if (own.boardChosen) return own.board;
  return projectDefault ?? defaultBoardDisplay;
}

/** How a column reads beside its name: not started, under way, or done. */
export const statusCategories = ["todo", "in_progress", "done"] as const;
export type ColumnCategory = (typeof statusCategories)[number];

/** Whether two names are the same status: a set keeps each name once, whatever its case. */
export const sameStatus = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/** A status of a project's set (#26): what its workflows' steps set, and how it reads. */
export const workflowStatusSchema = z.object({
  name: z.string().trim().min(1).max(60),
  category: z.enum(statusCategories),
});
export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;

/** A project's whole status set, in its order: each name once, whatever its case. */
export const workflowStatusesInput = z.object({
  statuses: z
    .array(workflowStatusSchema)
    .max(50)
    .refine(
      (list) => new Set(list.map((s) => s.name.toLowerCase())).size === list.length,
      "Each status once",
    ),
});

/** A status as the Statuses panel lists it: in the set, or only set by a step so far. */
export interface ProjectStatus extends WorkflowStatus {
  /** How many steps of the project's workflows set it. */
  steps: number;
  /** Kept in the project's set, rather than only found on a step. */
  kept: boolean;
}

/**
 * A project's statuses: its set, in its order and with the categories it gives, then any a step
 * sets that the set does not have, in the order a run reaches them, a finish's counting as done.
 */
export function projectStatuses(
  set: WorkflowStatus[],
  workflows: WorkflowDefinition[],
): ProjectStatus[] {
  const out: ProjectStatus[] = set.map((s) => ({ ...s, steps: 0, kept: true }));
  // A step that spells a status in another case sets the same one, as the set spells it.
  const find = (name: string) => out.find((s) => sameStatus(s.name, name));
  for (const flow of workflows) {
    const byId = new Map(flow.nodes.map((n) => [n.id, n]));
    for (const id of flowShape(flow).order) {
      const node = byId.get(id);
      const name = node?.config.status?.trim();
      if (!node || !name) continue;
      const done = node.type === "finish";
      const known = find(name);
      if (!known)
        out.push({ name, category: done ? "done" : "in_progress", steps: 1, kept: false });
      else {
        known.steps += 1;
        // Only a status the set does not place reads as done for a finish's setting it.
        if (done && !known.kept) known.category = "done";
      }
    }
  }
  return out;
}

export interface BoardColumn {
  /** Its name, which is what a card names too. */
  id: string;
  name: string;
  category: ColumnCategory;
}

/** The column of tracks with no version yet, first in either grouping. */
export const NO_VERSION = "No version";
/** Versioned tracks no workflow has given a status, or at no stage now. */
export const NO_STATUS = "No status";
export const NOT_AT_A_STAGE = "Not at a stage";

/** Steps a track waits at: what the stage grouping makes columns of. */
const waitingTypes = new Set(["approval", "feedback", "task", "checks", "wait", "share"]);

/**
 * The columns for a project's workflows: in status grouping, the project's statuses (its set,
 * then any only a step sets); in stage grouping, every step a track can wait at. Statuses tracks
 * hold that no workflow sets any more (one renamed, or switched off) are added after, so no track
 * is left out.
 */
export function boardColumns(
  workflows: WorkflowDefinition[],
  groupBy: BoardGrouping,
  held: string[] = [],
  set: WorkflowStatus[] = [],
): BoardColumn[] {
  // Tracks with a version but no status, or at no step, come next: not yet in the workflow.
  const rest = groupBy === "stage" ? NOT_AT_A_STAGE : NO_STATUS;
  const columns: BoardColumn[] = [
    { id: NO_VERSION, name: NO_VERSION, category: "todo" },
    { id: rest, name: rest, category: "todo" },
  ];
  const add = (name: string, category: ColumnCategory) => {
    const key = name.trim();
    if (!key || columns.some((c) => sameStatus(c.id, key))) return;
    columns.push({ id: key, name: key, category });
  };
  if (groupBy === "status") {
    for (const s of projectStatuses(set, workflows)) add(s.name, s.category);
  } else {
    for (const flow of workflows) {
      const byId = new Map(flow.nodes.map((n) => [n.id, n]));
      for (const id of flowShape(flow).order) {
        const node = byId.get(id);
        if (node && waitingTypes.has(node.type)) add(node.name, "in_progress");
      }
    }
  }
  for (const name of held) add(name, "in_progress");
  return columns;
}

/** The column a track's card sits in. */
export function boardColumnOf(
  track: { version: unknown | null; status: string | null; stage: string | null },
  groupBy: BoardGrouping,
): string {
  if (!track.version) return NO_VERSION;
  if (groupBy === "stage") return track.stage?.trim() || NOT_AT_A_STAGE;
  return track.status?.trim() || NO_STATUS;
}

/** A decision or feedback on a track's latest review, as its card lists it. */
export interface BoardDecision {
  name: string;
  decision: "approved" | "changes_requested" | "feedback";
}

/** A track on the board: where it stands, and what is waiting on whom. */
export interface BoardCard {
  id: string;
  name: string;
  /** Its latest version, and when that arrived. */
  version: { number: number; fileId: string | null; createdAt: string } | null;
  /** The status its workflow last gave it. */
  status: string | null;
  /** The step its running workflow waits at, if any. */
  stage: string | null;
  /** Those an open review of it waits on, and the earliest such review's due date. */
  waitingOn: { id: string; name: string }[];
  dueAt: string | null;
  /** The track's own deadline (#505), set in its details or dragged on the timeline. */
  due?: string | null;
  decisions: BoardDecision[];
  tasks: { id: string; title: string; assignee: { id: string; name: string } | null }[];
  /** Open threads on its latest version's files, for those who may read comments. */
  openComments: number;
}

export interface Board {
  /** The workflows its columns come from, by name. */
  workflows: string[];
  /** Its columns in each grouping. */
  columns: Record<BoardGrouping, BoardColumn[]>;
  cards: BoardCard[];
  /** The project's default arrangement, for those who have not chosen their own; null for none. */
  display?: BoardDisplay | null;
}

const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * The Mondays a board's timeline shows: `weeks` of them, starting two weeks before the week of
 * `day` (YYYY-MM-DD), so what has just happened and what is coming are both in view.
 */
export function timelineWeeks(day: string, weeks = 6): string[] {
  const at = Date.parse(`${day}T00:00:00Z`);
  const monday = at - ((new Date(at).getUTCDay() + 6) % 7) * DAY - 14 * DAY;
  return Array.from({ length: weeks }, (_, i) => isoDay(monday + i * 7 * DAY));
}

/** A timeline moved on (or back) by whole weeks. */
export const shiftWeeks = (day: string, weeks: number) =>
  isoDay(Date.parse(`${day}T00:00:00Z`) + weeks * 7 * DAY);

/** The day a track's bar runs to: its own deadline, else when its open review is due. */
export const trackDeadline = (card: Pick<BoardCard, "dueAt" | "due">) =>
  card.due ?? card.dueAt ?? null;

/**
 * Where a track's bar sits on a timeline of `days` from `start`: from its latest version to its
 * deadline (its own, else the due date of an open review of it), or a week on where none is
 * set. As fractions of the span, cut to it; null when it has no version or falls wholly outside.
 */
export function timelineBar(
  card: Pick<BoardCard, "version" | "dueAt" | "due">,
  start: string,
  days: number,
): { left: number; width: number; from: string; to: string } | null {
  if (!card.version) return null;
  const from = Date.parse(card.version.createdAt.slice(0, 10));
  const deadline = trackDeadline(card);
  const due = deadline ? Date.parse(deadline.slice(0, 10)) : from + 7 * DAY;
  // Its last day included, and never less than a day long.
  const to = Math.max(due, from) + DAY;
  const begin = Date.parse(start);
  const end = begin + days * DAY;
  if (to <= begin || from >= end) return null;
  const span = end - begin;
  const left = (Math.max(from, begin) - begin) / span;
  const right = (Math.min(to, end) - begin) / span;
  return { left, width: right - left, from: isoDay(from), to: isoDay(to - DAY) };
}

/**
 * Where a range of days (an entry, #505) sits on the same timeline: from its first day to the
 * end of its last, cut to the span; null when wholly outside.
 */
export function timelineSpan(
  range: { startsOn: string; endsOn: string | null },
  start: string,
  days: number,
): { left: number; width: number } | null {
  const from = Date.parse(range.startsOn);
  const to =
    Date.parse(range.endsOn && range.endsOn > range.startsOn ? range.endsOn : range.startsOn) + DAY;
  const begin = Date.parse(start);
  const end = begin + days * DAY;
  if (to <= begin || from >= end) return null;
  const span = end - begin;
  const left = (Math.max(from, begin) - begin) / span;
  return { left, width: (Math.min(to, end) - begin) / span - left };
}

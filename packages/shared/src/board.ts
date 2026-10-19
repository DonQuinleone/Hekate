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

/** How a column reads beside its name: not started, under way, or done. */
export type ColumnCategory = "todo" | "in_progress" | "done";

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
 * The columns for a project's workflows: in status grouping, every status a step sets, in the
 * order a run reaches them, those a finish sets counted as done; in stage grouping, every step a
 * track can wait at. Statuses tracks hold that no workflow sets any more (one renamed, or
 * switched off) are added after, so no track is left out.
 */
export function boardColumns(
  workflows: WorkflowDefinition[],
  groupBy: BoardGrouping,
  held: string[] = [],
): BoardColumn[] {
  // Tracks with a version but no status, or at no step, come next: not yet in the workflow.
  const rest = groupBy === "stage" ? NOT_AT_A_STAGE : NO_STATUS;
  const columns: BoardColumn[] = [
    { id: NO_VERSION, name: NO_VERSION, category: "todo" },
    { id: rest, name: rest, category: "todo" },
  ];
  const add = (name: string, category: ColumnCategory) => {
    const key = name.trim();
    if (!key) return;
    const known = columns.find((c) => c.id === key);
    // A status a finish sets reads as done, even where an earlier step sets it too.
    if (known) {
      if (category === "done" && known.id !== NO_VERSION && known.id !== rest)
        known.category = "done";
      return;
    }
    columns.push({ id: key, name: key, category });
  };
  for (const flow of workflows) {
    const byId = new Map(flow.nodes.map((n) => [n.id, n]));
    for (const id of flowShape(flow).order) {
      const node = byId.get(id);
      if (!node) continue;
      if (groupBy === "stage") {
        if (waitingTypes.has(node.type)) add(node.name, "in_progress");
        continue;
      }
      const status = node.config.status?.trim();
      if (status) add(status, node.type === "finish" ? "done" : "in_progress");
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

/**
 * Where a track's bar sits on a timeline of `days` from `start`: from its latest version to the
 * due date of an open review of it, or a week on where none is due. As fractions of the span,
 * cut to it; null when it has no version or falls wholly outside.
 */
export function timelineBar(
  card: Pick<BoardCard, "version" | "dueAt">,
  start: string,
  days: number,
): { left: number; width: number; from: string; to: string } | null {
  if (!card.version) return null;
  const from = Date.parse(card.version.createdAt.slice(0, 10));
  const due = card.dueAt ? Date.parse(card.dueAt.slice(0, 10)) : from + 7 * DAY;
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

import type { Anchor, CarryStatus } from "@hekate/shared";
import type { Loop } from "./loop";
import type { Comment, CommentHistory } from "./queries";

export interface Thread {
  comment: Comment;
  replies: Comment[];
}

/** Where an anchor sits, for ordering: seconds, then bar, then page; whole-file last. */
function position(anchor: Anchor | null): [number, number] {
  if (!anchor) return [1, Number.POSITIVE_INFINITY];
  switch (anchor.kind) {
    case "time":
      return [0, anchor.start];
    case "bar":
      return [0, anchor.from.bar * 1000 + anchor.from.beat];
    case "region":
      return [0, anchor.at ?? (anchor.page ?? 0) * 1000 + anchor.y];
  }
}

/**
 * A file's comments as threads: open ones in the order they occur in the file, whole-file
 * comments after them, resolved threads apart, and threads carried here but hidden on
 * this version apart again. Replies stay in the order they were written.
 */
export function threadsOf(comments: Comment[]): {
  open: Thread[];
  resolved: Thread[];
  hidden: Thread[];
} {
  const threads = new Map<string, Thread>();
  for (const c of comments) if (!c.parentId) threads.set(c.id, { comment: c, replies: [] });
  for (const c of comments) if (c.parentId) threads.get(c.parentId)?.replies.push(c);
  const ordered = [...threads.values()].sort((a, b) => {
    const [ga, pa] = position(a.comment.anchor);
    const [gb, pb] = position(b.comment.anchor);
    return ga - gb || pa - pb || a.comment.createdAt.localeCompare(b.comment.createdAt);
  });
  const shown = ordered.filter((t) => t.comment.carry?.visible !== false);
  return {
    open: shown.filter((t) => !t.comment.resolvedAt),
    resolved: shown.filter((t) => t.comment.resolvedAt),
    hidden: ordered.filter((t) => t.comment.carry?.visible === false),
  };
}

const hopStatus: Record<CarryStatus, string> = {
  open: "",
  fixed: "fixed",
  not_fixed: "not fixed",
  wont_fix: "won't fix",
};

/**
 * The versions a thread has passed through, for one line under it: "V2 → V3, not fixed →
 * V4". Null when it has never left the version it was raised on.
 */
export function historyLabel(history: CommentHistory | null): string | null {
  if (!history || history.hops.length === 0) return null;
  const steps = [
    history.versionNumber === null ? "Raised" : `V${history.versionNumber}`,
    ...history.hops.map((h) =>
      hopStatus[h.status] ? `V${h.versionNumber}, ${hopStatus[h.status]}` : `V${h.versionNumber}`,
    ),
  ];
  return steps.join(" → ");
}

/** A second either side of a passage, so it is heard in context: what before and after loops. */
export const PASSAGE_ROLL = 1;

/** The loop that plays a time anchor with a little run-up and run-out. */
export function passageLoop(anchor: { start: number; end: number }, duration?: number): Loop {
  const end = anchor.end + PASSAGE_ROLL;
  return {
    start: Math.max(0, anchor.start - PASSAGE_ROLL),
    end: duration === undefined ? end : Math.min(duration, end),
  };
}

const relative = new Intl.RelativeTimeFormat("en-GB", { numeric: "auto" });
const steps: [Intl.RelativeTimeFormatUnit, number][] = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 7],
  ["week", 4.35],
  ["month", 12],
  ["year", Number.POSITIVE_INFINITY],
];

/** "just now", "5 minutes ago", "yesterday". */
export function ago(iso: string, now = Date.now()): string {
  let value = (new Date(iso).getTime() - now) / 1000;
  if (Math.abs(value) < 45) return "just now";
  for (const [unit, size] of steps) {
    if (Math.abs(value) < size) return relative.format(Math.round(value), unit);
    value /= size;
  }
  return relative.format(Math.round(value), "year");
}

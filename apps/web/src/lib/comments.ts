import type { Anchor, CarryStatus } from "@hekate/shared";
import { relativeFormat } from "./locale";
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
  /** Open, but set aside until a later stage (#36). */
  deferred: Thread[];
  resolved: Thread[];
  hidden: Thread[];
} {
  const threads = new Map<string, Thread>();
  for (const c of comments) if (!c.parentId) threads.set(c.id, { comment: c, replies: [] });
  for (const c of comments) {
    if (!c.parentId) continue;
    const thread = threads.get(c.parentId);
    // A reply whose thread is not shown to this reader (their review shows them only their
    // own) still shows, on its own.
    if (thread) thread.replies.push(c);
    else threads.set(c.id, { comment: c, replies: [] });
  }
  const ordered = [...threads.values()].sort((a, b) => {
    const [ga, pa] = position(a.comment.anchor);
    const [gb, pb] = position(b.comment.anchor);
    return ga - gb || pa - pb || a.comment.createdAt.localeCompare(b.comment.createdAt);
  });
  const shown = ordered.filter((t) => t.comment.carry?.visible !== false);
  return {
    open: shown.filter((t) => !t.comment.resolvedAt && !t.comment.deferredTo),
    deferred: shown.filter((t) => !t.comment.resolvedAt && t.comment.deferredTo),
    resolved: shown.filter((t) => t.comment.resolvedAt),
    hidden: ordered.filter((t) => t.comment.carry?.visible === false),
  };
}

export type Threads = ReturnType<typeof threadsOf>;

/** Which threads the comments column lists (#15), as the prototype's "Open" menu chooses. */
export type ThreadFilter = "open" | "deferred" | "resolved" | "hidden" | "all";

export const threadFilterNames: Record<ThreadFilter, string> = {
  open: "Open",
  deferred: "Deferred",
  resolved: "Resolved",
  hidden: "Hidden on this version",
  all: "All",
};

/** The threads a filter lists: one kind, or all of them, open ones first. */
export function threadsShown(threads: Threads, filter: ThreadFilter): Thread[] {
  if (filter === "all")
    return [...threads.open, ...threads.deferred, ...threads.resolved, ...threads.hidden];
  return threads[filter];
}

/** The filters worth offering: open and all always, the others once they hold a thread. */
export function threadFilters(threads: Threads): ThreadFilter[] {
  return (["open", "deferred", "resolved", "hidden", "all"] as const).filter(
    (f) => f === "open" || f === "all" || threads[f].length > 0,
  );
}

/**
 * The threads as the column orders and narrows them (#15): where they occur in the file, or
 * the newest first; and only those whose words, or a reply's, hold what is searched for.
 */
export function arrangeThreads(
  threads: readonly Thread[],
  { newest = false, query = "" }: { newest?: boolean; query?: string } = {},
): Thread[] {
  const words = query.trim().toLocaleLowerCase();
  const found = words
    ? threads.filter((t) =>
        [t.comment, ...t.replies].some((c) => c.body.toLocaleLowerCase().includes(words)),
      )
    : [...threads];
  return newest
    ? found.sort((a, b) => b.comment.createdAt.localeCompare(a.comment.createdAt))
    : found;
}

/** Where a thread is listed, for a link to it (#140) to show it whatever was chosen. */
export function filterHolding(threads: Threads, id: string): ThreadFilter | null {
  for (const f of ["open", "deferred", "resolved", "hidden"] as const)
    if (threads[f].some((t) => t.comment.id === id || t.replies.some((r) => r.id === id))) return f;
  return null;
}

const hopStatus: Record<CarryStatus, string> = {
  open: "",
  fixed: "fixed",
  not_fixed: "not fixed",
  wont_fix: "won't fix",
};

/**
 * The versions a thread has passed through, for one line under it: "V2 → V3, not fixed →
 * V4, moved by hand". Null when it has never left the version it was raised on.
 */
export function historyLabel(
  history: CommentHistory | null,
  /** A version's name: "V3", or "Cut 3" in a video project (#16). */
  version: (n: number) => string = (n) => `V${n}`,
): string | null {
  if (!history || history.hops.length === 0) return null;
  const steps = [
    history.versionNumber === null ? "Raised" : version(history.versionNumber),
    ...history.hops.map((h) =>
      [version(h.versionNumber), hopStatus[h.status], h.moved ? "moved by hand" : ""]
        .filter(Boolean)
        .join(", "),
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

const relative = relativeFormat({ numeric: "auto" });
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

/**
 * The colours a comment's category can be drawn in (#496): the bar at a thread's left edge,
 * in Tailwind's name for each `--hk-category-n` token. Six, then round again.
 */
export const categoryTones = [
  "bg-category-1",
  "bg-category-2",
  "bg-category-3",
  "bg-category-4",
  "bg-category-5",
  "bg-category-6",
] as const;
export type CategoryTone = (typeof categoryTones)[number];

/**
 * A category's tone, by its place among the project's categories as the project orders
 * them, so each category keeps its colour wherever its threads are shown; null for a
 * category the project no longer has.
 */
export function categoryTone(
  categories: readonly { id: string }[],
  categoryId: string,
): CategoryTone | null {
  const at = categories.findIndex((c) => c.id === categoryId);
  return at < 0 ? null : (categoryTones[at % categoryTones.length] ?? null);
}

/** The list in runs of at most `size`, in order: what one request carries at a time. */
export function batchesOf<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < list.length; at += size) out.push(list.slice(at, at + size));
  return out;
}

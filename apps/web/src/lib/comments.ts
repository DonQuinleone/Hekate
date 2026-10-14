import type { Anchor } from "@hekate/shared";
import type { Comment } from "./queries";

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
 * comments after them, resolved threads apart. Replies stay in the order they were written.
 */
export function threadsOf(comments: Comment[]): { open: Thread[]; resolved: Thread[] } {
  const threads = new Map<string, Thread>();
  for (const c of comments) if (!c.parentId) threads.set(c.id, { comment: c, replies: [] });
  for (const c of comments) if (c.parentId) threads.get(c.parentId)?.replies.push(c);
  const ordered = [...threads.values()].sort((a, b) => {
    const [ga, pa] = position(a.comment.anchor);
    const [gb, pb] = position(b.comment.anchor);
    return ga - gb || pa - pb || a.comment.createdAt.localeCompare(b.comment.createdAt);
  });
  return {
    open: ordered.filter((t) => !t.comment.resolvedAt),
    resolved: ordered.filter((t) => t.comment.resolvedAt),
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

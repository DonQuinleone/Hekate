import type { ScoreRehomed } from "./queries";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What swapping a track's score did (#52), in a line: what followed its bars into the new
 * score, and what stayed where it was. Nothing when nothing was placed on the old one.
 */
export function swappedSummary({ marks, takes, stayed }: ScoreRehomed): string | null {
  const moved = [
    marks > 0 ? count(marks, "mark", "marks") : null,
    takes > 0 ? count(takes, "take", "takes") : null,
  ].filter(Boolean);
  // A mark names no bar, or a score prints none: either way there was no bar to find it by.
  const kept =
    stayed === 1
      ? "1 mark stayed where it was, with no bar to find it by."
      : stayed > 1
        ? `${stayed} marks stayed where they were, with no bar to find them by.`
        : null;
  if (moved.length === 0) return kept;
  const line = `Moved to their bars in the new score: ${moved.join(" and ")}.`;
  return kept ? `${line} ${kept}` : line;
}

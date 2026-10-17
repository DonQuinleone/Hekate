import type { QaFinding } from "./qa.ts";

/**
 * What changed in the quality checks between two versions (#137): the problems the earlier
 * one had that the later one no longer has (fixed), and those only the later one has (new).
 * Passes and notes are not problems, so they are neither.
 */

/** Two problems at the same place are the same problem, give or take this much, in seconds. */
export const SAME_PLACE_SECONDS = 1;

const isProblem = (f: QaFinding) => f.severity === "warn" || f.severity === "fail";

/** A project's own rule is told apart by its name; every other check by itself. */
const kindOf = (f: QaFinding) =>
  f.check === "custom" ? `custom:${String(f.details.name ?? "")}` : f.check;

/**
 * Whether two problems are the same one: the same check, on the same channel, and either both
 * about the whole file or at the same place once the earlier one's time is mapped across.
 */
function same(earlier: QaFinding, later: QaFinding, map: (t: number) => number) {
  if (kindOf(earlier) !== kindOf(later) || earlier.channel !== later.channel) return false;
  if (earlier.start === null || later.start === null) return earlier.start === later.start;
  const start = map(earlier.start);
  const end = map(earlier.end ?? earlier.start);
  const laterEnd = later.end ?? later.start;
  // Overlapping, or near enough to be the same click or the same dropout.
  return start <= laterEnd + SAME_PLACE_SECONDS && later.start <= end + SAME_PLACE_SECONDS;
}

/**
 * The fixed and new problems between an earlier version's findings and a later one's. `map`
 * takes a time in the earlier version to the same music in the later one; without an
 * alignment, the same time.
 */
export function findingChanges(
  earlier: readonly QaFinding[],
  later: readonly QaFinding[],
  map: (t: number) => number = (t) => t,
): { fixed: QaFinding[]; new: QaFinding[] } {
  const before = earlier.filter(isProblem);
  const after = later.filter(isProblem);
  return {
    fixed: before.filter((e) => !after.some((l) => same(e, l, map))),
    new: after.filter((l) => !before.some((e) => same(e, l, map))),
  };
}

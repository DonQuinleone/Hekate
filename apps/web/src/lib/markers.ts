/**
 * Moving between markers from the keyboard (#34): the comment markers above the timeline and
 * the quality checks' findings under it, as one list of moments the playhead jumps between,
 * as Shift+↑ and Shift+↓ do in DaVinci Resolve (decision 236).
 */

/** A playhead this close to a marker is on it, so the next press moves on past it. */
export const ON_MARKER = 0.05;

/** Every moment marked, earliest first and each once; nothing before the start or unknown. */
export function markerTimes(...lists: readonly (readonly number[])[]): number[] {
  const times = new Set<number>();
  for (const list of lists)
    for (const at of list) if (Number.isFinite(at) && at >= 0) times.add(at);
  return [...times].sort((a, b) => a - b);
}

/**
 * The marker after the playhead (1) or before it (−1), or null where there is none. The one
 * the playhead is on is passed over, so pressing again keeps moving.
 */
export function adjacentMarker(
  times: readonly number[],
  at: number,
  direction: 1 | -1,
): number | null {
  if (direction === 1) return times.find((t) => t > at + ON_MARKER) ?? null;
  return times.findLast((t) => t < at - ON_MARKER) ?? null;
}

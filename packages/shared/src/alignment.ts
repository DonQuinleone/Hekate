import { z } from "zod";

/**
 * Where the same music sits in two versions of a track: pairs of times, in seconds, one in
 * each, rising together. Between pairs, time runs linearly; beyond the ends, at the same
 * rate as the music around them. Computed from the audio by the media worker (#33).
 */
export const alignmentPoints = z
  .array(z.tuple([z.number().finite().nonnegative(), z.number().finite().nonnegative()]))
  .max(20_000);
export type AlignmentPoints = z.infer<typeof alignmentPoints>;

/** Below this match quality, an alignment is kept for the record but not followed. */
export const ALIGNMENT_MIN_QUALITY = 0.5;
export const usableAlignment = (quality: number | null | undefined) =>
  typeof quality === "number" && quality >= ALIGNMENT_MIN_QUALITY;

/** The time in the other version for a time in this one. */
export function mapTime(points: AlignmentPoints, at: number): number {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return at;
  if (points.length === 1 || at <= first[0]) return Math.max(0, first[1] + (at - first[0]));
  if (at >= last[0]) return last[1] + (at - last[0]);
  // The pair just before, by binary search.
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((points[mid] as [number, number])[0] <= at) lo = mid;
    else hi = mid;
  }
  const [a0, b0] = points[lo] as [number, number];
  const [a1, b1] = points[hi] as [number, number];
  return a1 === a0 ? b0 : b0 + ((at - a0) / (a1 - a0)) * (b1 - b0);
}

/** The same alignment, read from the other version. */
export const invertAlignment = (points: AlignmentPoints): AlignmentPoints =>
  points.map(([a, b]) => [b, a]);

/**
 * Keep only the pairs that change the line: a run of pairs on one straight line becomes its
 * two ends. `tolerance` is how far, in seconds, a dropped pair may sit from the line.
 */
export function simplifyAlignment(points: AlignmentPoints, tolerance = 0.02): AlignmentPoints {
  if (points.length <= 2) return points;
  const kept: AlignmentPoints = [points[0] as [number, number]];
  let anchor = 0;
  for (let i = 2; i < points.length; i++) {
    const [a0, b0] = points[anchor] as [number, number];
    const [a1, b1] = points[i] as [number, number];
    // Every pair since the anchor must lie near the line from the anchor to this one.
    let straight = true;
    for (let k = anchor + 1; k < i && straight; k++) {
      const [a, b] = points[k] as [number, number];
      const expected = a1 === a0 ? b0 : b0 + ((a - a0) / (a1 - a0)) * (b1 - b0);
      if (Math.abs(expected - b) > tolerance) straight = false;
    }
    if (!straight) {
      anchor = i - 1;
      kept.push(points[anchor] as [number, number]);
    }
  }
  kept.push(points.at(-1) as [number, number]);
  return kept;
}

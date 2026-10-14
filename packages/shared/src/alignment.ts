import { z } from "zod";
import type { Anchor } from "./anchor.ts";

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
 * two ends. `tolerance` is how far, in seconds, a dropped pair may sit from the line. One
 * pass, in linear time: from the last kept pair, the slopes that still pass within the
 * tolerance of every pair since narrow to a cone; a pair outside it starts a new segment.
 */
export function simplifyAlignment(points: AlignmentPoints, tolerance = 0.02): AlignmentPoints {
  if (points.length <= 2) return points;
  const kept: AlignmentPoints = [points[0] as [number, number]];
  let [a0, b0] = points[0] as [number, number];
  let low = Number.NEGATIVE_INFINITY;
  let high = Number.POSITIVE_INFINITY;
  for (let i = 1; i < points.length; i++) {
    const [a, b] = points[i] as [number, number];
    const da = a - a0;
    if (da <= 0) continue;
    const slope = (b - b0) / da;
    if (slope < low || slope > high) {
      // This pair is off every line the run allows: the run ends at the pair before.
      const [pa, pb] = points[i - 1] as [number, number];
      kept.push([pa, pb]);
      [a0, b0] = [pa, pb];
      low = Number.NEGATIVE_INFINITY;
      high = Number.POSITIVE_INFINITY;
      const span = a - a0;
      if (span > 0) {
        low = (b - tolerance - b0) / span;
        high = (b + tolerance - b0) / span;
      }
      continue;
    }
    low = Math.max(low, (b - tolerance - b0) / da);
    high = Math.min(high, (b + tolerance - b0) / da);
  }
  const last = points.at(-1) as [number, number];
  if (kept.at(-1) !== last) kept.push(last);
  return kept;
}

/**
 * One alignment followed by another: from A to B, then B to C, as one from A to C. The
 * result bends wherever either did.
 */
export function composeAlignments(ab: AlignmentPoints, bc: AlignmentPoints): AlignmentPoints {
  const ba = invertAlignment(ab);
  const times = [...ab.map(([a]) => a), ...bc.map(([b]) => mapTime(ba, b))]
    .filter((t) => t >= 0)
    .sort((x, y) => x - y);
  const points: AlignmentPoints = [];
  for (const t of times) {
    if (points.length > 0 && t - (points.at(-1) as [number, number])[0] < 1e-6) continue;
    points.push([t, mapTime(bc, mapTime(ab, t))]);
  }
  return simplifyAlignment(points, 0.02);
}

const ms = (t: number) => Math.round(t * 1000) / 1000;

/**
 * An anchor moved to where the same music is in the other version: a time range, or the
 * moment a bar comment was named at. Null for anchors with no time in a recording, which
 * stay where they are.
 */
export function remapAnchor(points: AlignmentPoints, anchor: Anchor | null): Anchor | null {
  if (anchor?.kind === "time") {
    const start = ms(mapTime(points, anchor.start));
    const end = Math.max(start, ms(mapTime(points, anchor.end)));
    return { kind: "time", start, end };
  }
  if (anchor?.kind === "bar" && anchor.at !== undefined) {
    return { ...anchor, at: ms(mapTime(points, anchor.at)) };
  }
  return null;
}

import { z } from "zod";

/**
 * Bar maps (#13): where each bar of the score begins in a recording. A map is the list
 * of barlines in the order they are heard, each a time in seconds and a bar number, so a
 * repeat simply plays some bars again. Times between two barlines fall in the first
 * bar, its beats spread evenly. Vocabulary: docs/domain.md.
 */

/** Bars in a map: enough for any recording, small enough to send whole. */
export const MAX_BARS = 20_000;

const barMapShape = z.object({
  /** Beats in a bar, as the time signature's top number: 2 for 2/4, 6 for 6/8. */
  beatsPerBar: z.number().int().min(1).max(32),
  /** Barlines in the order they are heard: seconds, then the bar that starts there. */
  points: z
    .array(z.tuple([z.number().finite().nonnegative(), z.number().int().min(0).max(100_000)]))
    .min(1)
    .max(MAX_BARS),
});
const inTime = (m: { points: [number, number][] }) =>
  m.points.every((p, i) => i === 0 || p[0] > (m.points[i - 1]?.[0] ?? 0));
const inTimeMessage = { message: "barlines must come one after another in time", path: ["points"] };

export const barMapInput = barMapShape.refine(inTime, inTimeMessage);
export type BarMap = z.infer<typeof barMapInput>;

/** How a map was made: tapped along to the recording, imported from labels, or carried. */
export const barMapSources = ["tapped", "imported", "carried"] as const;
export type BarMapSource = (typeof barMapSources)[number];

/** `PUT /api/files/:id/bars`: a map tapped or imported by hand (carrying is the server's). */
export const saveBarMapInput = barMapShape
  .extend({ source: z.enum(["tapped", "imported"]) })
  .refine(inTime, inTimeMessage);
export type SaveBarMapInput = z.infer<typeof saveBarMapInput>;

/** Where a moment falls: the bar, and the beat within it from 1 (fractional between beats). */
export interface BarPosition {
  bar: number;
  beat: number;
  /** Which barline of the map this is, counting repeats. */
  index: number;
}

/** The index of the last barline at or before `t`, or -1 before the first. */
function barlineAt(points: BarMap["points"], t: number): number {
  let lo = 0;
  let hi = points.length - 1;
  if (hi < 0 || t < (points[0]?.[0] ?? 0)) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((points[mid]?.[0] ?? 0) <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** How long bar `i` lasts: to the next barline, or as long as the bar before for the last. */
function barLength(points: BarMap["points"], i: number): number {
  const here = points[i]?.[0] ?? 0;
  const next = points[i + 1]?.[0];
  if (next !== undefined) return next - here;
  const before = points[i - 1]?.[0];
  return before !== undefined ? here - before : 2;
}

/** The bar and beat at a moment of the recording; null before the first barline. */
export function barAt(map: BarMap, t: number): BarPosition | null {
  const i = barlineAt(map.points, t);
  if (i < 0) return null;
  const [start, bar] = map.points[i] ?? [0, 0];
  const length = barLength(map.points, i);
  const share = length > 0 ? Math.min(0.999_999, (t - start) / length) : 0;
  return { bar, beat: 1 + share * map.beatsPerBar, index: i };
}

/** When a bar (and beat) is first heard; null if the map never reaches it. */
export function timeOfBar(map: BarMap, bar: number, beat = 1): number | null {
  const i = map.points.findIndex((p) => p[1] === bar);
  if (i < 0) return null;
  const [start] = map.points[i] ?? [0];
  return start + ((beat - 1) / map.beatsPerBar) * barLength(map.points, i);
}

/** "Bar 12", or "Bar 12.2" on a later beat, as the player shows it. */
export function barLabel(position: { bar: number; beat: number }): string {
  const beat = Math.floor(position.beat);
  return beat > 1 ? `Bar ${position.bar}.${beat}` : `Bar ${position.bar}`;
}

/**
 * The order bars are heard in, written as a musician would: "1-16, 1-16, 17-32" plays
 * the first strain twice. A range without an end ("33-") runs on for as long as there are
 * barlines. Returns null when the text is not such a list.
 */
export function parseForm(text: string): { from: number; to: number | null }[] | null {
  const parts = text
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const ranges: { from: number; to: number | null }[] = [];
  for (const part of parts) {
    const match = /^(\d+)\s*(?:[-–]\s*(\d*))?$/.exec(part);
    if (!match) return null;
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : match[2] === "" ? null : Number(match[2]);
    if (to !== null && to < from) return null;
    ranges.push({ from, to });
  }
  return ranges;
}

/** The bar numbers of `count` barlines in turn, following a form; past its end, on by one. */
export function formBars(form: { from: number; to: number | null }[], count: number): number[] {
  const bars: number[] = [];
  for (const range of form) {
    for (let bar = range.from; range.to === null || bar <= range.to; bar++) {
      if (bars.length >= count) return bars;
      bars.push(bar);
    }
  }
  let next = (bars.at(-1) ?? 0) + 1;
  while (bars.length < count) bars.push(next++);
  return bars;
}

/**
 * Barlines from a label file, as Audacity and Sonic Visualiser export them: a time (or a
 * start and an end), then a label whose number is the bar. Commas or tabs separate them.
 * Lines without a bar number are skipped; returns null when nothing usable is found.
 */
export function parseBarLabels(text: string): BarMap["points"] | null {
  const points: BarMap["points"] = [];
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split(/[\t,]/).map((c) => c.trim());
    const time = Number(cells[0]);
    // Audacity writes start, end and label; Sonic Visualiser, a time and a label.
    const label = cells.length >= 3 ? cells[2] : cells[1];
    const bar = Number(/\d+/.exec(label ?? "")?.[0]);
    if (!Number.isFinite(time) || time < 0 || !Number.isInteger(bar)) continue;
    points.push([time, bar]);
  }
  points.sort((a, b) => a[0] - b[0]);
  // Two labels at the same moment: the later one stands.
  const unique = points.filter((p, i) => p[0] !== points[i + 1]?.[0]);
  return unique.length > 0 ? unique : null;
}

/**
 * Which barlines to number on a ruler `width` pixels wide over `duration` seconds, so
 * that numbers stay at least `gap` pixels apart: every bar, or every 2nd, 4th, 8th...
 */
export function rulerBars(map: BarMap, duration: number, width: number, gap = 28): number[] {
  if (duration <= 0 || width <= 0 || map.points.length === 0) return [];
  const typical = duration / Math.max(1, map.points.length);
  const pixels = (typical / duration) * width;
  let every = 1;
  while (pixels * every < gap && every < 1024) every *= 2;
  return map.points.flatMap(([, bar], i) => (bar % every === 0 || i === 0 ? [i] : []));
}

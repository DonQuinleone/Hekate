import { z } from "zod";

/**
 * Takes (#21, #46): recording-session snippets made for a track, never versions of it. Each is
 * one scratch mix for now; its rating, star and notes are the producer's, and its page, bars and
 * in and out points are optional, since bars matter for a classical piece and not a pop song.
 */

export const TAKE_RATING_MAX = 5;

const bar = z.number().int().min(0).max(100_000);
const seconds = z
  .number()
  .min(0)
  .max(24 * 60 * 60);

/** Files already in the project, each made a take of the track, numbered in the order given. */
export const addTakesInput = z.object({ fileIds: z.array(z.uuid()).min(1).max(100) });

/** What changes on a take; anything left out stays as it is. */
export const takeChangeInput = z.object({
  label: z.string().trim().max(120).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
  rating: z.number().int().min(0).max(TAKE_RATING_MAX).optional(),
  starred: z.boolean().optional(),
  page: z.number().int().min(1).max(10_000).nullable().optional(),
  barFrom: bar.nullable().optional(),
  barTo: bar.nullable().optional(),
  inPoint: seconds.nullable().optional(),
  outPoint: seconds.nullable().optional(),
});
export type TakeChange = z.infer<typeof takeChangeInput>;

/** A take's place, as it would be once a change is made. */
export interface TakePlace {
  barFrom: number | null;
  barTo: number | null;
  inPoint: number | null;
  outPoint: number | null;
}

/** Why a take's bars or in and out points cannot be, or null when they can. */
export function takeProblem(t: TakePlace): string | null {
  if (t.barFrom !== null && t.barTo !== null && t.barFrom > t.barTo)
    return "The last bar comes before the first";
  if (t.barFrom === null && t.barTo !== null) return "Give the first bar too";
  if (t.inPoint !== null && t.outPoint !== null && t.inPoint >= t.outPoint)
    return "The out point comes before the in point";
  return null;
}

/** A take as the take manager shows it. */
export interface TakeRow extends TakePlace {
  id: string;
  number: number;
  label: string | null;
  notes: string | null;
  rating: number;
  starred: boolean;
  page: number | null;
  /** Its scratch mix; null once the file is gone. */
  file: { id: string; name: string; duration: number | null; streamStatus: string } | null;
  createdAt: string;
}

/** The bars a take covers: its range, or the one bar when only the first is given. */
export const barsOf = (t: Pick<TakePlace, "barFrom" | "barTo">): [number, number] | null =>
  t.barFrom === null ? null : [t.barFrom, t.barTo ?? t.barFrom];

/** Whether a take covers a bar. */
export function covers(t: Pick<TakePlace, "barFrom" | "barTo">, bar: number): boolean {
  const range = barsOf(t);
  return range !== null && range[0] <= bar && bar <= range[1];
}

/** Every take covering a bar: starred first, then by rating, then in order. */
export function takesCovering<
  T extends Pick<TakeRow, "barFrom" | "barTo" | "starred" | "rating" | "number">,
>(all: T[], bar: number): T[] {
  return all
    .filter((t) => covers(t, bar))
    .sort(
      (a, b) => Number(b.starred) - Number(a.starred) || b.rating - a.rating || a.number - b.number,
    );
}

/**
 * The bars no take covers, as ranges, from bar 1 to the last bar any take reaches. An upbeat
 * (bar 0) counts only when a take covers it.
 */
export function coverageGaps(all: Pick<TakePlace, "barFrom" | "barTo">[]): [number, number][] {
  const ranges = all.flatMap((t) => {
    const r = barsOf(t);
    return r ? [r] : [];
  });
  if (ranges.length === 0) return [];
  const last = Math.max(...ranges.map((r) => r[1]));
  const gaps: [number, number][] = [];
  let start: number | null = null;
  for (let bar = 1; bar <= last; bar++) {
    const covered = ranges.some(([a, b]) => a <= bar && bar <= b);
    if (!covered && start === null) start = bar;
    if (covered && start !== null) {
      gaps.push([start, bar - 1]);
      start = null;
    }
  }
  if (start !== null) gaps.push([start, last]);
  return gaps;
}

/** "bars 64 to 88", "bar 12", or null for a take without bars. */
export function barsLabel(t: Pick<TakePlace, "barFrom" | "barTo">): string | null {
  const r = barsOf(t);
  if (!r) return null;
  return r[0] === r[1] ? `bar ${r[0]}` : `bars ${r[0]} to ${r[1]}`;
}

/** A point in a take as typed: seconds ("92.5") or a clock ("1:32.5", "1:02:03"); null if neither. */
export function parseClock(input: string): number | null {
  const parts = input.trim().split(":");
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  const numbers = parts.map(Number);
  if (numbers.slice(1).some((n) => n >= 60)) return null;
  if (numbers.slice(0, -1).some((n) => !Number.isInteger(n))) return null;
  return numbers.reduce((total, n) => total * 60 + n, 0);
}

/** A point as a clock to the tenth of a second: "1:32.5", or "1:32" on the second. */
export function clockOf(seconds: number): string {
  const tenths = Math.round(seconds * 10);
  const whole = Math.floor(tenths / 10);
  const h = Math.floor(whole / 3600);
  const m = Math.floor(whole / 60) % 60;
  const s = String(whole % 60).padStart(2, "0");
  const fraction = tenths % 10 ? `.${tenths % 10}` : "";
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}${fraction}` : `${m}:${s}${fraction}`;
}

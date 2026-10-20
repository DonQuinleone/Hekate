import { z } from "zod";

/**
 * The schedule (#50, docs/domain.md): a project's days, each at a venue, and the rows of each
 * day in order: repertoire slots, breaks, get-ins, venue changes and anything else. A row's
 * start chains from the end of the row before unless it is set; its length is in minutes. Rows
 * are ticked off during the session.
 */
export const scheduleRowKinds = ["slot", "break", "get-in", "venue", "custom"] as const;
export type ScheduleRowKind = (typeof scheduleRowKinds)[number];

const text = (max: number) => z.string().trim().max(max);
/** A time of day, 24-hour: "09:30". */
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "A time such as 09:30");

export const scheduleDayInput = z.object({
  label: text(60).min(1, "Name the day"),
  /** A calendar date: "2026-09-12". */
  date: z.iso.date().nullable().default(null),
  venueId: z.uuid().nullable().default(null),
  /** When the first row starts, unless it sets its own. */
  start: clock.default("10:00"),
});
export type ScheduleDayInput = z.input<typeof scheduleDayInput>;

export const scheduleRowInput = z
  .object({
    kind: z.enum(scheduleRowKinds),
    /** Set to fix the row's start; null chains it from the row before. */
    start: clock.nullable().default(null),
    minutes: z
      .number()
      .int()
      .min(0)
      .max(24 * 60),
    /** A break's, get-in's or other row's words: "Lunch", "Move to Studio 2". */
    label: text(120).default(""),
    /** For a slot: its works and tracks, any mix, or the whole repertoire. */
    allRepertoire: z.boolean().default(false),
    workIds: z.array(z.uuid()).max(100).default([]),
    trackIds: z.array(z.uuid()).max(200).default([]),
    personnel: text(200).default(""),
    notes: text(1000).default(""),
  })
  .refine(
    (r) =>
      r.kind === "slot" || (!r.allRepertoire && r.workIds.length === 0 && r.trackIds.length === 0),
    { message: "Only a slot holds repertoire", path: ["workIds"] },
  );
export type ScheduleRowInput = z.input<typeof scheduleRowInput>;

/** Ticking a row off, or back on. */
export const scheduleDoneInput = z.object({ done: z.boolean() });

/** Moving a row one place up or down its day. */
export const scheduleMoveInput = z.object({ direction: z.enum(["up", "down"]) });

export interface ScheduleRow {
  id: string;
  kind: ScheduleRowKind;
  start: string | null;
  minutes: number;
  label: string;
  allRepertoire: boolean;
  workIds: string[];
  trackIds: string[];
  personnel: string;
  notes: string;
  done: boolean;
}

export interface ScheduleDay {
  id: string;
  label: string;
  date: string | null;
  venueId: string | null;
  start: string;
  rows: ScheduleRow[];
}

/** Minutes past midnight of "HH:MM". */
export function minutesOf(time: string): number {
  const [h = 0, m = 0] = time.split(":").map(Number);
  return h * 60 + m;
}

/** "HH:MM" of minutes past midnight, past midnight again when a day runs over. */
export function timeOfDay(minutes: number): string {
  const day = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(day / 60)).padStart(2, "0")}:${String(day % 60).padStart(2, "0")}`;
}

/**
 * Each row's start and end on its day: a row with its own start begins then; any other begins
 * where the row before ends, and the first at the day's start.
 */
export function timesOf(
  day: Pick<ScheduleDay, "start" | "rows">,
): { start: string; end: string; fixed: boolean }[] {
  let at = minutesOf(day.start);
  return day.rows.map((r) => {
    const start = r.start === null ? at : minutesOf(r.start);
    at = start + r.minutes;
    return { start: timeOfDay(start), end: timeOfDay(at), fixed: r.start !== null };
  });
}

/** The tracks a slot covers: its tracks, its works' tracks, or all of them. */
export function slotTracks(
  row: Pick<ScheduleRow, "kind" | "allRepertoire" | "workIds" | "trackIds">,
  works: { id: string; trackIds: string[] }[],
  allTracks: string[],
): string[] {
  if (row.kind !== "slot") return [];
  if (row.allRepertoire) return allTracks;
  return [
    ...new Set([
      ...row.trackIds,
      ...works.filter((w) => row.workIds.includes(w.id)).flatMap((w) => w.trackIds),
    ]),
  ];
}

/**
 * Coverage: for every track, the slots it has across the days and their minutes, so a track
 * with none stands out.
 */
export function coverage(
  days: ScheduleDay[],
  works: { id: string; trackIds: string[] }[],
  allTracks: string[],
): Map<string, { day: string; start: string; minutes: number }[]> {
  const slots = new Map<string, { day: string; start: string; minutes: number }[]>(
    allTracks.map((t) => [t, []]),
  );
  for (const day of days) {
    const times = timesOf(day);
    day.rows.forEach((row, i) => {
      for (const track of slotTracks(row, works, allTracks))
        slots
          .get(track)
          ?.push({ day: day.label, start: times[i]?.start ?? "", minutes: row.minutes });
    });
  }
  return slots;
}

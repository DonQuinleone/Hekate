import { type ScheduleDay, slotTracks, timesOf } from "@hekate/shared";

/** One track's time in the schedule: its own slots, and those it shares with other tracks. */
export interface TrackCoverage {
  /** Minutes in slots for this track alone. */
  own: number;
  /** Minutes in slots it shares with other tracks (an "All repertoire" slot, a whole work). */
  shared: number;
  /** Its slots' start times, day by day, each day named once. */
  days: { day: string; starts: string[] }[];
}

/**
 * Coverage that adds up (#651): a slot for several tracks is counted once, as shared time, not
 * in full against each, so every track's own minutes and the shared minutes together are the
 * minutes booked for the repertoire.
 */
export function coverageTotals(
  days: ScheduleDay[],
  works: { id: string; trackIds: string[] }[],
  allTracks: string[],
): { tracks: Map<string, TrackCoverage>; shared: number; booked: number } {
  const tracks = new Map<string, TrackCoverage>(
    allTracks.map((t) => [t, { own: 0, shared: 0, days: [] }]),
  );
  let shared = 0;
  let booked = 0;
  for (const day of days) {
    const times = timesOf(day);
    day.rows.forEach((row, i) => {
      const covered = slotTracks(row, works, allTracks).filter((t) => tracks.has(t));
      if (covered.length === 0) return;
      booked += row.minutes;
      if (covered.length > 1) shared += row.minutes;
      for (const id of covered) {
        const t = tracks.get(id);
        if (!t) continue;
        if (covered.length > 1) t.shared += row.minutes;
        else t.own += row.minutes;
        const start = times[i]?.start ?? "";
        const last = t.days.at(-1);
        if (last?.day === day.label) last.starts.push(start);
        else t.days.push({ day: day.label, starts: [start] });
      }
    });
  }
  return { tracks, shared, booked };
}

/** "Day 1: 11:50, 14:00 · Day 2: 10:30", each day named once; null without slots. */
export const slotDays = (days: TrackCoverage["days"]) =>
  days.length === 0
    ? null
    : days.map((d) => `${d.day}: ${d.starts.filter(Boolean).join(", ")}`).join(" · ");

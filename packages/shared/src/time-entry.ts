import { parseTimecode, type VideoClock } from "./video-time.ts";

/**
 * What a typed time is read against (#493): how long the file runs, a video's clock where it
 * has one, and a way from a bar to a moment where the project has a tempo map.
 */
export interface TimeEntryContext {
  /** How long the file runs, in seconds; a moment past it is refused. Zero while unknown. */
  duration: number;
  /** A video's clock: four fields (or eight digits) read as a timecode on it. */
  clock?: VideoClock | null;
  /**
   * The moment a bar and beat start, in seconds, or null where the bar is not in the map.
   * Given, "25" and "25.3" read as bars; seconds then take a unit ("25 s").
   */
  barTime?: ((bar: number, beat: number) => number | null) | null;
}

/** "mm:ss", "h:mm:ss", each with an optional ".mmm". */
const clockPattern = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})(?:[.,](\d{1,3}))?$/;
/** A bar, with an optional beat: "25", "25.3", "bar 25", "b25.3". */
const barPattern = /^(?:bars?\s*|b)?(\d{1,4})(?:\.(\d{1,2}))?$/i;
/** Plain seconds, with or without a unit: "90", "12.5", "12.5 s", "12.5s". */
const secondsPattern = /^(\d{1,6}(?:[.,]\d{1,3})?)\s*(?:s|sec|seconds?)?$/i;

const within = (seconds: number, duration: number) =>
  seconds >= 0 && (!(duration > 0) || seconds <= duration + 1e-6) ? seconds : null;

/**
 * The moment a typed time means (#493), in seconds from the file's start, or null where the
 * text is not a time in this file. Read as people type into a transport: seconds ("90",
 * "12.5"), minutes and seconds ("1:30", "1:30.250"), hours too ("1:02:03"), a timecode on a
 * video's own clock ("10:00:05:12", as `parseTimecode` reads it), and, where a tempo map is
 * given, a bar and beat ("25", "25.3", "bar 25"); seconds then need a unit ("25 s").
 */
export function parseTimeEntry(text: string, context: TimeEntryContext): number | null {
  const typed = text.trim().toLowerCase();
  if (!typed) return null;
  const { duration, clock = null, barTime = null } = context;
  // A video's timecode: four fields, or all eight digits, on its own clock.
  if (clock && (/^\d{2}[:;]\d{2}[:;]\d{2}[:;]\d{2}$/.test(typed) || /^\d{8}$/.test(typed))) {
    const frame = parseTimecode(typed, clock);
    return frame === null ? null : within((frame * clock.rate.den) / clock.rate.num, duration);
  }
  const clockMatch = clockPattern.exec(typed);
  if (clockMatch) {
    const [, hours = "0", minutes = "0", seconds = "0", millis = "0"] = clockMatch;
    if (Number(seconds) > 59 || (hours !== "0" && Number(minutes) > 59)) return null;
    const total =
      Number(hours) * 3600 +
      Number(minutes) * 60 +
      Number(seconds) +
      Number(millis.padEnd(3, "0")) / 1000;
    return within(total, duration);
  }
  if (barTime) {
    const bar = barPattern.exec(typed);
    if (bar) {
      const [, number = "0", beat = "1"] = bar;
      if (Number(number) < 1 || Number(beat) < 1) return null;
      const at = barTime(Number(number), Number(beat));
      return at === null ? null : within(at, duration);
    }
  }
  const seconds = secondsPattern.exec(typed);
  if (seconds?.[1]) return within(Number(seconds[1].replace(",", ".")), duration);
  return null;
}

/** What the field accepts here, for its hint. */
export function timeEntryHint(context: Pick<TimeEntryContext, "clock" | "barTime">): string {
  if (context.clock) return "A timecode, or a time from the start such as 1:30.";
  if (context.barTime) return "A bar such as 25 or 25.3, or a time such as 1:30 or 90 s.";
  return "A time such as 1:30, 1:30.250 or 90.";
}

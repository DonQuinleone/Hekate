import { z } from "zod";

/**
 * A project's calendar (#141, #505): what is due and what is booked, by day, and the same as an
 * ICS feed for whichever calendar someone keeps (RFC 5545). Deadlines come from reviews, tracks
 * and tasks; entries are the dated things that are none of those (decision 283).
 */

export const calendarKinds = ["review", "task", "track", "session", "schedule", "entry"] as const;
export type CalendarKind = (typeof calendarKinds)[number];

/** What an entry is for: a session books a recording session under Production as it is made. */
export const calendarEntryKinds = ["session", "delivery", "meeting", "other"] as const;
export type CalendarEntryKind = (typeof calendarEntryKinds)[number];

export const calendarEntryKindLabels: Record<CalendarEntryKind, string> = {
  session: "Session",
  delivery: "Delivery",
  meeting: "Meeting",
  other: "Other",
};

const day = z.iso.date();

/**
 * A new entry: a title, a day or a range of days (both included), what it is about and who
 * is expected. Whole days only; a time may follow (the columns are instants already).
 */
export const calendarEntryInput = z
  .object({
    kind: z.enum(calendarEntryKinds),
    title: z.string().trim().min(1, "An entry needs a title").max(200),
    startsOn: day,
    endsOn: day.nullable().optional(),
    trackId: z.uuid().nullable().optional(),
    reviewId: z.uuid().nullable().optional(),
    /** Members expected, by user id. */
    attendees: z.array(z.string().min(1).max(64)).max(50).optional(),
  })
  .refine((e) => !e.endsOn || e.endsOn >= e.startsOn, {
    message: "An entry ends on or after the day it starts",
    path: ["endsOn"],
  });
export type CalendarEntryInput = z.infer<typeof calendarEntryInput>;

/** Changing one: any of the same, with a range still the right way round. */
export const calendarEntryChange = z
  .object({
    kind: z.enum(calendarEntryKinds).optional(),
    title: z.string().trim().min(1, "An entry needs a title").max(200).optional(),
    startsOn: day.optional(),
    endsOn: day.nullable().optional(),
    trackId: z.uuid().nullable().optional(),
    reviewId: z.uuid().nullable().optional(),
    attendees: z.array(z.string().min(1).max(64)).max(50).optional(),
  })
  .refine((e) => Object.keys(e).length > 0, { message: "Nothing to change" })
  .refine((e) => !e.endsOn || !e.startsOn || e.endsOn >= e.startsOn, {
    message: "An entry ends on or after the day it starts",
    path: ["endsOn"],
  });
export type CalendarEntryChange = z.infer<typeof calendarEntryChange>;

/** An entry as the calendar lists it and the dialog edits it. */
export interface CalendarEntry {
  id: string;
  projectId: string;
  kind: CalendarEntryKind;
  title: string;
  /** Its first and last days, both included; `endsOn` null for a single day. */
  startsOn: string;
  endsOn: string | null;
  trackId: string | null;
  reviewId: string | null;
  /** The recording session a session entry made, where it still exists. */
  sessionId: string | null;
  attendees: { id: string; name: string }[];
}

/**
 * Something on a day: a review, track or task due, a recording session, a day of the schedule,
 * an entry. An entry over several days carries its last day too.
 */
export interface CalendarEvent {
  /** Its kind and id, unique within a project's calendar. */
  id: string;
  kind: CalendarKind;
  /** The day, as a date: 2026-10-21. */
  date: string;
  /** The last day of a range, both included; absent for a single day. */
  end?: string;
  title: string;
  /** Where it is in Hekate, a path: `/reviews/…`. */
  link: string;
  /** Due before today and not finished. */
  overdue: boolean;
  /** The entry itself, for an event that is one, so it can be edited where it is listed. */
  entry?: CalendarEntry;
}

const DAY = 86_400_000;

/** A day (YYYY-MM-DD) moved by whole days, either way. */
export function shiftDay(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

/** How many days from one day to another: negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
}

/** Every day of a range, both ends included; a single day where `end` is unset or earlier. */
export function daysOf(start: string, end?: string | null): string[] {
  const n = end ? Math.max(0, daysBetween(start, end)) : 0;
  return Array.from({ length: n + 1 }, (_, i) => shiftDay(start, i));
}

/**
 * Whether a deadline has passed: a day (2026-10-21) once today, where the reader is, is later;
 * an instant once now is past it. Nothing is overdue without a deadline.
 */
export function deadlinePassed(
  deadline: string | Date | null | undefined,
  now: Date,
  timeZone?: string | null,
): boolean {
  if (!deadline) return false;
  if (typeof deadline === "string" && /^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
    return deadline < dayIn(now, timeZone);
  }
  const at = deadline instanceof Date ? deadline.getTime() : Date.parse(deadline);
  return Number.isFinite(at) && at < now.getTime();
}

export interface DayRange {
  startsOn: string;
  endsOn: string | null;
}

/** A range moved whole by so many days: as long as it was, either way. */
export function movedRange(range: DayRange, days: number): DayRange {
  return {
    startsOn: shiftDay(range.startsOn, days),
    endsOn: range.endsOn ? shiftDay(range.endsOn, days) : null,
  };
}

/**
 * A range with its end moved by so many days and its start kept: never shorter than a day
 * (an end dragged before the start lands on it), and a single day again where it ends on the
 * day it starts.
 */
export function resizedRange(range: DayRange, days: number): DayRange {
  const last = shiftDay(range.endsOn ?? range.startsOn, days);
  const endsOn = last <= range.startsOn ? null : last;
  return { startsOn: range.startsOn, endsOn };
}

/** An instant moved by whole days, its time of day kept (in UTC; a zone's clock change may shift it an hour). */
export function shiftInstant(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * DAY).toISOString();
}

/**
 * How many whole days a drag across a timeline has covered: the pointer's distance as a share
 * of the span's width, rounded to the nearest day, so a bar snaps to days as it is dragged.
 */
export function daysDragged(dx: number, spanWidth: number, spanDays: number): number {
  if (!(spanWidth > 0) || !(spanDays > 0)) return 0;
  return Math.round((dx / spanWidth) * spanDays);
}

/** A month's first and last days, and the six weeks from the Monday on or before its first. */
export function monthGrid(month: string): { first: string; last: string; days: string[] } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1, 1));
  const last = new Date(Date.UTC(y, m, 0));
  const lead = (first.getUTCDay() + 6) % 7;
  const days = Array.from({ length: 42 }, (_, i) =>
    new Date(Date.UTC(y, m - 1, 1 - lead + i)).toISOString().slice(0, 10),
  );
  return { first: first.toISOString().slice(0, 10), last: last.toISOString().slice(0, 10), days };
}

/**
 * The day (YYYY-MM-DD) an instant falls on where someone is: their time zone, or UTC where they
 * chose none or chose one this system does not know.
 */
export function dayIn(instant: Date, timeZone?: string | null): string {
  const day = (zone: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(instant);
  try {
    return day(timeZone || "UTC");
  } catch {
    return day("UTC");
  }
}

/** A month next to another: -1 for the one before. */
export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7);
}

/** Text in an ICS value: backslashes, semicolons, commas and line breaks escaped. */
const icsText = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** An ICS line folded at 75 octets, continuations starting with a space (RFC 5545 3.1). */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  const decoder = new TextDecoder();
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Never split a character: step back off a continuation byte.
    while (end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
    parts.push(decoder.decode(bytes.slice(start, end)));
    start = end;
    limit = 74;
  }
  return parts.join("\r\n ");
}

const icsDate = (date: string) => date.replaceAll("-", "");
const icsStamp = (at: Date) => `${at.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
const nextDay = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/**
 * A calendar as an ICS file: each event a whole day (or the whole days of its range), titled,
 * with its link back to Hekate, and nothing else (no notes, no people), as the feed promises.
 */
export function icsCalendar(
  name: string,
  events: CalendarEvent[],
  options: { base: string; host: string; now: Date },
): string {
  const base = options.base.replace(/\/$/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Hekate//Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(name)}`,
    ...events.flatMap((e) => [
      "BEGIN:VEVENT",
      `UID:${e.id}@${options.host}`,
      `DTSTAMP:${icsStamp(options.now)}`,
      `DTSTART;VALUE=DATE:${icsDate(e.date)}`,
      `DTEND;VALUE=DATE:${icsDate(nextDay(e.end && e.end > e.date ? e.end : e.date))}`,
      `SUMMARY:${icsText(e.title)}`,
      `URL:${base}${e.link}`,
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

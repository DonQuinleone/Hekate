/**
 * A project's calendar (#141): what is due and what is booked, by day, and the same as an ICS
 * feed for whichever calendar someone keeps (RFC 5545).
 */

export const calendarKinds = ["review", "task", "session"] as const;
export type CalendarKind = (typeof calendarKinds)[number];

/** Something on a day: a review or task due, a recording session. */
export interface CalendarEvent {
  /** Its kind and id, unique within a project's calendar. */
  id: string;
  kind: CalendarKind;
  /** The day, as a date: 2026-10-21. */
  date: string;
  title: string;
  /** Where it is in Hekate, a path: `/reviews/…`. */
  link: string;
  /** Due before today and not finished. */
  overdue: boolean;
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
 * A calendar as an ICS file: each event a whole day, titled, with its link back to Hekate, and
 * nothing else (no notes, no people), as the feed promises.
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
      `DTEND;VALUE=DATE:${icsDate(nextDay(e.date))}`,
      `SUMMARY:${icsText(e.title)}`,
      `URL:${base}${e.link}`,
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

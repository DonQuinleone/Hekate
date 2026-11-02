import { type DateFormat, formatDate, formatTime, type TimeFormat } from "@hekate/shared";

/*
 * What the date and time fields show and read (#541): a calendar day as `YYYY-MM-DD` and a time
 * of day as `HH:MM` underneath, as a native field's value is, written and typed in the format
 * the workspace (or, on the instance's pages, the instance) chose rather than the browser's.
 */

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const pad = (n: number) => String(n).padStart(2, "0");

/** A calendar day as its parts, or null where it is not one (31 April, say). */
function dayOf(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) return null;
  if (month < 1 || month > 12 || day < 1) return null;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > last) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Whether a value is a calendar day as the fields hold one. */
export const isDay = (value: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return m !== null && dayOf(Number(m[1]), Number(m[2]), Number(m[3])) === value;
};

/** `2026-10-12` as the format writes it: `2026-10-12`, `12 Oct 2026` or `Oct 12, 2026`. */
export function showDay(value: string, format: DateFormat): string {
  if (!isDay(value)) return value;
  return formatDate(format, `${value}T00:00:00Z`, { timeZone: "UTC" });
}

/** A month named in full or by its first three letters, as a number from 1. */
const monthNamed = (word: string) => {
  const w = word.toLowerCase().replace(/\.$/, "");
  if (w.length < 3) return 0;
  return MONTHS.findIndex((m) => m.startsWith(w)) + 1;
};

/**
 * What was typed, as a calendar day, or null where it is not one. ISO 8601 is read in every
 * format; a month by name in any order ("12 Oct 2026", "October 12, 2026"); and figures alone
 * ("12/10/2026", "12.10.26") in the order the format puts them, the day first unless it is
 * month, day, year. A year of two figures is this century's.
 */
export function readDay(text: string, format: DateFormat): string | null {
  const typed = text.trim().replace(/,/g, " ").replace(/\s+/g, " ");
  if (!typed) return null;
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(typed);
  if (iso) return dayOf(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const year = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));
  const named = /^(\d{1,2}) ([a-z.]+) (\d{2}|\d{4})$/i.exec(typed);
  if (named) {
    const month = monthNamed(named[2] ?? "");
    return month ? dayOf(year(named[3] ?? ""), month, Number(named[1])) : null;
  }
  const namedFirst = /^([a-z.]+) (\d{1,2}) (\d{2}|\d{4})$/i.exec(typed);
  if (namedFirst) {
    const month = monthNamed(namedFirst[1] ?? "");
    return month ? dayOf(year(namedFirst[3] ?? ""), month, Number(namedFirst[2])) : null;
  }
  const figures = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2}|\d{4})$/.exec(typed);
  if (figures) {
    const [a, b] = [Number(figures[1]), Number(figures[2])];
    const [month, day] = format === "month-day-year" ? [a, b] : [b, a];
    return dayOf(year(figures[3] ?? ""), month, day);
  }
  return null;
}

/** Whether a value is a time of day as the fields hold one. */
export const isTime = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

/** `13:05` as the format writes it: `13:05`, or `1:05 pm`. */
export function showTime(value: string, format: TimeFormat): string {
  if (!isTime(value)) return value;
  return formatTime(format, `2026-01-01T${value}:00Z`, { timeZone: "UTC" });
}

/**
 * What was typed, as a time of day, or null. Read in either clock whichever the format: `13:05`,
 * `1305`, `9.30`, `9`, `1:05 pm`, `1pm`, `12 am`.
 */
export function readTime(text: string): string | null {
  const typed = text.trim().toLowerCase().replace(/\s+/g, "");
  const m = /^(\d{1,2})(?:[:.h]?(\d{2}))?(am|pm|a|p)?$/.exec(typed);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? "0");
  const half = m[3]?.[0];
  if (minute > 59) return null;
  if (half) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (half === "p" ? 12 : 0);
  } else if (hour > 23) return null;
  return `${pad(hour)}:${pad(minute)}`;
}

/** A date and time as the fields hold one: `YYYY-MM-DDTHH:MM`, local, or "" for neither. */
export function joinDayTime(day: string, time: string): string {
  if (!day) return "";
  return `${day}T${time || "00:00"}`;
}

/** The day and the time of a value the fields hold. */
export function splitDayTime(value: string): { day: string; time: string } {
  const [day = "", time = ""] = value.split("T");
  return { day, time: time.slice(0, 5) };
}

/** What the fields show as an example of the format, empty. */
export const dayPlaceholder = (format: DateFormat) =>
  format === "iso" ? "YYYY-MM-DD" : format === "day-month-year" ? "12 Oct 2026" : "Oct 12, 2026";
export const timePlaceholder = (format: TimeFormat) => (format === "24h" ? "HH:MM" : "1:05 pm");

/**
 * The one day of a shown month that Tab reaches, so the arrows can move from it: the chosen day,
 * else today, else the first day that may be picked. A day that may not be picked is never it,
 * or the keyboard could not get into the grid at all.
 */
export function tabStop(
  weeks: (string | null)[][],
  value: string,
  today: string,
  allowed: (day: string) => boolean,
): string | undefined {
  const days = weeks.flat().filter((d): d is string => d !== null);
  const usable = (d: string) => days.includes(d) && allowed(d);
  if (value && usable(value)) return value;
  if (usable(today)) return today;
  return days.find(allowed) ?? days[0];
}

/** The days of the month a calendar shows, Monday first, padded with nulls to whole weeks. */
export function monthGrid(year: number, month: number): (string | null)[][] {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const lead = (first + 6) % 7;
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: (string | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: count }, (_, i) => `${year}-${pad(month)}-${pad(i + 1)}`),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
}

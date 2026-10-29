import { z } from "zod";

/**
 * How dates and times read (#481). ISO 8601 is the default: a label works with people in many
 * countries, and 2026-10-29 reads the same to all of them, where 10/11 does not. An instance
 * chooses for every workspace; a workspace may choose its own. A member's own choice may follow.
 */
export const dateFormats = ["iso", "day-month-year", "month-day-year"] as const;
export const dateFormat = z.enum(dateFormats);
export type DateFormat = z.infer<typeof dateFormat>;

export const timeFormats = ["24h", "12h"] as const;
export const timeFormat = z.enum(timeFormats);
export type TimeFormat = z.infer<typeof timeFormat>;

/** Each format named as the settings offer it, with an example beside it. */
export const dateFormatLabels: Record<DateFormat, string> = {
  iso: "ISO 8601",
  "day-month-year": "Day, month, year",
  "month-day-year": "Month, day, year",
};
export const timeFormatLabels: Record<TimeFormat, string> = {
  "24h": "24-hour",
  "12h": "12-hour",
};

export interface DateFormats {
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
}

export const defaultDateFormats: DateFormats = { dateFormat: "iso", timeFormat: "24h" };

/** A workspace's formats where it chose them, the instance's where it did not. */
export function effectiveDateFormats(
  workspace: { dateFormat: DateFormat | null; timeFormat: TimeFormat | null },
  instance: DateFormats,
): DateFormats {
  return {
    dateFormat: workspace.dateFormat ?? instance.dateFormat,
    timeFormat: workspace.timeFormat ?? instance.timeFormat,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface Parts {
  year: string;
  month: number;
  day: number;
  hour: number;
  minute: string;
  second: string;
  weekday: string;
}

/** One reader of an instant's parts per time zone, kept: lists format many rows. */
const readers = new Map<string, Intl.DateTimeFormat>();

const readerFor = (timeZone: string | undefined) => {
  const key = timeZone ?? "";
  let reader = readers.get(key);
  if (!reader) {
    reader = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "long",
    });
    readers.set(key, reader);
  }
  return reader;
};

/** The instant's parts where the time zone is; the runtime's own zone when none is given. */
function partsOf(date: Date | string | number, timeZone?: string | null): Parts {
  const instant = date instanceof Date ? date : new Date(date);
  let read: Intl.DateTimeFormatPart[];
  try {
    read = readerFor(timeZone || undefined).formatToParts(instant);
  } catch {
    // A zone the runtime does not know: the runtime's own.
    read = readerFor(undefined).formatToParts(instant);
  }
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    read.find((p) => p.type === type)?.value ?? "";
  return {
    year: part("year"),
    month: Number(part("month")),
    day: Number(part("day")),
    hour: Number(part("hour")),
    minute: part("minute"),
    second: part("second"),
    weekday: part("weekday"),
  };
}

const pad2 = (n: number) => String(n).padStart(2, "0");

export interface DateOptions {
  /** Where the reader is; `UTC` keeps a calendar day as it is. Unset is the runtime's zone. */
  timeZone?: string | null;
  /** Leave the year out where the format allows (a list of recent things); ISO always has it. */
  year?: boolean;
  /** The day's name before the date: "Thursday 29 Oct 2026". */
  weekday?: "long" | "short";
}

export interface TimeOptions {
  timeZone?: string | null;
  seconds?: boolean;
}

/** `2026-10-29`, `29 Oct 2026` or `Oct 29, 2026`. */
export function formatDate(
  format: DateFormat,
  date: Date | string | number,
  options: DateOptions = {},
): string {
  const p = partsOf(date, options.timeZone);
  const year = options.year !== false;
  let text: string;
  switch (format) {
    case "iso":
      text = `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
      break;
    case "day-month-year":
      text = `${p.day} ${MONTHS[p.month - 1]}${year ? ` ${p.year}` : ""}`;
      break;
    case "month-day-year":
      text = `${MONTHS[p.month - 1]} ${p.day}${year ? `, ${p.year}` : ""}`;
      break;
  }
  if (!options.weekday) return text;
  const weekday = options.weekday === "short" ? p.weekday.slice(0, 3) : p.weekday;
  // As each format's readers write it: "Thursday 29 Oct 2026", but "Thursday, Oct 29, 2026".
  return format === "day-month-year" ? `${weekday} ${text}` : `${weekday}, ${text}`;
}

/** `14:05` or `2:05 pm`; `00:00` or `12:00 am` at midnight. */
export function formatTime(
  format: TimeFormat,
  date: Date | string | number,
  options: TimeOptions = {},
): string {
  const p = partsOf(date, options.timeZone);
  const seconds = options.seconds ? `:${p.second}` : "";
  if (format === "24h") return `${pad2(p.hour)}:${p.minute}${seconds}`;
  const hour = p.hour % 12 || 12;
  return `${hour}:${p.minute}${seconds} ${p.hour < 12 ? "am" : "pm"}`;
}

/** `2026-10-29 14:05`, `29 Oct 2026, 14:05` or `Oct 29, 2026, 2:05 pm`. */
export function formatDateTime(
  formats: DateFormats,
  date: Date | string | number,
  options: DateOptions & TimeOptions = {},
): string {
  const { seconds, ...dateOptions } = options;
  const day = formatDate(formats.dateFormat, date, dateOptions);
  const time = formatTime(formats.timeFormat, date, { timeZone: options.timeZone, seconds });
  return formats.dateFormat === "iso" ? `${day} ${time}` : `${day}, ${time}`;
}

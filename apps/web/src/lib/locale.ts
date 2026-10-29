import {
  type DateFormats,
  dayIn,
  defaultDateFormats,
  formatDate,
  formatDateTime,
  formatTime,
} from "@hekate/shared";

/** Each offered language by its English name ("British English", "German (Germany)"). */
export const languageNames = new Intl.DisplayNames(["en-GB"], { type: "language" });

/**
 * Dates and numbers as the member reads them: their language and time zone when they chose
 * them (Account), else the workspace's language, otherwise the browser's. A date's shape is the
 * workspace's choice, not the language's (#481): ISO 8601 and the 24-hour clock unless the
 * instance or the workspace chose otherwise. Formatters are made on first use and remade when
 * a choice changes, so modules can hold one as a constant and call `.format` as with Intl.
 */
let current: { locale: string | undefined; timeZone: string | undefined; dates: DateFormats } = {
  locale: undefined,
  timeZone: undefined,
  dates: defaultDateFormats,
};
let generation = 0;

/** Set by the shell once the member is known; null or undefined follows the browser. */
export function setLocale(locale?: string | null, timeZone?: string | null) {
  const next = { locale: locale ?? undefined, timeZone: timeZone ?? undefined };
  if (next.locale === current.locale && next.timeZone === current.timeZone) return;
  current = { ...current, ...next };
  generation += 1;
}

/**
 * Set as the workspace is known (`me`, or a guest's page): how its dates and times read.
 * Null, or a format left out, is ISO 8601 and the 24-hour clock.
 */
export function setDateFormats(formats?: Partial<DateFormats> | null) {
  const next: DateFormats = {
    dateFormat: formats?.dateFormat ?? defaultDateFormats.dateFormat,
    timeFormat: formats?.timeFormat ?? defaultDateFormats.timeFormat,
  };
  if (next.dateFormat === current.dates.dateFormat && next.timeFormat === current.dates.timeFormat)
    return;
  current = { ...current, dates: next };
  generation += 1;
}

/** How dates and times read now, for whatever formats a date itself. */
export const dateFormats = (): DateFormats => current.dates;

/** A key that changes with the member's language, time zone and date formats, to redraw what shows dates. */
export const localeKey = () =>
  `${current.locale ?? ""}|${current.timeZone ?? ""}|${current.dates.dateFormat}|${current.dates.timeFormat}`;

/**
 * As `new Intl.DateTimeFormat(locale, options)`, in the member's language and time zone; a
 * `timeZone` in the options wins, for a date that has none (`UTC` keeps a calendar day as it is).
 *
 * Options that ask for a date (a day and a month, or a date style) or a time of day (an hour and
 * a minute, or a time style) are written in the workspace's format (#481) rather than the
 * language's: `2026-10-29`, `29 Oct 2026` or `Oct 29, 2026`; `14:05` or `2:05 pm`. A year is
 * shown where the options ask for one (ISO always has it), a weekday where they name one, and
 * seconds where they ask for them. Anything else (a month alone, a month and a year, a weekday
 * and a day) is Intl's own, in the language.
 */
export function formatDates(options: Intl.DateTimeFormatOptions) {
  const date = (options.day !== undefined && options.month !== undefined) || !!options.dateStyle;
  const time = (options.hour !== undefined && options.minute !== undefined) || !!options.timeStyle;
  if (date || time) {
    const year = options.year !== undefined || !!options.dateStyle;
    const weekday =
      options.weekday === undefined ? undefined : options.weekday === "long" ? "long" : "short";
    const seconds = options.second !== undefined;
    const format = (given?: Date | number) => {
      const instant = given ?? Date.now();
      const timeZone = options.timeZone ?? current.timeZone;
      if (date && time)
        return formatDateTime(current.dates, instant, { timeZone, year, weekday, seconds });
      if (date) return formatDate(current.dates.dateFormat, instant, { timeZone, year, weekday });
      return formatTime(current.dates.timeFormat, instant, { timeZone, seconds });
    };
    return {
      format,
      formatRange: (a: Date | number, b: Date | number) => {
        const from = format(a);
        const to = format(b);
        return from === to ? from : `${from} – ${to}`;
      },
    };
  }
  let made: Intl.DateTimeFormat | null = null;
  let madeIn = -1;
  const get = () => {
    if (!made || madeIn !== generation) {
      made = new Intl.DateTimeFormat(current.locale, {
        ...options,
        timeZone: options.timeZone ?? current.timeZone,
      });
      madeIn = generation;
    }
    return made;
  };
  return {
    format: (date?: Date | number) => get().format(date),
    formatRange: (a: Date | number, b: Date | number) => get().formatRange(a, b),
  };
}

/** As `new Intl.RelativeTimeFormat(locale, options)`, in the member's language. */
export function relativeFormat(options: Intl.RelativeTimeFormatOptions) {
  let made: Intl.RelativeTimeFormat | null = null;
  let madeIn = -1;
  return {
    format: (value: number, unit: Intl.RelativeTimeFormatUnit) => {
      if (!made || madeIn !== generation) {
        made = new Intl.RelativeTimeFormat(current.locale, options);
        madeIn = generation;
      }
      return made.format(value, unit);
    },
  };
}

/** The day (YYYY-MM-DD) an instant falls on where the member is, in their time zone. */
export const dayHere = (instant: Date | string | number = new Date()) =>
  dayIn(new Date(instant), current.timeZone);

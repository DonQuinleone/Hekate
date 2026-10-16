/**
 * Dates and numbers as the member reads them: their language and time zone when they chose
 * them (Account), otherwise the browser's. Formatters are made on first use and remade when
 * the choice changes, so modules can hold one as a constant and call `.format` as with Intl.
 */
let current: { locale: string | undefined; timeZone: string | undefined } = {
  locale: undefined,
  timeZone: undefined,
};
let generation = 0;

/** Set by the shell once the member is known; null or undefined follows the browser. */
export function setLocale(locale?: string | null, timeZone?: string | null) {
  const next = { locale: locale ?? undefined, timeZone: timeZone ?? undefined };
  if (next.locale === current.locale && next.timeZone === current.timeZone) return;
  current = next;
  generation += 1;
}

/** A key that changes with the member's language and time zone, to redraw what shows dates. */
export const localeKey = () => `${current.locale ?? ""}|${current.timeZone ?? ""}`;

/** As `new Intl.DateTimeFormat(locale, options)`, in the member's language and time zone. */
export function formatDates(options: Intl.DateTimeFormatOptions) {
  let made: Intl.DateTimeFormat | null = null;
  let madeIn = -1;
  const get = () => {
    if (!made || madeIn !== generation) {
      made = new Intl.DateTimeFormat(current.locale, { ...options, timeZone: current.timeZone });
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

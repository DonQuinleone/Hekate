import { afterEach, describe, expect, it } from "vitest";
import { formatDates, localeKey, relativeFormat, setDateFormats, setLocale } from "./locale";

const moment = new Date("2026-10-14T23:30:00Z");

describe("dates as the member reads them", () => {
  afterEach(() => {
    setLocale(null, null);
    setDateFormats(null);
  });

  it("follows the time zone chosen, in ISO 8601 until a format is chosen (#481)", () => {
    const day = formatDates({ day: "numeric", month: "short" });
    setLocale("en-GB", "UTC");
    expect(day.format(moment)).toBe("2026-10-14");
    // The same moment is already the 15th in Tokyo; the language does not change the shape.
    setLocale("en-US", "Asia/Tokyo");
    expect(day.format(moment)).toBe("2026-10-15");
    expect(localeKey()).toBe("en-US|Asia/Tokyo|iso|24h");
  });

  it("writes dates and times in the workspace's format, and changes when it does", () => {
    const day = formatDates({ day: "numeric", month: "short" });
    const full = formatDates({ day: "numeric", month: "long", year: "numeric" });
    const clock = formatDates({ hour: "2-digit", minute: "2-digit" });
    const moment2 = formatDates({ dateStyle: "medium", timeStyle: "short" });
    const named = formatDates({ weekday: "long", day: "numeric", month: "long" });
    setLocale("en-GB", "UTC");
    setDateFormats({ dateFormat: "day-month-year", timeFormat: "12h" });
    expect(day.format(moment)).toBe("14 Oct");
    expect(full.format(moment)).toBe("14 Oct 2026");
    expect(clock.format(moment)).toBe("11:30 pm");
    expect(moment2.format(moment)).toBe("14 Oct 2026, 11:30 pm");
    expect(named.format(moment)).toBe("Wednesday 14 Oct");
    expect(localeKey()).toBe("en-GB|UTC|day-month-year|12h");
    setDateFormats({ dateFormat: "month-day-year" });
    expect(day.format(moment)).toBe("Oct 14");
    expect(moment2.format(moment)).toBe("Oct 14, 2026, 23:30");
    expect(localeKey()).toBe("en-GB|UTC|month-day-year|24h");
  });

  it("writes a range as two dates, or one where they are the same day", () => {
    const span = formatDates({ day: "numeric", month: "short", timeZone: "UTC" });
    expect(span.formatRange(new Date("2026-09-12T12:00Z"), new Date("2026-09-13T12:00Z"))).toBe(
      "2026-09-12 – 2026-09-13",
    );
    expect(span.formatRange(new Date("2026-09-12T12:00Z"), new Date("2026-09-12T18:00Z"))).toBe(
      "2026-09-12",
    );
  });

  it("leaves a month or a weekday alone to the language", () => {
    const month = formatDates({ month: "long", year: "numeric", timeZone: "UTC" });
    setLocale("de-DE", null);
    expect(month.format(moment)).toBe("Oktober 2026");
  });

  it("keeps a calendar day as it is when the format names its own time zone", () => {
    // A session recorded on the 14th stays the 14th for a member in Kiritimati (UTC+14).
    const day = formatDates({ day: "numeric", month: "short", timeZone: "UTC" });
    setLocale("en-GB", "Pacific/Kiritimati");
    expect(day.format(new Date("2026-10-14T12:00:00Z"))).toBe("2026-10-14");
  });

  it("words relative times in the chosen language", () => {
    setLocale("de-DE", null);
    expect(relativeFormat({ numeric: "auto" }).format(-1, "day")).toBe("gestern");
  });
});

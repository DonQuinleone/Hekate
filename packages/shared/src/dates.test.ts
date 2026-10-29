import { describe, expect, it } from "vitest";
import {
  defaultDateFormats,
  effectiveDateFormats,
  formatDate,
  formatDateTime,
  formatTime,
} from "./dates.ts";

const afternoon = new Date("2026-10-29T14:05:09Z");
const midnight = new Date("2026-10-29T00:00:00Z");
const noon = new Date("2026-10-29T12:00:00Z");
// Still 31 December in New York, already 1 January in Tokyo.
const turn = new Date("2027-01-01T03:30:00Z");

describe("dates in the chosen format (#481)", () => {
  it("writes a date in each format, ISO always with its year", () => {
    expect(formatDate("iso", afternoon, { timeZone: "UTC" })).toBe("2026-10-29");
    expect(formatDate("day-month-year", afternoon, { timeZone: "UTC" })).toBe("29 Oct 2026");
    expect(formatDate("month-day-year", afternoon, { timeZone: "UTC" })).toBe("Oct 29, 2026");
    expect(formatDate("iso", afternoon, { timeZone: "UTC", year: false })).toBe("2026-10-29");
    expect(formatDate("day-month-year", afternoon, { timeZone: "UTC", year: false })).toBe(
      "29 Oct",
    );
    expect(formatDate("month-day-year", afternoon, { timeZone: "UTC", year: false })).toBe(
      "Oct 29",
    );
  });

  it("takes a string or a number as it takes a Date, and pads single digits in ISO", () => {
    expect(formatDate("iso", "2026-03-05T10:00:00Z", { timeZone: "UTC" })).toBe("2026-03-05");
    expect(formatDate("iso", Date.UTC(2026, 2, 5), { timeZone: "UTC" })).toBe("2026-03-05");
    expect(formatDate("day-month-year", "2026-03-05T10:00:00Z", { timeZone: "UTC" })).toBe(
      "5 Mar 2026",
    );
  });

  it("names the day where asked, as each format's readers write it", () => {
    expect(formatDate("iso", afternoon, { timeZone: "UTC", weekday: "long" })).toBe(
      "Thursday, 2026-10-29",
    );
    expect(formatDate("day-month-year", afternoon, { timeZone: "UTC", weekday: "long" })).toBe(
      "Thursday 29 Oct 2026",
    );
    expect(formatDate("month-day-year", afternoon, { timeZone: "UTC", weekday: "short" })).toBe(
      "Thu, Oct 29, 2026",
    );
  });

  it("writes a time of day in 24-hour and 12-hour clocks, at midnight and noon too", () => {
    expect(formatTime("24h", afternoon, { timeZone: "UTC" })).toBe("14:05");
    expect(formatTime("12h", afternoon, { timeZone: "UTC" })).toBe("2:05 pm");
    expect(formatTime("24h", midnight, { timeZone: "UTC" })).toBe("00:00");
    expect(formatTime("12h", midnight, { timeZone: "UTC" })).toBe("12:00 am");
    expect(formatTime("24h", noon, { timeZone: "UTC" })).toBe("12:00");
    expect(formatTime("12h", noon, { timeZone: "UTC" })).toBe("12:00 pm");
    expect(formatTime("24h", afternoon, { timeZone: "UTC", seconds: true })).toBe("14:05:09");
    expect(formatTime("12h", afternoon, { timeZone: "UTC", seconds: true })).toBe("2:05:09 pm");
  });

  it("writes a date and time together, each format its own way", () => {
    expect(formatDateTime(defaultDateFormats, afternoon, { timeZone: "UTC" })).toBe(
      "2026-10-29 14:05",
    );
    expect(
      formatDateTime({ dateFormat: "day-month-year", timeFormat: "24h" }, afternoon, {
        timeZone: "UTC",
      }),
    ).toBe("29 Oct 2026, 14:05");
    expect(
      formatDateTime({ dateFormat: "month-day-year", timeFormat: "12h" }, afternoon, {
        timeZone: "UTC",
      }),
    ).toBe("Oct 29, 2026, 2:05 pm");
    expect(
      formatDateTime({ dateFormat: "day-month-year", timeFormat: "12h" }, midnight, {
        timeZone: "UTC",
        year: false,
        seconds: true,
      }),
    ).toBe("29 Oct, 12:00:00 am");
  });

  it("reads the date where the reader is, across a year's turn", () => {
    expect(formatDate("iso", turn, { timeZone: "America/New_York" })).toBe("2026-12-31");
    expect(formatDate("iso", turn, { timeZone: "Asia/Tokyo" })).toBe("2027-01-01");
    expect(formatDate("day-month-year", turn, { timeZone: "America/New_York" })).toBe(
      "31 Dec 2026",
    );
    expect(formatDate("month-day-year", turn, { timeZone: "Asia/Tokyo" })).toBe("Jan 1, 2027");
    expect(formatTime("24h", turn, { timeZone: "America/New_York" })).toBe("22:30");
    expect(formatDateTime(defaultDateFormats, turn, { timeZone: "Asia/Tokyo" })).toBe(
      "2027-01-01 12:30",
    );
    // A zone the runtime does not know reads as the runtime's own, rather than failing.
    expect(formatDate("iso", turn, { timeZone: "Nowhere/Here" })).toMatch(/^202[67]-/);
  });

  it("lets a workspace's choice stand over the instance's, and the instance's fill the gaps", () => {
    const instance = { dateFormat: "day-month-year", timeFormat: "12h" } as const;
    expect(effectiveDateFormats({ dateFormat: null, timeFormat: null }, instance)).toEqual(
      instance,
    );
    expect(effectiveDateFormats({ dateFormat: "iso", timeFormat: null }, instance)).toEqual({
      dateFormat: "iso",
      timeFormat: "12h",
    });
  });
});

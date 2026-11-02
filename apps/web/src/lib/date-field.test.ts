import { describe, expect, it } from "vitest";
import {
  isDay,
  joinDayTime,
  monthGrid,
  readDay,
  readTime,
  showDay,
  showTime,
  splitDayTime,
  tabStop,
} from "./date-field";

describe("a date field", () => {
  it("shows a day as the workspace writes dates", () => {
    expect(showDay("2026-10-12", "iso")).toBe("2026-10-12");
    expect(showDay("2026-10-12", "day-month-year")).toBe("12 Oct 2026");
    expect(showDay("2026-10-12", "month-day-year")).toBe("Oct 12, 2026");
    expect(showDay("", "iso")).toBe("");
  });

  it("reads back what it shows, in each format", () => {
    for (const format of ["iso", "day-month-year", "month-day-year"] as const)
      expect(readDay(showDay("2026-02-28", format), format)).toBe("2026-02-28");
  });

  it("reads ISO 8601 and month names whatever the format", () => {
    expect(readDay("2026-10-12", "month-day-year")).toBe("2026-10-12");
    expect(readDay("12 October 2026", "iso")).toBe("2026-10-12");
    expect(readDay("October 12, 2026", "day-month-year")).toBe("2026-10-12");
    expect(readDay("12 oct 26", "iso")).toBe("2026-10-12");
  });

  it("reads figures alone in the format's order, never guessing the US one", () => {
    expect(readDay("10/12/2026", "day-month-year")).toBe("2026-12-10");
    expect(readDay("10/12/2026", "iso")).toBe("2026-12-10");
    expect(readDay("10/12/2026", "month-day-year")).toBe("2026-10-12");
    expect(readDay("1.2.26", "day-month-year")).toBe("2026-02-01");
  });

  it("refuses what is not a day", () => {
    expect(readDay("31 April 2026", "iso")).toBeNull();
    expect(readDay("2026-02-29", "iso")).toBeNull();
    expect(readDay("next week", "iso")).toBeNull();
    expect(readDay("13/13/2026", "day-month-year")).toBeNull();
    expect(isDay("2026-13-01")).toBe(false);
    expect(isDay("2028-02-29")).toBe(true);
  });
});

describe("a time field", () => {
  it("shows a time on the workspace's clock", () => {
    expect(showTime("13:05", "24h")).toBe("13:05");
    expect(showTime("13:05", "12h")).toBe("1:05 pm");
    expect(showTime("00:00", "12h")).toBe("12:00 am");
  });

  it("reads either clock, however it is typed", () => {
    expect(readTime("13:05")).toBe("13:05");
    expect(readTime("1305")).toBe("13:05");
    expect(readTime("9.30")).toBe("09:30");
    expect(readTime("9")).toBe("09:00");
    expect(readTime("1:05 pm")).toBe("13:05");
    expect(readTime("1pm")).toBe("13:00");
    expect(readTime("12 am")).toBe("00:00");
    expect(readTime("12:30 PM")).toBe("12:30");
  });

  it("refuses what is not a time", () => {
    expect(readTime("24:00")).toBeNull();
    expect(readTime("13 pm")).toBeNull();
    expect(readTime("9:75")).toBeNull();
    expect(readTime("soon")).toBeNull();
  });
});

describe("a date and time field", () => {
  it("joins and splits its value as a native field holds it", () => {
    expect(joinDayTime("2026-10-12", "09:30")).toBe("2026-10-12T09:30");
    expect(joinDayTime("2026-10-12", "")).toBe("2026-10-12T00:00");
    expect(joinDayTime("", "09:30")).toBe("");
    expect(splitDayTime("2026-10-12T09:30")).toEqual({ day: "2026-10-12", time: "09:30" });
    expect(splitDayTime("")).toEqual({ day: "", time: "" });
  });
});

describe("a month's calendar", () => {
  it("starts on Monday and fills whole weeks", () => {
    // October 2026 starts on a Thursday and has 31 days.
    const weeks = monthGrid(2026, 10);
    expect(weeks).toHaveLength(5);
    expect(weeks[0]).toEqual([
      null,
      null,
      null,
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ]);
    expect(weeks[4]?.at(-1)).toBeNull();
    expect(weeks.flat().filter(Boolean)).toHaveLength(31);
  });

  it("lets Tab into the grid on a day that may be picked", () => {
    const weeks = monthGrid(2026, 10);
    const any = () => true;
    expect(tabStop(weeks, "2026-10-20", "2026-10-14", any)).toBe("2026-10-20");
    expect(tabStop(weeks, "", "2026-10-14", any)).toBe("2026-10-14");
    // Today is before the first allowed day (an end after a later start): the first allowed day.
    const fromThe22nd = (d: string) => d >= "2026-10-22";
    expect(tabStop(weeks, "", "2026-10-14", fromThe22nd)).toBe("2026-10-22");
    expect(tabStop(weeks, "2026-10-20", "2026-10-14", fromThe22nd)).toBe("2026-10-22");
    // Another month shown: its first day.
    expect(tabStop(monthGrid(2026, 11), "2026-10-20", "2026-10-14", any)).toBe("2026-11-01");
  });
});

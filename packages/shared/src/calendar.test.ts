import { describe, expect, it } from "vitest";
import {
  type CalendarEvent,
  dayIn,
  daysBetween,
  daysDragged,
  daysOf,
  deadlinePassed,
  icsCalendar,
  monthGrid,
  movedRange,
  resizedRange,
  shiftDay,
  shiftInstant,
  shiftMonth,
} from "./calendar.ts";

describe("a month on the calendar", () => {
  it("is six weeks from the Monday on or before its first", () => {
    const grid = monthGrid("2026-10");
    expect(grid.first).toBe("2026-10-01");
    expect(grid.last).toBe("2026-10-31");
    expect(grid.days[0]).toBe("2026-09-28");
    expect(grid.days).toHaveLength(42);
    expect(grid.days[41]).toBe("2026-11-08");
  });

  it("moves a month at a time, across a year", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });
});

describe("the calendar as a feed", () => {
  const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
    id: "task-1",
    kind: "task",
    date: "2026-10-21",
    title: "Re-export the stems",
    link: "/projects/p/tasks?task=1",
    overdue: false,
    ...over,
  });
  const ics = (events: CalendarEvent[]) =>
    icsCalendar("Joplin Rags", events, {
      base: "https://review.example.test/",
      host: "review.example.test",
      now: new Date("2026-10-14T10:00:00Z"),
    });

  it("has each event as a whole day, with its link, in CRLF lines", () => {
    const text = ics([event()]);
    expect(text.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(text).toContain("X-WR-CALNAME:Joplin Rags\r\n");
    expect(text).toContain("DTSTART;VALUE=DATE:20261021\r\nDTEND;VALUE=DATE:20261022\r\n");
    expect(text).toContain("DTSTAMP:20261014T100000Z\r\n");
    expect(text).toContain("UID:task-1@review.example.test\r\n");
    expect(text).toContain("URL:https://review.example.test/projects/p/tasks?task=1\r\n");
    expect(text.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("escapes what ICS reads as structure, and folds long lines without splitting a character", () => {
    const text = ics([event({ title: "Mix; master, and\nbounce — the Élégie ".repeat(4) })]);
    expect(text).toContain("SUMMARY:Mix\\; master\\, and\\nbounce");
    for (const line of text.split("\r\n"))
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    // Unfolded, the title reads whole again.
    expect(text.replace(/\r\n /g, "")).toContain("the Élégie Mix\\;");
  });

  it("ends the last of a month on the first of the next", () => {
    expect(ics([event({ date: "2026-12-31" })])).toContain("DTEND;VALUE=DATE:20270101");
  });
});

describe("the day an instant falls on", () => {
  // A review due at five in the afternoon in Los Angeles is already the next day in UTC.
  const due = new Date("2026-10-22T00:00:00Z");
  it("is the day where someone is", () => {
    expect(dayIn(due, "America/Los_Angeles")).toBe("2026-10-21");
    expect(dayIn(due, "Europe/London")).toBe("2026-10-22");
  });
  it("is UTC's where they chose no zone, or one unknown", () => {
    expect(dayIn(due, null)).toBe("2026-10-22");
    expect(dayIn(due, "Mars/Olympus_Mons")).toBe("2026-10-22");
  });
});

describe("deadlines and entries (#505)", () => {
  it("knows a day is overdue once today, where the reader is, is later", () => {
    const now = new Date("2026-10-22T03:00:00Z");
    expect(deadlinePassed("2026-10-21", now)).toBe(true);
    expect(deadlinePassed("2026-10-22", now)).toBe(false);
    // Still the 21st in Los Angeles at three in the morning UTC.
    expect(deadlinePassed("2026-10-21", now, "America/Los_Angeles")).toBe(false);
    expect(deadlinePassed(null, now)).toBe(false);
  });

  it("knows an instant is overdue once now is past it", () => {
    const now = new Date("2026-10-22T03:00:00Z");
    expect(deadlinePassed("2026-10-22T02:59:00Z", now)).toBe(true);
    expect(deadlinePassed(new Date("2026-10-22T03:01:00Z"), now)).toBe(false);
    expect(deadlinePassed("not a date", now)).toBe(false);
  });

  it("moves a range whole, as long as it was", () => {
    expect(movedRange({ startsOn: "2026-10-30", endsOn: "2026-11-01" }, 3)).toEqual({
      startsOn: "2026-11-02",
      endsOn: "2026-11-04",
    });
    expect(movedRange({ startsOn: "2026-03-01", endsOn: null }, -1)).toEqual({
      startsOn: "2026-02-28",
      endsOn: null,
    });
  });

  it("resizes a range at its end, never to less than a day", () => {
    expect(resizedRange({ startsOn: "2026-10-20", endsOn: null }, 2)).toEqual({
      startsOn: "2026-10-20",
      endsOn: "2026-10-22",
    });
    expect(resizedRange({ startsOn: "2026-10-20", endsOn: "2026-10-22" }, -2)).toEqual({
      startsOn: "2026-10-20",
      endsOn: null,
    });
    expect(resizedRange({ startsOn: "2026-10-20", endsOn: "2026-10-22" }, -5)).toEqual({
      startsOn: "2026-10-20",
      endsOn: null,
    });
  });

  it("lists the days of a range and counts between days", () => {
    expect(daysOf("2026-10-30", "2026-11-01")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01"]);
    expect(daysOf("2026-10-30")).toEqual(["2026-10-30"]);
    expect(daysOf("2026-10-30", "2026-10-29")).toEqual(["2026-10-30"]);
    expect(daysBetween("2026-10-30", "2026-11-02")).toBe(3);
    expect(daysBetween("2026-11-02", "2026-10-30")).toBe(-3);
    expect(shiftDay("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftInstant("2026-10-21T17:00:00.000Z", 2)).toBe("2026-10-23T17:00:00.000Z");
  });

  it("snaps a drag to whole days of the span", () => {
    // Six weeks over 840 px: 20 px a day.
    expect(daysDragged(0, 840, 42)).toBe(0);
    expect(daysDragged(9, 840, 42)).toBe(0);
    expect(daysDragged(11, 840, 42)).toBe(1);
    expect(daysDragged(-50, 840, 42)).toBe(-2);
    expect(daysDragged(50, 0, 42)).toBe(0);
  });

  it("writes a range into the feed as the days it covers", () => {
    const text = icsCalendar(
      "Rags",
      [
        {
          id: "entry-1",
          kind: "entry",
          date: "2026-10-30",
          end: "2026-11-01",
          title: "Listening meeting",
          link: "/projects/p/board?view=calendar",
          overdue: false,
        },
      ],
      { base: "https://hekate.test", host: "hekate.test", now: new Date("2026-10-14T10:00:00Z") },
    );
    expect(text).toContain("DTSTART;VALUE=DATE:20261030\r\nDTEND;VALUE=DATE:20261102");
  });
});

import { describe, expect, it } from "vitest";
import { type CalendarEvent, icsCalendar, monthGrid, shiftMonth } from "./calendar.ts";

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

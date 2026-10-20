import { describe, expect, it } from "vitest";
import {
  coverage,
  minutesOf,
  type ScheduleDay,
  type ScheduleRow,
  scheduleRowInput,
  slotTracks,
  timeOfDay,
  timesOf,
} from "./schedule.ts";

const row = (over: Partial<ScheduleRow>): ScheduleRow => ({
  id: "r",
  kind: "slot",
  start: null,
  minutes: 60,
  label: "",
  allRepertoire: false,
  workIds: [],
  trackIds: [],
  personnel: "",
  notes: "",
  done: false,
  ...over,
});

describe("the schedule", () => {
  it("reads and writes times of day, past midnight too", () => {
    expect(minutesOf("09:30")).toBe(570);
    expect(timeOfDay(570)).toBe("09:30");
    expect(timeOfDay(1500)).toBe("01:00");
  });

  it("chains each row from the one before, unless it sets its own start", () => {
    const day = {
      start: "09:00",
      rows: [
        row({ minutes: 60 }),
        row({ kind: "break", minutes: 20 }),
        row({ minutes: 70 }),
        row({ kind: "break", start: "13:00", minutes: 60 }),
        row({ minutes: 120 }),
      ],
    };
    expect(timesOf(day).map((t) => `${t.start}–${t.end}${t.fixed ? "*" : ""}`)).toEqual([
      "09:00–10:00",
      "10:00–10:20",
      "10:20–11:30",
      "13:00–14:00*",
      "14:00–16:00",
    ]);
  });

  it("finds a slot's tracks from its tracks, its works, or all repertoire", () => {
    const works = [{ id: "w", trackIds: ["a", "b"] }];
    expect(
      slotTracks(row({ workIds: ["w"], trackIds: ["b", "c"] }), works, ["a", "b", "c"]),
    ).toEqual(["b", "c", "a"]);
    expect(slotTracks(row({ allRepertoire: true }), works, ["a", "b", "c"])).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(slotTracks(row({ kind: "break", trackIds: ["a"] }), works, ["a"])).toEqual([]);
  });

  it("shows which tracks have a slot, and which have none", () => {
    const days: ScheduleDay[] = [
      {
        id: "d",
        label: "Day 1",
        date: null,
        venueId: null,
        start: "10:00",
        rows: [row({ trackIds: ["a"], minutes: 90 }), row({ kind: "break", minutes: 20 })],
      },
    ];
    const covered = coverage(days, [], ["a", "b"]);
    expect(covered.get("a")).toEqual([{ day: "Day 1", start: "10:00", minutes: 90 }]);
    expect(covered.get("b")).toEqual([]);
  });

  it("takes repertoire only in a slot, and a time as HH:MM", () => {
    expect(scheduleRowInput.safeParse({ kind: "break", minutes: 20, trackIds: [] }).success).toBe(
      true,
    );
    expect(
      scheduleRowInput.safeParse({ kind: "break", minutes: 20, allRepertoire: true }).success,
    ).toBe(false);
    expect(scheduleRowInput.safeParse({ kind: "slot", minutes: 20, start: "9:30" }).success).toBe(
      false,
    );
  });
});

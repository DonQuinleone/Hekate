import { describe, expect, it } from "vitest";
import {
  coverage,
  minutesOf,
  rowWords,
  type ScheduleDay,
  type ScheduleRow,
  scheduleOrder,
  scheduleRowInput,
  secondsLeft,
  slotTracks,
  timeOfDay,
  timesOf,
  tracksFinished,
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

  it("runs past midnight, and counts down to an end after it", () => {
    const day = {
      start: "22:00",
      rows: [row({ minutes: 90 }), row({ minutes: 90 }), row({ start: "01:30", minutes: 30 })],
    };
    expect(timesOf(day).map((t) => [t.start, t.end, t.ends])).toEqual([
      ["22:00", "23:30", 1410],
      ["23:30", "01:00", 1500],
      ["01:30", "02:00", 1560],
    ]);
    // At 23:45 on the day, a slot ending at 01:00 has an hour and a quarter left.
    expect(secondsLeft("2026-09-12", 1500, new Date(2026, 8, 12, 23, 45))).toBe(75 * 60);
    expect(secondsLeft("2026-09-12", 1500, new Date(2026, 8, 13, 1, 30))).toBe(0);
  });

  it("says what a row holds", () => {
    const works = [{ id: "w", title: "Rags", abbreviation: "RAGS" }];
    const tracks = [{ id: "a", name: "The Entertainer" }];
    expect(rowWords(row({ workIds: ["w"], trackIds: ["a"] }), works, tracks)).toBe(
      "RAGS, The Entertainer",
    );
    expect(rowWords(row({ allRepertoire: true }), works, tracks)).toBe("All repertoire");
    expect(rowWords(row({ kind: "break" }), works, tracks)).toBe("Break");
    expect(rowWords(row({ kind: "break", label: "Lunch" }), works, tracks)).toBe("Lunch");
  });

  it("orders works by their first slot, the unscheduled after", () => {
    const work = (id: string, ...tracks: string[]) => ({
      id,
      tracks: tracks.map((trackId) => ({ trackId })),
    });
    const works = [work("a", "t1"), work("b", "t2"), work("c", "t3"), work("d")];
    const days = [
      { rows: [row({ kind: "break" }), row({ trackIds: ["t3"] })] },
      { rows: [row({ workIds: ["b"] })] },
    ];
    expect(scheduleOrder(works, days).map((w) => w.id)).toEqual(["c", "b", "a", "d"]);
    expect(
      scheduleOrder(works, [{ rows: [row({ allRepertoire: true })] }]).map((w) => w.id),
    ).toEqual(["a", "b", "c", "d"]);
  });

  it("finds the tracks whose last slot a tick finished", () => {
    const works = [{ id: "w", trackIds: ["a", "b"] }];
    const days = [
      {
        rows: [
          row({ id: "1", trackIds: ["a"], done: true }),
          row({ id: "2", workIds: ["w"], done: true }),
          row({ id: "3", trackIds: ["b"] }),
        ],
      },
    ];
    // a has no slot left; b still has one.
    expect(tracksFinished("2", days, works, ["a", "b"])).toEqual(["a"]);
    expect(tracksFinished("3", days, works, ["a", "b"])).toEqual([]);
    const all = [{ rows: [row({ id: "4", allRepertoire: true, done: true })] }];
    expect(tracksFinished("4", all, works, ["a", "b"])).toEqual(["a", "b"]);
    expect(tracksFinished("x", all, works, ["a"])).toEqual([]);
  });
});

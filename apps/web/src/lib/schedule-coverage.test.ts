import type { ScheduleDay, ScheduleRow } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { coverageTotals, slotDays } from "./schedule-coverage";

const row = (over: Partial<ScheduleRow>): ScheduleRow => ({
  id: Math.random().toString(),
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
const day = (label: string, start: string, rows: ScheduleRow[]): ScheduleDay => ({
  id: label,
  label,
  date: null,
  venueId: null,
  start,
  rows,
});

describe("coverageTotals (#651)", () => {
  const days = [
    day("Day 1", "10:00", [
      row({ minutes: 110, trackIds: ["maple"] }),
      row({ kind: "break", minutes: 20 }),
      row({ minutes: 120, allRepertoire: true }),
    ]),
    day("Day 2", "10:30", [row({ minutes: 90, trackIds: ["elite"] })]),
  ];
  it("counts a shared slot once, so the totals add up to what is booked", () => {
    const { tracks, shared, booked } = coverageTotals(days, [], ["maple", "elite"]);
    expect(tracks.get("maple")).toMatchObject({ own: 110, shared: 120 });
    expect(tracks.get("elite")).toMatchObject({ own: 90, shared: 120 });
    expect(shared).toBe(120);
    expect(booked).toBe(320);
    const own = [...tracks.values()].reduce((n, t) => n + t.own, 0);
    expect(own + shared).toBe(booked);
  });
  it("groups a track's slots by day, naming each day once", () => {
    const { tracks } = coverageTotals(days, [], ["maple", "elite"]);
    expect(slotDays(tracks.get("maple")?.days ?? [])).toBe("Day 1: 10:00, 12:10");
    expect(slotDays(tracks.get("elite")?.days ?? [])).toBe("Day 1: 12:10 · Day 2: 10:30");
    expect(slotDays([])).toBeNull();
  });
});

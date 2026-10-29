import { describe, expect, it } from "vitest";
import { parseTimeEntry, timeEntryHint } from "./time-entry.ts";
import { videoClock } from "./video-time.ts";

const file = { duration: 600 };

describe("parseTimeEntry", () => {
  it("reads seconds, with or without a unit", () => {
    expect(parseTimeEntry("90", file)).toBe(90);
    expect(parseTimeEntry("12.5", file)).toBe(12.5);
    expect(parseTimeEntry("12,5", file)).toBe(12.5);
    expect(parseTimeEntry(" 45 s ", file)).toBe(45);
    expect(parseTimeEntry("45sec", file)).toBe(45);
  });

  it("reads minutes and seconds, hours too, to the millisecond", () => {
    expect(parseTimeEntry("1:30", file)).toBe(90);
    expect(parseTimeEntry("01:30.250", file)).toBe(90.25);
    expect(parseTimeEntry("0:05.5", file)).toBe(5.5);
    expect(parseTimeEntry("0:01:02", { duration: 0 })).toBe(62);
    expect(parseTimeEntry("1:02:03", { duration: 4000 })).toBe(3723);
  });

  it("refuses what is not a time, and a time past the end", () => {
    expect(parseTimeEntry("", file)).toBeNull();
    expect(parseTimeEntry("soon", file)).toBeNull();
    expect(parseTimeEntry("1:75", file)).toBeNull();
    expect(parseTimeEntry("-5", file)).toBeNull();
    expect(parseTimeEntry("601", file)).toBeNull();
    expect(parseTimeEntry("10:00", file)).toBe(600);
  });

  it("reads a timecode on a video's own clock, and clock time otherwise", () => {
    const clock = videoClock({ fps: 25, timecode: "10:00:00:00" });
    expect(parseTimeEntry("10:00:05:12", { duration: 60, clock })).toBeCloseTo(5.48, 5);
    expect(parseTimeEntry("10000512", { duration: 60, clock })).toBeCloseTo(5.48, 5);
    // Four fields past the file are refused; fewer are minutes and seconds from the start.
    expect(parseTimeEntry("10:20:00:00", { duration: 60, clock })).toBeNull();
    expect(parseTimeEntry("0:30", { duration: 60, clock })).toBe(30);
    expect(parseTimeEntry("12", { duration: 60, clock })).toBe(12);
  });

  it("reads a bar and beat where the project maps bars to time", () => {
    // Four beats a bar at 120 to the minute: half a second a beat.
    const barTime = (bar: number, beat: number) =>
      bar > 100 ? null : (bar - 1) * 2 + (beat - 1) * 0.5;
    const music = { duration: 600, barTime };
    expect(parseTimeEntry("25", music)).toBe(48);
    expect(parseTimeEntry("25.3", music)).toBe(49);
    expect(parseTimeEntry("bar 25", music)).toBe(48);
    expect(parseTimeEntry("b25.3", music)).toBe(49);
    expect(parseTimeEntry("Bars 25", music)).toBe(48);
    // Not in the map, or no such bar.
    expect(parseTimeEntry("101", music)).toBeNull();
    expect(parseTimeEntry("0", music)).toBeNull();
    // Seconds take a unit; a clock time is still a clock time.
    expect(parseTimeEntry("25 s", music)).toBe(25);
    expect(parseTimeEntry("1:30", music)).toBe(90);
  });
});

describe("timeEntryHint", () => {
  it("says what the field takes here", () => {
    expect(timeEntryHint({})).toMatch(/1:30/);
    expect(timeEntryHint({ clock: videoClock({ fps: 25 }) })).toMatch(/timecode/);
    expect(timeEntryHint({ barTime: () => 0 })).toMatch(/bar/);
  });
});

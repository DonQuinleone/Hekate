import { parseTimecodeLabel, type RecorderTimecode } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { chaseStep, fileTime, recorderSeconds } from "./chase";

const tc = (label: string) => parseTimecodeLabel(label, "25") as RecorderTimecode;
const at = 1_000_000;
const rolling = (label: string) => ({ timecode: tc(label), at, rolling: true });
const stopped = (label: string) => ({ timecode: tc(label), at, rolling: false });
const player = { time: 0, paused: true, rate: 1, duration: 180 };
const HOUR = 3600;

describe("the player chasing a DAW", () => {
  it("plays a rolling position on from its last word, for no more than a second", () => {
    expect(recorderSeconds(rolling("01:00:00:00"), at + 400)).toBeCloseTo(HOUR + 0.4);
    expect(recorderSeconds(rolling("01:00:00:00"), at + 5000)).toBeCloseTo(HOUR + 1);
    expect(recorderSeconds(stopped("01:00:00:00"), at + 5000)).toBe(HOUR);
  });

  it("measures from where the file starts, across midnight", () => {
    expect(fileTime(stopped("01:00:12:00"), HOUR, at)).toBe(12);
    expect(fileTime(stopped("00:00:30:00"), 24 * HOUR - 60, at)).toBe(90);
    expect(fileTime(stopped("00:59:50:00"), HOUR, at)).toBe(-10);
  });

  it("plays and seeks to the DAW when it rolls, and leaves small drift alone", () => {
    expect(chaseStep(player, rolling("01:00:12:00"), HOUR, at)).toEqual({
      seek: 12,
      play: true,
      rate: null,
    });
    expect(
      chaseStep({ ...player, time: 12.3, paused: false }, rolling("01:00:12:00"), HOUR, at),
    ).toEqual({ seek: null, play: null, rate: null });
  });

  it("pauses where the DAW stopped", () => {
    expect(
      chaseStep({ ...player, time: 40, paused: false }, stopped("01:00:12:00"), HOUR, at),
    ).toEqual({ seek: 12, play: false, rate: null });
  });

  it("waits at the start before the file begins, and at the end after it", () => {
    expect(chaseStep({ ...player, time: 5 }, rolling("00:59:50:00"), HOUR, at)).toEqual({
      seek: 0,
      play: null,
      rate: null,
    });
    expect(
      chaseStep({ ...player, time: 100, paused: false }, rolling("01:05:00:00"), HOUR, at),
    ).toEqual({ seek: 180, play: false, rate: null });
  });

  it("brings the speed back to normal", () => {
    expect(chaseStep({ ...player, rate: 1.5 }, stopped("01:00:00:00"), HOUR, at).rate).toBe(1);
  });
});

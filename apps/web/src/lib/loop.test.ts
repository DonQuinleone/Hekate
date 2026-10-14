import { describe, expect, it } from "vitest";
import { formatLoop, loopFrom, nudge, parseLoop, roll, wrapTarget } from "./loop";

const none = { pre: 0, post: 0 };

describe("loops", () => {
  it("makes a loop from two points in either order, inside the media", () => {
    expect(loopFrom(18.25, 12.5, 60)).toEqual({ start: 12.5, end: 18.25 });
    expect(loopFrom(-3, 70, 60)).toEqual({ start: 0, end: 60 });
    expect(loopFrom(10, 10.01, 60)).toBeNull();
    expect(loopFrom(1, 2, 0)).toBeNull();
    expect(loopFrom(1.23456, 2, 60)?.start).toBe(1.235);
  });

  it("nudges an edge without crossing the other or leaving the media", () => {
    const loop = { start: 10, end: 12 };
    expect(nudge(loop, "start", 0.1, 60)).toEqual({ start: 10.1, end: 12 });
    expect(nudge(loop, "end", -0.001, 60)).toEqual({ start: 10, end: 11.999 });
    expect(nudge(loop, "start", 5, 60)).toEqual({ start: 11.95, end: 12 });
    expect(nudge(loop, "start", -20, 60)).toEqual({ start: 0, end: 12 });
    expect(nudge(loop, "end", 100, 60)).toEqual({ start: 10, end: 60 });
  });

  it("goes round at the end, with pre-roll and post-roll", () => {
    const loop = { start: 10, end: 12 };
    expect(wrapTarget(11, loop, none, 60)).toBeNull();
    expect(wrapTarget(12, loop, none, 60)).toBe(10);
    const rolls = { pre: 2, post: 1 };
    // Post-roll: carries on past the end before going round, to the pre-roll.
    expect(wrapTarget(12.5, loop, rolls, 60)).toBeNull();
    expect(wrapTarget(13, loop, rolls, 60)).toBe(8);
    // Pre-roll never goes before the start of the media.
    expect(wrapTarget(3, { start: 1, end: 3 }, rolls, 60)).toBeNull();
    expect(wrapTarget(4, { start: 1, end: 3 }, rolls, 60)).toBe(0);
    // A loop at the very end goes round when the media ends.
    expect(wrapTarget(60, { start: 58, end: 60 }, rolls, 60)).toBe(56);
  });

  it("leaves a playhead moved outside the loop alone", () => {
    const loop = { start: 10, end: 12 };
    expect(wrapTarget(5, loop, none, 60)).toBeNull();
    expect(wrapTarget(30, loop, none, 60)).toBeNull();
  });

  it("round-trips through an address", () => {
    const loop = { start: 12.5, end: 18.25 };
    expect(parseLoop(formatLoop(loop))).toEqual(loop);
    expect(parseLoop("18-12")).toBeNull();
    expect(parseLoop("a-b")).toBeNull();
    expect(parseLoop(undefined)).toBeNull();
  });

  it("keeps rolls to what is offered", () => {
    expect(roll(2.345)).toBe(2.3);
    expect(roll(-1)).toBe(0);
    expect(roll(99)).toBe(10);
    expect(roll(Number.NaN)).toBe(0);
  });
});

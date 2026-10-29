import { describe, expect, it } from "vitest";
import { fractionAt, interpolatePosition } from "./playhead";

describe("the playhead between time updates (#492)", () => {
  it("moves on from the last time read, at the playback rate", () => {
    // 250 ms after a reading of 10 s, at normal speed: 10.25 s.
    expect(interpolatePosition(10, 1000, 1250, 1, true)).toBeCloseTo(10.25, 9);
    // At half speed the same quarter second is an eighth.
    expect(interpolatePosition(10, 1000, 1250, 0.5, true)).toBeCloseTo(10.125, 9);
    expect(interpolatePosition(10, 1000, 1250, 1.5, true)).toBeCloseTo(10.375, 9);
  });

  it("stays where it was read while paused, and never goes back before it", () => {
    expect(interpolatePosition(10, 1000, 1250, 1, false)).toBe(10);
    // A frame clock that reads earlier than the sample (a clock set back) does not rewind it.
    expect(interpolatePosition(10, 1000, 900, 1, true)).toBe(10);
  });

  it("places a pointer across a box as a share of it, held within the box", () => {
    expect(fractionAt(150, 100, 200)).toBe(0.25);
    expect(fractionAt(50, 100, 200)).toBe(0);
    expect(fractionAt(500, 100, 200)).toBe(1);
    expect(fractionAt(150, 100, 0)).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { adjacentMarker, markerTimes, ON_MARKER } from "./markers";

describe("markerTimes", () => {
  it("merges comment markers and findings, earliest first, each moment once", () => {
    expect(markerTimes([12, 3.5], [3.5, 40, 0])).toEqual([0, 3.5, 12, 40]);
  });

  it("leaves out moments that are not on the timeline", () => {
    expect(markerTimes([Number.NaN, -1, Number.POSITIVE_INFINITY, 2])).toEqual([2]);
  });

  it("is empty with nothing marked", () => {
    expect(markerTimes()).toEqual([]);
    expect(markerTimes([], [])).toEqual([]);
  });
});

describe("adjacentMarker", () => {
  const times = [3.5, 12, 40];

  it("finds the next marker after the playhead", () => {
    expect(adjacentMarker(times, 0, 1)).toBe(3.5);
    expect(adjacentMarker(times, 20, 1)).toBe(40);
  });

  it("finds the previous marker before the playhead", () => {
    expect(adjacentMarker(times, 20, -1)).toBe(12);
    expect(adjacentMarker(times, 100, -1)).toBe(40);
  });

  it("passes over the marker the playhead is on, so each press moves on", () => {
    expect(adjacentMarker(times, 12, 1)).toBe(40);
    expect(adjacentMarker(times, 12, -1)).toBe(3.5);
    // A seek lands a little off the marker; that still counts as on it.
    expect(adjacentMarker(times, 12 + ON_MARKER / 2, -1)).toBe(3.5);
    expect(adjacentMarker(times, 12 - ON_MARKER / 2, 1)).toBe(40);
  });

  it("goes back to a marker the playhead has played past", () => {
    expect(adjacentMarker(times, 12.5, -1)).toBe(12);
  });

  it("is null past the last marker, before the first, or with none", () => {
    expect(adjacentMarker(times, 40, 1)).toBeNull();
    expect(adjacentMarker(times, 3.5, -1)).toBeNull();
    expect(adjacentMarker([], 10, 1)).toBeNull();
    expect(adjacentMarker([], 10, -1)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { barNumbersOf, movedToBar, type PrintedBar, placeOfBar } from "./score-bars.ts";

const at = (page: number, y: number, x: number, bar: number): PrintedBar => ({ page, x, y, bar });

describe("barNumbersOf", () => {
  it("keeps the numbers that rise through the score, system by system", () => {
    const printed = [
      // Page 1: its page number at the foot, a fingering, then a number at each system.
      at(1, 0.97, 0.5, 1),
      at(1, 0.3, 0.05, 5),
      at(1, 0.32, 0.4, 3),
      at(1, 0.55, 0.05, 9),
      at(1, 0.6, 0.6, 2),
      at(1, 0.8, 0.05, 13),
      // Page 2: its page number at the top, a tuplet, and the systems going on.
      at(2, 0.02, 0.5, 2),
      at(2, 0.1, 0.05, 17),
      at(2, 0.12, 0.3, 3),
      at(2, 0.35, 0.05, 21),
      at(2, 0.6, 0.05, 25),
    ];
    expect(barNumbersOf(printed).map((b) => b.bar)).toEqual([5, 9, 13, 17, 21, 25]);
  });

  it("reads down the page before across, a line at a time", () => {
    const printed = [at(1, 0.5, 0.05, 9), at(1, 0.2, 0.6, 7), at(1, 0.21, 0.05, 5)];
    expect(barNumbersOf(printed).map((b) => b.bar)).toEqual([5, 7, 9]);
  });

  it("takes system numbers over a run of fingerings that also rises", () => {
    const printed = [
      ...[1, 2, 3, 4, 5].map((n, i) => at(1, 0.2, 0.3 + i * 0.05, n)),
      at(1, 0.4, 0.06, 9),
      at(1, 0.6, 0.06, 13),
      at(1, 0.8, 0.06, 17),
    ];
    expect(barNumbersOf(printed).map((b) => b.bar)).toEqual([9, 13, 17]);
  });

  it("reads every number when a score numbers its bars along the systems", () => {
    const printed = [at(1, 0.2, 0.5, 5), at(1, 0.4, 0.3, 10), at(1, 0.6, 0.7, 15)];
    expect(barNumbersOf(printed).map((b) => b.bar)).toEqual([5, 10, 15]);
  });

  it("trusts nothing from too few numbers", () => {
    expect(barNumbersOf([at(1, 0.3, 0.05, 5), at(1, 0.6, 0.05, 9)])).toEqual([]);
    expect(barNumbersOf([])).toEqual([]);
  });
});

describe("placeOfBar", () => {
  const known = [at(1, 0.3, 0.05, 5), at(1, 0.55, 0.05, 9), at(2, 0.1, 0.05, 17)];

  it("finds a bar at the last number at or before it", () => {
    expect(placeOfBar(known, 9)).toEqual({ page: 1, y: 0.55, from: 9 });
    expect(placeOfBar(known, 12)).toEqual({ page: 1, y: 0.55, from: 9 });
    expect(placeOfBar(known, 40)).toEqual({ page: 2, y: 0.1, from: 17 });
  });

  it("puts the bars before the first number on its page, at the top", () => {
    expect(placeOfBar(known, 1)).toEqual({ page: 1, y: 0, from: null });
  });

  it("knows nothing without bars", () => {
    expect(placeOfBar([], 12)).toBeNull();
  });
});

describe("movedToBar", () => {
  // The old edition: four bars a system. The new: six, so bar 21 moves to page 1.
  const old = [
    at(1, 0.3, 0.05, 5),
    at(1, 0.55, 0.05, 9),
    at(2, 0.1, 0.05, 17),
    at(2, 0.35, 0.05, 21),
  ];
  const engraved = [
    at(1, 0.2, 0.05, 7),
    at(1, 0.45, 0.05, 13),
    at(1, 0.7, 0.05, 19),
    at(2, 0.1, 0.05, 25),
  ];

  it("carries a mark to its bar, as far from its system's number as it was", () => {
    // Bar 21's system starts at 0.35 on page 2; the mark sat 0.05 below it.
    expect(movedToBar(old, engraved, 21, { page: 2, y: 0.4 })).toEqual({ page: 1, y: 0.75 });
  });

  it("puts a mark on its system when it was far from it, or on another page", () => {
    expect(movedToBar(old, engraved, 9, { page: 2, y: 0.9 })).toEqual({ page: 1, y: 0.2 });
    const far = movedToBar(old, engraved, 5, { page: 1, y: 0.95 });
    expect(far?.y).toBeCloseTo(0.25, 9);
  });

  it("moves nothing when either edition has no bars to go by", () => {
    expect(movedToBar([], engraved, 9, { page: 1, y: 0.5 })).toBeNull();
    expect(movedToBar(old, [], 9, { page: 1, y: 0.5 })).toBeNull();
  });
});

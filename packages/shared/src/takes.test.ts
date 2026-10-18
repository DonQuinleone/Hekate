import { describe, expect, it } from "vitest";
import {
  barSpan,
  barsLabel,
  clockOf,
  coverageGaps,
  covers,
  gapsLabel,
  parseClock,
  takeChangeInput,
  takeProblem,
  takesCovering,
} from "./takes.ts";

const take = (number: number, barFrom: number | null, barTo: number | null, extra = {}) => ({
  number,
  barFrom,
  barTo,
  starred: false,
  rating: 0,
  ...extra,
});

describe("takes and their bars", () => {
  it("covers its range, or its one bar", () => {
    expect(covers(take(1, 64, 88), 72)).toBe(true);
    expect(covers(take(1, 64, 88), 89)).toBe(false);
    expect(covers(take(1, 12, null), 12)).toBe(true);
    expect(covers(take(1, null, null), 1)).toBe(false);
    expect(barsLabel(take(1, 64, 88))).toBe("bars 64 to 88");
    expect(barsLabel(take(1, 12, null))).toBe("bar 12");
    expect(barsLabel(take(1, null, null))).toBeNull();
  });

  it("lists the takes for a bar, circled and best first", () => {
    const all = [
      take(1, 60, 80, { rating: 3 }),
      take(2, 70, 90, { rating: 5 }),
      take(3, 72, 72, { starred: true, rating: 2 }),
      take(4, 1, 40, { rating: 5 }),
      take(5, 65, 75, { rating: 3 }),
    ];
    expect(takesCovering(all, 72).map((t) => t.number)).toEqual([3, 2, 1, 5]);
    expect(takesCovering(all, 95)).toEqual([]);
  });

  it("finds the bars no take covers", () => {
    expect(coverageGaps([])).toEqual([]);
    expect(coverageGaps([take(1, 1, 16), take(2, 17, 32)])).toEqual([]);
    expect(coverageGaps([take(1, 5, 10), take(2, 15, 20), take(3, null, null)])).toEqual([
      [1, 4],
      [11, 14],
    ]);
    expect(coverageGaps([take(1, 0, 8)])).toEqual([]);
    expect(gapsLabel([[33, 40]])).toBe("bars 33 to 40");
    expect(gapsLabel([[52, 52]])).toBe("bar 52");
    expect(
      gapsLabel([
        [9, 12],
        [20, 20],
        [33, 40],
      ]),
    ).toBe("bars 9 to 12, 20 and 33 to 40");
  });

  it("refuses bars and points in the wrong order", () => {
    const place = { barFrom: null, barTo: null, inPoint: null, outPoint: null };
    expect(takeProblem(place)).toBeNull();
    expect(takeProblem({ ...place, barFrom: 9, barTo: 4 })).toMatch(/last bar/);
    expect(takeProblem({ ...place, barTo: 4 })).toMatch(/first bar/);
    expect(takeProblem({ ...place, inPoint: 30, outPoint: 12 })).toMatch(/out point/);
    expect(takeChangeInput.safeParse({ rating: 6 }).success).toBe(false);
    expect(takeChangeInput.safeParse({ barFrom: -1 }).success).toBe(false);
    expect(takeChangeInput.safeParse({ notes: "Lovely rubato", starred: true }).success).toBe(true);
  });

  it("reads and writes in and out points as a clock", () => {
    expect(parseClock("92.5")).toBe(92.5);
    expect(parseClock("1:32.5")).toBe(92.5);
    expect(parseClock(" 1:02:03 ")).toBe(3723);
    expect(parseClock("1:75")).toBeNull();
    expect(parseClock("1.5:20")).toBeNull();
    expect(parseClock("soon")).toBeNull();
    expect(parseClock("")).toBeNull();
    expect(clockOf(92.5)).toBe("1:32.5");
    expect(clockOf(92)).toBe("1:32");
    expect(clockOf(3723.04)).toBe("1:02:03");
    expect(parseClock(clockOf(61.25))).toBe(61.3);
  });
});

describe("a bar in a take", () => {
  const take = { barFrom: 9, barTo: 16, inPoint: 2, outPoint: 18, duration: 20 };
  it("lies where the take's bars spread evenly over its in and out points", () => {
    expect(barSpan(take, 9)).toEqual([2, 4]);
    expect(barSpan(take, 16)).toEqual([16, 18]);
    // Without in and out points, over the whole file.
    expect(barSpan({ ...take, inPoint: null, outPoint: null }, 10)).toEqual([2.5, 5]);
    // One bar given: the take is that bar.
    expect(barSpan({ ...take, barTo: null }, 9)).toEqual([2, 18]);
  });
  it("cannot be said outside the take's bars or without its length", () => {
    expect(barSpan(take, 8)).toBeNull();
    expect(barSpan(take, 17)).toBeNull();
    expect(barSpan({ ...take, outPoint: null, duration: null }, 9)).toBeNull();
    expect(barSpan({ ...take, barFrom: null, barTo: null }, 9)).toBeNull();
  });
});

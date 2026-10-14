import { describe, expect, it } from "vitest";
import { invertAlignment, mapTime, simplifyAlignment } from "./alignment.ts";

describe("alignment maps", () => {
  // Version 2 adds 4 seconds at 10 s: before it, the same; after it, 4 s later.
  const map: [number, number][] = [
    [0, 0],
    [10, 10],
    [10.1, 14.1],
    [60, 64],
  ];

  it("maps a time through the pairs, and carries on beyond them", () => {
    expect(mapTime(map, 5)).toBe(5);
    expect(mapTime(map, 30)).toBeCloseTo(34, 6);
    expect(mapTime(map, 70)).toBe(74);
    expect(mapTime([], 12)).toBe(12);
    expect(mapTime([[2, 3]], 5)).toBe(6);
  });

  it("reads the other way round", () => {
    const back = invertAlignment(map);
    expect(mapTime(back, 34)).toBeCloseTo(30, 6);
  });

  it("keeps only the pairs that bend the line", () => {
    const dense: [number, number][] = [];
    for (let t = 0; t <= 60; t += 0.5) dense.push([t, t < 10 ? t : t + 4]);
    const simple = simplifyAlignment(dense, 0.01);
    expect(simple.length).toBeLessThanOrEqual(4);
    for (const [a, b] of dense) expect(mapTime(simple, a)).toBeCloseTo(b, 1);
  });
});

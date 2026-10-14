import { describe, expect, it } from "vitest";
import {
  composeAlignments,
  invertAlignment,
  mapTime,
  remapAnchor,
  simplifyAlignment,
} from "./alignment.ts";

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

  it("simplifies a long straight run in one pass", () => {
    const long: [number, number][] = [];
    for (let t = 0; t <= 36_000; t += 0.1) long.push([t, t + 1.5]);
    const started = Date.now();
    expect(simplifyAlignment(long, 0.02)).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("follows one alignment with another", () => {
    // V1 to V2: 4 s added at 10 s. V2 to V3: 2 s cut at 30 s.
    const v1v2: [number, number][] = [
      [0, 0],
      [10, 10],
      [10.1, 14.1],
      [60, 64],
    ];
    const v2v3: [number, number][] = [
      [0, 0],
      [30, 30],
      [30.1, 28.1],
      [64, 62],
    ];
    const v1v3 = composeAlignments(v1v2, v2v3);
    expect(mapTime(v1v3, 5)).toBeCloseTo(5, 1);
    expect(mapTime(v1v3, 20)).toBeCloseTo(24, 1);
    expect(mapTime(v1v3, 40)).toBeCloseTo(42, 1);
  });
});

describe("remapAnchor", () => {
  const later: [number, number][] = [
    [0, 1.5],
    [10, 11.5],
  ];
  it("moves times, and the moment a bar was named, with the music", () => {
    expect(remapAnchor(later, { kind: "time", start: 2, end: 3 })).toEqual({
      kind: "time",
      start: 3.5,
      end: 4.5,
    });
    expect(remapAnchor(later, { kind: "bar", from: { bar: 9, beat: 1 }, at: 4 })).toEqual({
      kind: "bar",
      from: { bar: 9, beat: 1 },
      at: 5.5,
    });
  });
  it("leaves anchors without a time in the recording", () => {
    expect(remapAnchor(later, { kind: "bar", from: { bar: 9, beat: 1 } })).toBeNull();
    expect(remapAnchor(later, null)).toBeNull();
  });
});

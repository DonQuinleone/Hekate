import { describe, expect, it } from "vitest";
import {
  type BarMap,
  barAt,
  barLabel,
  barMapInput,
  formBars,
  parseBarLabels,
  parseForm,
  pointsFromTaps,
  repeatsAt,
  rulerBars,
  timeOfBar,
} from "./bars.ts";

// 2/4, a bar every second from 1 s; bars 1 and 2 are repeated before bar 3.
const map: BarMap = {
  beatsPerBar: 2,
  points: [
    [1, 1],
    [2, 2],
    [3, 1],
    [4, 2],
    [5, 3],
  ],
};

describe("bar maps", () => {
  it("accepts barlines in time, and nothing else", () => {
    expect(barMapInput.safeParse(map).success).toBe(true);
    expect(
      barMapInput.safeParse({
        beatsPerBar: 4,
        points: [
          [2, 1],
          [1, 2],
        ],
      }).success,
    ).toBe(false);
    expect(barMapInput.safeParse({ beatsPerBar: 0, points: [[0, 1]] }).success).toBe(false);
  });

  it("finds the bar and beat at a moment, repeats and all", () => {
    expect(barAt(map, 0.5)).toBeNull();
    expect(barAt(map, 1)).toEqual({ bar: 1, beat: 1, index: 0 });
    expect(barAt(map, 1.5)).toEqual({ bar: 1, beat: 2, index: 0 });
    // The second time through bar 1.
    expect(barAt(map, 3.25)).toMatchObject({ bar: 1, index: 2 });
    // Past the last barline, the last bar lasts as long as the one before.
    expect(barAt(map, 5.5)).toMatchObject({ bar: 3, beat: 2 });
    expect(barAt(map, 9)?.bar).toBe(3);
  });

  it("finds when a bar is first heard", () => {
    expect(timeOfBar(map, 2)).toBe(2);
    expect(timeOfBar(map, 1, 2)).toBe(1.5);
    expect(timeOfBar(map, 3)).toBe(5);
    expect(timeOfBar(map, 7)).toBeNull();
  });

  it("reads like the score", () => {
    expect(barLabel({ bar: 12, beat: 1.4 })).toBe("Bar 12");
    expect(barLabel({ bar: 12, beat: 2.9 })).toBe("Bar 12.2");
  });

  it("reads a form as a musician writes it", () => {
    expect(parseForm("1-16, 1-16, 17-32")).toEqual([
      { from: 1, to: 16 },
      { from: 1, to: 16 },
      { from: 17, to: 32 },
    ]);
    expect(parseForm("0, 1–4; 5-")).toEqual([
      { from: 0, to: 0 },
      { from: 1, to: 4 },
      { from: 5, to: null },
    ]);
    expect(parseForm("1-4, eight")).toBeNull();
    expect(parseForm("9-4")).toBeNull();
    expect(parseForm("")).toBeNull();
  });

  it("numbers barlines by the form, and on by one past its end", () => {
    const form = parseForm("1-2, 1-2, 3") ?? [];
    expect(formBars(form, 7)).toEqual([1, 2, 1, 2, 3, 4, 5]);
    expect(formBars(parseForm("17-") ?? [], 3)).toEqual([17, 18, 19]);
  });

  it("turns taps into barlines, numbered by the form, and drops bounces", () => {
    const form = parseForm("0, 1-2, 1-2, 3-") ?? [];
    expect(pointsFromTaps([0.4, 1.0, 1.02, 2.0, 3.0, 4.0, 5.0, 6.0], form)).toEqual([
      [0.4, 0],
      [1, 1],
      [2, 2],
      [3, 1],
      [4, 2],
      [5, 3],
      [6, 4],
    ]);
  });

  it("reads Audacity and Sonic Visualiser labels", () => {
    expect(parseBarLabels("1.0\t1.0\t1\n2.5\t2.5\tBar 2\n\nnot a line")).toEqual([
      [1, 1],
      [2.5, 2],
    ]);
    expect(parseBarLabels("3.2,4\n1.1,3")).toEqual([
      [1.1, 3],
      [3.2, 4],
    ]);
    expect(parseBarLabels("nothing here")).toBeNull();
  });

  it("numbers a ruler without crowding it", () => {
    const long: BarMap = {
      beatsPerBar: 4,
      points: Array.from({ length: 200 }, (_, i) => [i * 2, i + 1] as [number, number]),
    };
    // 200 bars across 400 px: 2 px a bar, so every 16th bar is numbered.
    const shown = rulerBars(long, 400, 400);
    expect(shown[0]).toBe(0);
    expect(
      shown
        .slice(1)
        .every(
          (i) => (long.points[i]?.[1] ?? 1) % 32 === 0 || (long.points[i]?.[1] ?? 1) % 16 === 0,
        ),
    ).toBe(true);
    // Never two numbers closer than the gap.
    for (const [k, i] of shown.entries()) {
      if (k > 0) expect(i - (shown[k - 1] ?? 0)).toBeGreaterThanOrEqual(16);
    }
    expect(rulerBars(long, 400, 20_000)).toHaveLength(200);
  });

  it("numbers where the music goes back, and marks it", () => {
    // 1-8, then 1-8 again, then 9-16: a bar a second, 24 s over 480 px (20 px a bar).
    const bars = [1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
    const form: BarMap = { beatsPerBar: 2, points: bars.map((b, i) => [i, b] as [number, number]) };
    expect(repeatsAt(form)).toEqual([8]);
    const shown = rulerBars(form, 24, 480).map((i) => form.points[i]?.[1]);
    // Every 2nd bar, 40 px apart, kept 32 px from the number before: bar 2 is too close to
    // bar 1, and the repeat back to bar 1 takes the place of the bar 8 just before it.
    expect(shown).toEqual([1, 4, 6, 1, 4, 6, 8, 10, 12, 14, 16]);
  });
});

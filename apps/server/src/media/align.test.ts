import { mapTime } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { ALIGN_SAMPLE_RATE, alignAudio } from "./align.ts";

/** A repeatable stand-in for music: a few seconds each of distinct chords with some noise. */
function segment(seed: number, seconds: number, gain = 1): Float32Array {
  let state = seed * 7919 + 1;
  const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const freqs = [0, 1, 2].map(() => 110 * 2 ** (random() * 4));
  const out = new Float32Array(Math.round(seconds * ALIGN_SAMPLE_RATE));
  for (let i = 0; i < out.length; i++) {
    const t = i / ALIGN_SAMPLE_RATE;
    let v = 0;
    for (const f of freqs) v += Math.sin(2 * Math.PI * f * t);
    out[i] = gain * (0.2 * v + 0.02 * (random() - 0.5));
  }
  return out;
}
const join = (parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

describe("aligning versions", () => {
  it("follows the music across an insertion and a cut, whatever the level", () => {
    // Version 1: ten two-second passages. Version 2: three new seconds after the fourth,
    // the seventh cut, everything 6 dB quieter.
    const passages = Array.from({ length: 10 }, (_, k) => k);
    const v1 = join(passages.map((k) => segment(k, 2)));
    const v2 = join([
      ...passages.slice(0, 4).map((k) => segment(k, 2, 0.5)),
      segment(99, 3, 0.5),
      ...passages
        .slice(4)
        .filter((k) => k !== 6)
        .map((k) => segment(k, 2, 0.5)),
    ]);
    const { points, quality } = alignAudio(v1, v2);
    expect(quality).toBeGreaterThan(0.7);
    // Before the insertion, the same; after it, three seconds later; after the cut, one earlier.
    expect(mapTime(points, 3)).toBeCloseTo(3, 0);
    expect(mapTime(points, 11)).toBeGreaterThan(13.6);
    expect(mapTime(points, 11)).toBeLessThan(14.4);
    expect(mapTime(points, 17)).toBeGreaterThan(17.6);
    expect(mapTime(points, 17)).toBeLessThan(18.4);
  });

  it("keeps identical versions in step", () => {
    const v = join([0, 1, 2, 3].map((k) => segment(k, 2)));
    const { points, quality } = alignAudio(v, v);
    expect(quality).toBeGreaterThan(0.95);
    for (const t of [0.5, 3, 7.5]) expect(mapTime(points, t)).toBeCloseTo(t, 1);
  });
});

import { describe, expect, it } from "vitest";
import {
  coarsen,
  combineChannels,
  decodePeaks,
  encodePeaks,
  levelFor,
  OVERVIEW_PEAKS,
  type PeakLevel,
  peakLevels,
} from "./peaks.ts";

const level = (channels: number, pairs: [number, number][]): PeakLevel => ({
  channels,
  sampleRate: 48000,
  samplesPerPeak: 256,
  count: pairs.length / channels,
  data: Int8Array.from(pairs.flat()),
});

describe("peaks", () => {
  it("round-trips through the binary format and refuses anything else", () => {
    const stereo = level(2, [
      [-10, 20],
      [-5, 5],
      [-128, 127],
      [0, 1],
    ]);
    const decoded = decodePeaks(encodePeaks(stereo));
    expect(decoded).toEqual(stereo);
    expect(() => decodePeaks(new Uint8Array([1, 2, 3]))).toThrow(/Not a peaks file/);
    expect(() => decodePeaks(encodePeaks(stereo).slice(0, -1))).toThrow(/Truncated/);
  });

  it("merges peaks per channel into coarser levels", () => {
    const stereo = level(2, [
      [-1, 1],
      [-50, 2],
      [-3, 3],
      [-4, 90],
      [-5, 5],
      [-6, 6],
    ]);
    const coarse = coarsen(stereo, 2);
    expect(coarse.samplesPerPeak).toBe(512);
    expect(coarse.count).toBe(2);
    expect(Array.from(coarse.data)).toEqual([-3, 3, -50, 90, -5, 5, -6, 6]);
  });

  it("builds levels down to an overview and picks one for a width", () => {
    const count = OVERVIEW_PEAKS * 20;
    const long: PeakLevel = {
      channels: 1,
      sampleRate: 48000,
      samplesPerPeak: 256,
      count,
      data: new Int8Array(count * 2),
    };
    const levels = peakLevels(long);
    expect(levels.map((l) => l.samplesPerPeak)).toEqual([256, 1024, 4096, 16384]);
    expect(levels.at(-1)?.count).toBeLessThanOrEqual(OVERVIEW_PEAKS);
    expect(levelFor(levels, 1000)?.samplesPerPeak).toBe(16384);
    expect(levelFor(levels, 3000)?.samplesPerPeak).toBe(4096);
    expect(levelFor(levels, 10_000)?.samplesPerPeak).toBe(1024);
    expect(levelFor(levels, 10_000_000)?.samplesPerPeak).toBe(256);
  });

  it("combines channels into one envelope of their extremes", () => {
    const surround = level(3, [
      [-1, 1],
      [-9, 2],
      [-3, 70],
    ]);
    expect(Array.from(combineChannels(surround).data)).toEqual([-9, 70]);
  });
});

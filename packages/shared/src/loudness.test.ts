import { describe, expect, it } from "vitest";
import {
  channelLevels,
  decodeLoudness,
  encodeLoudness,
  frameAt,
  highest,
  type LoudnessSeries,
  linearToDb,
  SILENCE,
} from "./loudness.ts";

const series = (hasPhase: boolean, hasMidSide = hasPhase): LoudnessSeries => ({
  channels: 2,
  sampleRate: 48_000,
  samplesPerFrame: 4_800,
  count: 3,
  hasPhase,
  momentary: Float32Array.from([SILENCE, -23.4, -14.07]),
  shortTerm: Float32Array.from([SILENCE, SILENCE, -18.5]),
  peak: Float32Array.from([-60, -61, -6.02, -12, -0.5, Number.NEGATIVE_INFINITY]),
  rms: Float32Array.from([-70, -71, -20, -26, -9, -500]),
  phase: hasPhase ? Float32Array.from([1, 0.5, -0.25]) : new Float32Array(0),
  hasMidSide,
  mid: hasMidSide ? Float32Array.from([SILENCE, -26.5, -12.25]) : new Float32Array(0),
  side: hasMidSide ? Float32Array.from([SILENCE, -40, -500]) : new Float32Array(0),
});

describe("loudness series", () => {
  it("round-trips to hundredths, with and without phase", () => {
    for (const hasPhase of [true, false]) {
      const decoded = decodeLoudness(encodeLoudness(series(hasPhase)));
      expect(decoded.hasPhase).toBe(hasPhase);
      expect(Array.from(decoded.momentary)).toEqual([SILENCE, -23.4, -14.07].map(Math.fround));
      // Silence and anything below it clamp to the floor.
      expect(Array.from(decoded.peak)).toEqual(
        [-60, -61, -6.02, -12, -0.5, SILENCE].map(Math.fround),
      );
      expect(decoded.rms[5]).toBe(SILENCE);
      expect(Array.from(decoded.phase)).toEqual(hasPhase ? [1, 0.5, -0.25] : []);
      expect(decoded.hasMidSide).toBe(hasPhase);
      expect(Array.from(decoded.mid)).toEqual(
        hasPhase ? [SILENCE, -26.5, -12.25].map(Math.fround) : [],
      );
      expect(Array.from(decoded.side)).toEqual(hasPhase ? [SILENCE, -40, SILENCE] : []);
    }
  });

  it("reads a file measured before mid and side were kept", () => {
    const decoded = decodeLoudness(encodeLoudness(series(true, false)));
    expect(decoded.hasPhase).toBe(true);
    expect(decoded.hasMidSide).toBe(false);
    expect(decoded.mid.length).toBe(0);
    expect(Array.from(decoded.phase)).toEqual([1, 0.5, -0.25]);
  });

  it("rejects what is not a whole loudness file", () => {
    const bytes = encodeLoudness(series(true));
    expect(() => decodeLoudness(bytes.subarray(0, bytes.length - 2))).toThrow(/Truncated/);
    expect(() => decodeLoudness(new Uint8Array(24))).toThrow(/Not a loudness/);
  });

  it("finds the frame for a moment of playback", () => {
    const s = series(false);
    expect(frameAt(s, 0)).toBe(0);
    expect(frameAt(s, 0.15)).toBe(1);
    expect(frameAt(s, 0.3)).toBeNull();
    expect(frameAt(s, -1)).toBeNull();
  });

  it("summarises each channel over the file", () => {
    const [left, right] = channelLevels(series(false));
    expect(left?.samplePeak).toBeCloseTo(-0.5, 5);
    // Power average of -70, -20 and -9 dB.
    const expected = 10 * Math.log10((10 ** -7 + 10 ** -2 + 10 ** -0.9) / 3);
    expect(left?.rms).toBeCloseTo(expected, 4);
    expect(right?.samplePeak).toBeCloseTo(-12, 5);
    expect(highest(series(false).shortTerm)).toBeCloseTo(-18.5, 5);
    expect(highest(Float32Array.from([SILENCE]))).toBeNull();
    expect(linearToDb(0.5)).toBeCloseTo(-6.0206, 3);
    expect(linearToDb(0)).toBeNull();
  });
});

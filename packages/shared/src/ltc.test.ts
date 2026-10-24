import { describe, expect, it } from "vitest";
import { frameRates } from "./comment-export.ts";
import { decodeLtc, initialLtcState, type LtcFrame } from "./ltc.ts";
import {
  addFrames,
  parseTimecodeLabel,
  type RecorderTimecode,
  timecodeLabel,
} from "./recorders.ts";

/** A frame's 80 bits, as SMPTE 12M lays them out. */
function frameBits(tc: RecorderTimecode): number[] {
  const bits = new Array(80).fill(0);
  const put = (from: number, count: number, value: number) => {
    for (let i = 0; i < count; i++) bits[from + i] = (value >> i) & 1;
  };
  put(0, 4, tc.frames % 10);
  put(8, 2, Math.floor(tc.frames / 10));
  bits[10] = frameRates[tc.rate].drop ? 1 : 0;
  put(16, 4, tc.seconds % 10);
  put(24, 3, Math.floor(tc.seconds / 10));
  put(32, 4, tc.minutes % 10);
  put(40, 3, Math.floor(tc.minutes / 10));
  put(48, 4, tc.hours % 10);
  put(56, 2, Math.floor(tc.hours / 10));
  // User bits, which the reader passes over.
  put(4, 4, 0b1010);
  put(36, 4, 0b0110);
  [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1].forEach((b, i) => {
    bits[64 + i] = b;
  });
  return bits;
}

/**
 * LTC as a recorder's timecode out sends it: biphase mark, with edges that take a few samples
 * to rise, a little noise, and the level and way up chosen. Frames follow on from `from`.
 */
function ltcSignal(
  from: RecorderTimecode,
  count: number,
  sampleRate: number,
  options: { level?: number; invert?: boolean; noise?: number; hold?: boolean } = {},
): Float32Array {
  const rate = frameRates[from.rate];
  const fps = rate.num / rate.den;
  const bitLength = sampleRate / (80 * fps);
  const total = Math.ceil(bitLength * 80 * count) + 200;
  const out = new Float32Array(total);
  const level = options.level ?? 0.5;
  // Silence first, as an input has before the recorder is plugged in.
  let level0 = options.invert ? -1 : 1;
  const edges: number[] = [];
  let t = 100;
  let tc = from;
  for (let f = 0; f < count; f++) {
    for (const bit of frameBits(tc)) {
      edges.push(t);
      if (bit) edges.push(t + bitLength / 2);
      t += bitLength;
    }
    if (!options.hold) tc = addFrames(tc, 1);
  }
  edges.push(t);
  let next = 0;
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647 - 0.5;
  };
  for (let i = 0; i < total; i++) {
    while (next < edges.length && (edges[next] ?? Infinity) <= i) {
      level0 = -level0;
      next++;
    }
    if (i < 100 || i > t + bitLength) {
      out[i] = (options.noise ?? 0.002) * random();
      continue;
    }
    // A rise over about 25 microseconds, as the standard allows.
    const since = i - (edges[next - 1] ?? 0);
    const rise = Math.min(1, since / Math.max(1, sampleRate * 25e-6));
    out[i] = level * level0 * (2 * rise - 1) + (options.noise ?? 0.002) * random();
  }
  return out;
}

/** Everything a signal decodes to, taken in a chunk at a time of the sizes given. */
function decodeAll(signal: Float32Array, sampleRate: number, chunk = 128) {
  let state = initialLtcState(sampleRate);
  const frames: LtcFrame[] = [];
  for (let i = 0; i < signal.length; i += chunk) {
    const step = decodeLtc(state, signal.subarray(i, i + chunk));
    state = step.state;
    frames.push(...step.frames);
  }
  return { state, frames };
}

const tc = (label: string, rate: RecorderTimecode["rate"]) =>
  parseTimecodeLabel(label, rate) as RecorderTimecode;

describe("decodeLtc", () => {
  it("reads every frame of a 25 fps signal, in order, and says it runs", () => {
    const { frames } = decodeAll(ltcSignal(tc("10:00:00:00", "25"), 50, 48_000), 48_000);
    expect(frames).toHaveLength(50);
    expect(timecodeLabel(frames[0]?.timecode as RecorderTimecode)).toBe("10:00:00:00");
    expect(timecodeLabel(frames.at(-1)?.timecode as RecorderTimecode)).toBe("10:00:01:24");
    expect(frames.slice(1).every((f) => f.advancing)).toBe(true);
    expect(frames.every((f) => f.timecode.rate === "25")).toBe(true);
  });

  it("tells each rate from how often frames arrive, and drop frame from its flag", () => {
    for (const rate of ["24", "25", "30", "23.976", "29.97"] as const) {
      const { frames } = decodeAll(ltcSignal(tc("01:00:00:00", rate), 40, 48_000), 48_000);
      expect(frames.at(-1)?.timecode.rate, rate).toBe(rate);
    }
    const { frames } = decodeAll(ltcSignal(tc("01:00:59;28", "29.97df"), 6, 48_000), 48_000);
    expect(frames.map((f) => timecodeLabel(f.timecode))).toEqual([
      "01:00:59;28",
      "01:00:59;29",
      "01:01:00;02",
      "01:01:00;03",
      "01:01:00;04",
      "01:01:00;05",
    ]);
  });

  it("reads a quiet input, one upside down, at 44.1 kHz, in chunks of any size", () => {
    const signal = ltcSignal(tc("23:59:59:20", "25"), 10, 44_100, { level: 0.05, invert: true });
    const { frames } = decodeAll(signal, 44_100, 37);
    expect(frames.map((f) => timecodeLabel(f.timecode))).toContain("00:00:00:02");
    expect(frames).toHaveLength(10);
  });

  it("says when the timecode holds still rather than running", () => {
    const { frames } = decodeAll(
      ltcSignal(tc("10:00:00:00", "25"), 5, 48_000, { hold: true }),
      48_000,
    );
    expect(frames).toHaveLength(5);
    expect(frames.some((f) => f.advancing)).toBe(false);
  });

  it("reads nothing from noise or silence", () => {
    const noise = new Float32Array(48_000).map((_, i) => Math.sin(i * 0.37) * 0.003);
    expect(decodeAll(noise, 48_000).frames).toEqual([]);
    expect(decodeAll(new Float32Array(48_000), 48_000).frames).toEqual([]);
  });

  it("gives the samples each frame began and ended at, a frame's length apart", () => {
    const { frames } = decodeAll(ltcSignal(tc("10:00:00:00", "25"), 3, 48_000), 48_000);
    expect(frames[0]?.start).toBeCloseTo(100, -1);
    expect((frames[1]?.start ?? 0) - (frames[0]?.start ?? 0)).toBeCloseTo(1920, -1);
    expect(frames[0]?.end).toBeCloseTo(frames[1]?.start ?? 0, -1);
  });

  it("starts over after the signal stops, rather than joining two runs", () => {
    const a = ltcSignal(tc("10:00:00:00", "25"), 5, 48_000);
    const gap = new Float32Array(4800);
    const b = ltcSignal(tc("11:00:00:00", "25"), 5, 48_000);
    const joined = new Float32Array(a.length + gap.length + b.length);
    joined.set(a);
    joined.set(b, a.length + gap.length);
    const { frames } = decodeAll(joined, 48_000);
    expect(frames.map((f) => timecodeLabel(f.timecode))).toEqual([
      "10:00:00:00",
      "10:00:00:01",
      "10:00:00:02",
      "10:00:00:03",
      "10:00:00:04",
      "11:00:00:00",
      "11:00:00:01",
      "11:00:00:02",
      "11:00:00:03",
      "11:00:00:04",
    ]);
    expect(frames[5]?.advancing).toBe(false);
  });
});

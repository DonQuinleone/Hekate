import { z } from "zod";

/**
 * Loudness and level over time, measured once per file by the media worker (EBU R 128 /
 * ITU-R BS.1770, with surround channels weighted and LFE excluded by the standard). Like
 * peaks, these are numbers about the audio from which no audio can be rebuilt.
 *
 * The series holds one frame every `samplesPerFrame` samples (100 ms): momentary and
 * short-term loudness, each channel's sample peak and RMS, and the phase correlation and the
 * mid and side levels of the front pair. Binary layout, little-endian: the magic `HKLD`,
 * version (u8), channels (u8), flags (u8, bit 0: phase present, bit 1: mid and side
 * present), a reserved byte, sample rate (u32), samples per frame (u32), frame count (u32),
 * then for every frame signed 16-bit values: momentary and short-term in hundredths of a
 * LUFS, each channel's peak and RMS in hundredths of a dBFS, the phase correlation in
 * ten-thousandths, if present, and the mid and side RMS in hundredths of a dBFS, if present.
 * Files measured before mid and side were added have only the phase.
 */

export interface LoudnessSeries {
  channels: number;
  sampleRate: number;
  samplesPerFrame: number;
  count: number;
  hasPhase: boolean;
  /** Per frame, in LUFS; `SILENCE` where nothing is measured yet or nothing is there. */
  momentary: Float32Array;
  shortTerm: Float32Array;
  /** `count × channels`, in dBFS, `SILENCE` for digital silence. */
  peak: Float32Array;
  rms: Float32Array;
  /** Per frame, -1 (out of phase) to 1 (mono); empty without a pair of channels. */
  phase: Float32Array;
  hasMidSide: boolean;
  /** Per frame, the RMS of the front pair's sum and difference, (L+R)/2 and (L−R)/2, in dBFS. */
  mid: Float32Array;
  side: Float32Array;
}

/** Anything at or below this is shown as silence. */
export const SILENCE = -120;
/** About 100 ms a frame, whatever the sample rate. */
export const framesPerSecond = 10;
export const samplesPerFrameAt = (sampleRate: number) =>
  Math.max(1, Math.round(sampleRate / framesPerSecond));

const MAGIC = [0x48, 0x4b, 0x4c, 0x44];
const VERSION = 1;
const HEADER = 20;

const valuesPerFrame = (channels: number, hasPhase: boolean, hasMidSide: boolean) =>
  2 + channels * 2 + (hasPhase ? 1 : 0) + (hasMidSide ? 2 : 0);

/** A level in dB to hundredths, clamped to the range a 16-bit value holds. */
const centi = (db: number) =>
  Number.isFinite(db) ? Math.round(Math.max(SILENCE, Math.min(300, db)) * 100) : SILENCE * 100;

export function encodeLoudness(series: LoudnessSeries): Uint8Array {
  const { channels, count, hasPhase, hasMidSide } = series;
  const stride = valuesPerFrame(channels, hasPhase, hasMidSide);
  const out = new Uint8Array(HEADER + count * stride * 2);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  view.setUint8(4, VERSION);
  view.setUint8(5, channels);
  view.setUint8(6, (hasPhase ? 1 : 0) | (hasMidSide ? 2 : 0));
  view.setUint32(8, series.sampleRate, true);
  view.setUint32(12, series.samplesPerFrame, true);
  view.setUint32(16, count, true);
  let at = HEADER;
  const put = (value: number) => {
    view.setInt16(at, value, true);
    at += 2;
  };
  for (let f = 0; f < count; f++) {
    put(centi(series.momentary[f] as number));
    put(centi(series.shortTerm[f] as number));
    for (let c = 0; c < channels; c++) {
      put(centi(series.peak[f * channels + c] as number));
      put(centi(series.rms[f * channels + c] as number));
    }
    if (hasPhase) put(Math.round(Math.max(-1, Math.min(1, series.phase[f] ?? 0)) * 10_000));
    if (hasMidSide) {
      put(centi(series.mid[f] ?? SILENCE));
      put(centi(series.side[f] ?? SILENCE));
    }
  }
  return out;
}

export function decodeLoudness(bytes: Uint8Array): LoudnessSeries {
  if (bytes.length < HEADER || MAGIC.some((b, i) => bytes[i] !== b)) {
    throw new Error("Not a loudness file");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(4) !== VERSION) throw new Error("Unsupported loudness version");
  const channels = view.getUint8(5);
  const flags = view.getUint8(6);
  const hasPhase = (flags & 1) === 1;
  const hasMidSide = (flags & 2) === 2;
  const count = view.getUint32(16, true);
  const stride = valuesPerFrame(channels, hasPhase, hasMidSide);
  if (channels === 0 || bytes.length !== HEADER + count * stride * 2) {
    throw new Error("Truncated loudness file");
  }
  const series: LoudnessSeries = {
    channels,
    sampleRate: view.getUint32(8, true),
    samplesPerFrame: view.getUint32(12, true),
    count,
    hasPhase,
    momentary: new Float32Array(count),
    shortTerm: new Float32Array(count),
    peak: new Float32Array(count * channels),
    rms: new Float32Array(count * channels),
    phase: new Float32Array(hasPhase ? count : 0),
    hasMidSide,
    mid: new Float32Array(hasMidSide ? count : 0),
    side: new Float32Array(hasMidSide ? count : 0),
  };
  let at = HEADER;
  const take = () => {
    const value = view.getInt16(at, true);
    at += 2;
    return value;
  };
  for (let f = 0; f < count; f++) {
    series.momentary[f] = take() / 100;
    series.shortTerm[f] = take() / 100;
    for (let c = 0; c < channels; c++) {
      series.peak[f * channels + c] = take() / 100;
      series.rms[f * channels + c] = take() / 100;
    }
    if (hasPhase) series.phase[f] = take() / 10_000;
    if (hasMidSide) {
      series.mid[f] = take() / 100;
      series.side[f] = take() / 100;
    }
  }
  return series;
}

/** The frame covering a moment of playback, or null outside the file. */
export function frameAt(series: LoudnessSeries, seconds: number): number | null {
  if (series.count === 0 || !(seconds >= 0)) return null;
  const frame = Math.floor((seconds * series.sampleRate) / series.samplesPerFrame);
  return frame < series.count ? frame : null;
}

/** What a reviewer reads first: one number per measure, for the whole file. */
export const loudnessSummary = z.object({
  /** Integrated loudness in LUFS; null when the gate leaves nothing (silence). */
  integrated: z.number().nullable(),
  /** Loudness range in LU. */
  range: z.number(),
  /** Highest momentary and short-term loudness in LUFS, if any were measured. */
  momentaryMax: z.number().nullable(),
  shortTermMax: z.number().nullable(),
  /** Highest true peak of any channel in dBTP. */
  truePeak: z.number().nullable(),
  /** Per channel, in the file's order: true peak (dBTP), sample peak and RMS (dBFS). */
  channels: z.array(
    z.object({
      truePeak: z.number().nullable(),
      samplePeak: z.number().nullable(),
      rms: z.number().nullable(),
    }),
  ),
});
export type LoudnessSummary = z.infer<typeof loudnessSummary>;

/** A level for display: null below the silence floor. */
export const audible = (db: number) => (Number.isFinite(db) && db > SILENCE ? db : null);

/** Linear amplitude to dB, null for silence. */
export const linearToDb = (value: number) => (value > 0 ? audible(20 * Math.log10(value)) : null);

/**
 * Each channel's sample peak and RMS over the whole file, from the frames: peaks are the
 * highest, RMS is the power average (each frame weighted by its length, the last may be short).
 */
export function channelLevels(series: LoudnessSeries, totalSamples?: number) {
  const { channels, count, samplesPerFrame } = series;
  return Array.from({ length: channels }, (_, c) => {
    let peak = Number.NEGATIVE_INFINITY;
    let energy = 0;
    let weight = 0;
    for (let f = 0; f < count; f++) {
      const length =
        f === count - 1 && totalSamples !== undefined
          ? Math.max(1, totalSamples - f * samplesPerFrame)
          : samplesPerFrame;
      peak = Math.max(peak, series.peak[f * channels + c] as number);
      const rms = series.rms[f * channels + c] as number;
      if (rms > SILENCE) energy += 10 ** (rms / 10) * length;
      weight += length;
    }
    return {
      samplePeak: audible(peak),
      rms: weight > 0 && energy > 0 ? audible(10 * Math.log10(energy / weight)) : null,
    };
  });
}

/** The highest value of a series, null if every frame is silence. */
export function highest(values: Float32Array): number | null {
  let top = Number.NEGATIVE_INFINITY;
  for (const v of values) if (v > top) top = v;
  return audible(top);
}

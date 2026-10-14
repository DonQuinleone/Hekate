/**
 * Waveform peaks: the lowest and highest sample of every channel over fixed blocks of
 * samples, quantised to 8 bits. Enough to draw a waveform at any zoom down to the block
 * size; far too little to reconstruct audio. The media worker computes them once per file
 * at several block sizes (levels), so a long recording draws at once whatever the zoom.
 *
 * Binary layout, little-endian: the magic `HKPK`, version (u8), channels (u8), two reserved
 * bytes, sample rate (u32), samples per peak (u32), peak count (u32), then for every peak,
 * for every channel, min and max as signed bytes.
 */

export interface PeakLevel {
  channels: number;
  sampleRate: number;
  /** Source samples, per channel, that each peak covers. */
  samplesPerPeak: number;
  count: number;
  /** `count × channels × 2` signed bytes: [peak][channel][min, max]. */
  data: Int8Array;
}

const MAGIC = [0x48, 0x4b, 0x50, 0x4b];
const VERSION = 1;
const HEADER = 20;

/** The finest level: 256 samples a peak, about 5 ms at 48 kHz. */
export const BASE_SAMPLES_PER_PEAK = 256;
/** Each coarser level merges this many peaks of the level below. */
export const LEVEL_FACTOR = 4;
/** Coarsen until a level has at most this many peaks: enough for a full-width overview. */
export const OVERVIEW_PEAKS = 4096;

export function encodePeaks(level: PeakLevel): Uint8Array {
  const out = new Uint8Array(HEADER + level.data.length);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  view.setUint8(4, VERSION);
  view.setUint8(5, level.channels);
  view.setUint32(8, level.sampleRate, true);
  view.setUint32(12, level.samplesPerPeak, true);
  view.setUint32(16, level.count, true);
  out.set(new Uint8Array(level.data.buffer, level.data.byteOffset, level.data.length), HEADER);
  return out;
}

export function decodePeaks(bytes: Uint8Array): PeakLevel {
  if (bytes.length < HEADER || MAGIC.some((b, i) => bytes[i] !== b)) {
    throw new Error("Not a peaks file");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(4) !== VERSION) throw new Error("Unsupported peaks version");
  const channels = view.getUint8(5);
  const count = view.getUint32(16, true);
  const length = count * channels * 2;
  if (channels === 0 || bytes.length !== HEADER + length) throw new Error("Truncated peaks file");
  return {
    channels,
    sampleRate: view.getUint32(8, true),
    samplesPerPeak: view.getUint32(12, true),
    count,
    data: new Int8Array(bytes.buffer, bytes.byteOffset + HEADER, length).slice(),
  };
}

/** Merge every `factor` peaks into one: the next level up. */
export function coarsen(level: PeakLevel, factor = LEVEL_FACTOR): PeakLevel {
  const { channels } = level;
  const count = Math.ceil(level.count / factor);
  const data = new Int8Array(count * channels * 2);
  for (let peak = 0; peak < count; peak++) {
    for (let channel = 0; channel < channels; channel++) {
      let min = 127;
      let max = -128;
      const end = Math.min(level.count, (peak + 1) * factor);
      for (let source = peak * factor; source < end; source++) {
        const at = (source * channels + channel) * 2;
        min = Math.min(min, level.data[at] as number);
        max = Math.max(max, level.data[at + 1] as number);
      }
      const at = (peak * channels + channel) * 2;
      data[at] = min;
      data[at + 1] = max;
    }
  }
  return { ...level, samplesPerPeak: level.samplesPerPeak * factor, count, data };
}

/** The finest level and every coarser one down to an overview. */
export function peakLevels(base: PeakLevel): PeakLevel[] {
  const levels = [base];
  let current = base;
  while (current.count > OVERVIEW_PEAKS) {
    current = coarsen(current);
    levels.push(current);
  }
  return levels;
}

/**
 * All channels in one envelope (the extremes across channels), for the combined view.
 * Not a downmix: it shows where any channel is loud, which is what a reviewer scans for.
 */
export function combineChannels(level: PeakLevel): PeakLevel {
  const { channels, count } = level;
  const data = new Int8Array(count * 2);
  for (let peak = 0; peak < count; peak++) {
    let min = 127;
    let max = -128;
    for (let channel = 0; channel < channels; channel++) {
      const at = (peak * channels + channel) * 2;
      min = Math.min(min, level.data[at] as number);
      max = Math.max(max, level.data[at + 1] as number);
    }
    data[peak * 2] = min;
    data[peak * 2 + 1] = max;
  }
  return { ...level, channels: 1, data };
}

/** The coarsest level that still gives at least `peaks` peaks, or the finest if none does. */
export function levelFor<T extends { count: number }>(levels: T[], peaks: number): T | undefined {
  const sorted = [...levels].sort((a, b) => a.count - b.count);
  return sorted.find((l) => l.count >= peaks) ?? sorted.at(-1);
}

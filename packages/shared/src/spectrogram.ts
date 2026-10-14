/**
 * Spectrograms: the magnitude of every frequency band over time, for one channel (or the
 * mid or side of the front pair), computed once by the media worker. Each column holds the
 * loudest value each band reached over its span of time, in dB relative to a full-scale
 * sine, quantised to 8 bits between `SPECTROGRAM_FLOOR` and 0 dB. Like peaks, enough to draw
 * at any colour map, scale and range; far too little to rebuild audio.
 *
 * Binary layout, little-endian: the magic `HKSP`, version (u8), three reserved bytes, sample
 * rate (u32), FFT size (u32), samples per column (u32), column count (u32), band count
 * (u32), then for every column, for every band from 0 Hz to half the sample rate, a byte.
 */

export interface Spectrogram {
  sampleRate: number;
  fftSize: number;
  /** Source samples each column covers. */
  samplesPerColumn: number;
  columns: number;
  /** Equal-width bands from 0 Hz up to half the sample rate. */
  bands: number;
  /** `columns × bands` bytes: [column][band], 0 at the floor and 255 at 0 dB. */
  data: Uint8Array;
}

/** The quietest level a spectrogram records, in dB. */
export const SPECTROGRAM_FLOOR = -132;

/** The channels a spectrogram can show besides the file's own: the sum and difference of the front pair. */
export const derivedChannels = ["mid", "side"] as const;
export type DerivedChannel = (typeof derivedChannels)[number];
/** A file's channel by index (as a string), or a derived one. */
export type SpectrogramChannel = `${number}` | DerivedChannel;

const MAGIC = [0x48, 0x4b, 0x53, 0x50];
const VERSION = 1;
const HEADER = 28;

export const levelToByte = (db: number) =>
  Number.isFinite(db)
    ? Math.round(Math.max(0, Math.min(1, (db - SPECTROGRAM_FLOOR) / -SPECTROGRAM_FLOOR)) * 255)
    : 0;
export const byteToLevel = (value: number) =>
  SPECTROGRAM_FLOOR + (value / 255) * -SPECTROGRAM_FLOOR;

export function encodeSpectrogram(s: Spectrogram): Uint8Array {
  const out = new Uint8Array(HEADER + s.data.length);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  view.setUint8(4, VERSION);
  view.setUint32(8, s.sampleRate, true);
  view.setUint32(12, s.fftSize, true);
  view.setUint32(16, s.samplesPerColumn, true);
  view.setUint32(20, s.columns, true);
  view.setUint32(24, s.bands, true);
  out.set(s.data, HEADER);
  return out;
}

export function decodeSpectrogram(bytes: Uint8Array): Spectrogram {
  if (bytes.length < HEADER || MAGIC.some((b, i) => bytes[i] !== b)) {
    throw new Error("Not a spectrogram file");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(4) !== VERSION) throw new Error("Unsupported spectrogram version");
  const columns = view.getUint32(20, true);
  const bands = view.getUint32(24, true);
  if (bands === 0 || bytes.length !== HEADER + columns * bands) {
    throw new Error("Truncated spectrogram file");
  }
  return {
    sampleRate: view.getUint32(8, true),
    fftSize: view.getUint32(12, true),
    samplesPerColumn: view.getUint32(16, true),
    columns,
    bands,
    data: bytes.slice(HEADER),
  };
}

// Frequency scales: where a frequency sits, from 0 (bottom) to 1 (top) of a range.

export const frequencyScales = ["linear", "log", "mel", "bark"] as const;
export type FrequencyScale = (typeof frequencyScales)[number];

const mel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
// Traunmüller's formula.
const bark = (hz: number) => (26.81 * hz) / (1960 + hz) - 0.53;
/** The log scale needs a positive bottom; nothing below 10 Hz is drawn on it. */
const LOG_BOTTOM = 10;

const warp: Record<FrequencyScale, (hz: number) => number> = {
  linear: (hz) => hz,
  log: (hz) => Math.log10(Math.max(LOG_BOTTOM, hz)),
  mel,
  bark,
};

/** A frequency's position in [low, high] on a scale, from 0 to 1. */
export function scalePosition(scale: FrequencyScale, hz: number, low: number, high: number) {
  const f = warp[scale];
  const bottom = f(low);
  const span = f(high) - bottom;
  return span > 0 ? (f(hz) - bottom) / span : 0;
}

/** The frequency at a position (0 bottom, 1 top) of [low, high] on a scale. */
export function scaleFrequency(scale: FrequencyScale, position: number, low: number, high: number) {
  const f = warp[scale];
  const target = f(low) + position * (f(high) - f(low));
  // Every warp is increasing, so bisect rather than invert each formula.
  let lo = scale === "log" ? Math.max(LOG_BOTTOM, low) : low;
  let hi = high;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * For each of `rows` rows from the top, the range of bands it covers on a scale: so a row
 * spanning many bands shows the loudest of them, and a band spanning many rows repeats.
 */
export function rowBands(
  spectrogram: Pick<Spectrogram, "sampleRate" | "bands">,
  rows: number,
  scale: FrequencyScale,
  low: number,
  high: number,
): Int32Array {
  const bandHz = spectrogram.sampleRate / 2 / spectrogram.bands;
  const out = new Int32Array(rows * 2);
  const last = spectrogram.bands - 1;
  // A hair of tolerance, so a row edge that lands on a band edge does not take the next band.
  const tolerance = 1e-6;
  for (let row = 0; row < rows; row++) {
    // Row 0 is the top: the highest frequencies. A row covers [bottom, top).
    const top = scaleFrequency(scale, 1 - row / rows, low, high) / bandHz;
    const bottom = scaleFrequency(scale, 1 - (row + 1) / rows, low, high) / bandHz;
    const first = Math.max(0, Math.min(last, Math.floor(bottom + tolerance)));
    out[row * 2] = first;
    out[row * 2 + 1] = Math.max(first, Math.min(last, Math.ceil(top - tolerance) - 1));
  }
  return out;
}

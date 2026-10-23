/**
 * Spectrograms: the magnitude of every frequency band over time, for one channel (or the
 * mid or side of the front pair), computed once by the media worker. Each column holds the
 * loudest value each band reached over its span of time, in dB relative to a full-scale
 * sine, quantised to 8 bits between `SPECTROGRAM_FLOOR` and 0 dB. Like peaks, enough to draw
 * at any colour map, scale and range; far too little to rebuild audio.
 *
 * Columns span at least 100 ms, each the loudest of several overlapping windows: enough
 * for review, but no longer a short-time Fourier transform that phase retrieval could turn
 * back into recognisable audio (docs/security.md).
 *
 * Bands are the FFT's own bins (about 23 Hz) up to `lowBands`, so the low end keeps its
 * detail at any rate; above that, at high sample rates, every `highFactor` bins are pooled.
 *
 * Binary layout, little-endian: the magic `HKSP`, version (u8), three reserved bytes, sample
 * rate (u32), FFT size (u32), samples per column (u32), column count (u32), band count
 * (u32), low band count (u32), high factor (u32), then for every column, for every band from
 * 0 Hz to half the sample rate, a byte.
 */

export interface Spectrogram {
  sampleRate: number;
  fftSize: number;
  /** Source samples each column covers. */
  samplesPerColumn: number;
  columns: number;
  /** Bands from 0 Hz up to half the sample rate. */
  bands: number;
  /** Bands below this are one FFT bin wide; each above it pools `highFactor` bins. */
  lowBands: number;
  highFactor: number;
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
const HEADER = 36;

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
  view.setUint32(28, s.lowBands, true);
  view.setUint32(32, s.highFactor, true);
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
  const lowBands = view.getUint32(28, true);
  const highFactor = view.getUint32(32, true);
  if (bands === 0 || highFactor === 0 || bytes.length !== HEADER + columns * bands) {
    throw new Error("Truncated spectrogram file");
  }
  return {
    sampleRate: view.getUint32(8, true),
    fftSize: view.getUint32(12, true),
    samplesPerColumn: view.getUint32(16, true),
    columns,
    bands,
    lowBands,
    highFactor,
    data: bytes.slice(HEADER),
  };
}

type BandLayout = Pick<Spectrogram, "sampleRate" | "fftSize" | "bands" | "lowBands" | "highFactor">;

/** The band holding an FFT bin (fractional bins give fractional bands, for row edges). */
export function bandOfBin(layout: Pick<Spectrogram, "lowBands" | "highFactor">, bin: number) {
  return bin < layout.lowBands
    ? bin
    : layout.lowBands + (bin - layout.lowBands) / layout.highFactor;
}

/** The frequency at the bottom edge of a band. */
export function bandFrequency(layout: BandLayout, band: number) {
  const binHz = layout.sampleRate / layout.fftSize;
  const bin =
    band < layout.lowBands ? band : layout.lowBands + (band - layout.lowBands) * layout.highFactor;
  return bin * binHz;
}

// Analysis (#34): how a spectrogram is computed. Every file is analysed once with the
// default; anything else is drawn on the server the first time someone asks for it.

export const spectrogramWindows = ["hann", "hamming", "blackman-harris", "kaiser"] as const;
export type SpectrogramWindow = (typeof spectrogramWindows)[number];
/** "auto" makes bands about 23 Hz wide at any rate (2048 points at 48 kHz). */
export const spectrogramFftSizes = ["auto", "1024", "4096", "16384"] as const;
export type SpectrogramFftSize = (typeof spectrogramFftSizes)[number];
/** How much each window overlaps the one before, in per cent. */
export const spectrogramOverlaps = ["50", "75", "87.5"] as const;
export type SpectrogramOverlap = (typeof spectrogramOverlaps)[number];

export interface SpectrogramAnalysis {
  window: SpectrogramWindow;
  fftSize: SpectrogramFftSize;
  overlap: SpectrogramOverlap;
}

export const defaultAnalysis: SpectrogramAnalysis = {
  window: "hann",
  fftSize: "auto",
  overlap: "75",
};

/** One name for a set of analysis settings, as variants are kept and asked for. */
export const analysisKey = (a: SpectrogramAnalysis) => `${a.window}/${a.fftSize}/${a.overlap}`;
export const isDefaultAnalysis = (a: SpectrogramAnalysis) =>
  analysisKey(a) === analysisKey(defaultAnalysis);

/** The settings a key names, or null for anything that is not one. */
export function analysisOfKey(key: string): SpectrogramAnalysis | null {
  const [window, fftSize, overlap, ...rest] = key.split("/");
  if (rest.length > 0) return null;
  return spectrogramWindows.includes(window as SpectrogramWindow) &&
    spectrogramFftSizes.includes(fftSize as SpectrogramFftSize) &&
    spectrogramOverlaps.includes(overlap as SpectrogramOverlap)
    ? {
        window: window as SpectrogramWindow,
        fftSize: fftSize as SpectrogramFftSize,
        overlap: overlap as SpectrogramOverlap,
      }
    : null;
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
  spectrogram: BandLayout,
  rows: number,
  scale: FrequencyScale,
  low: number,
  high: number,
): Int32Array {
  const binHz = spectrogram.sampleRate / spectrogram.fftSize;
  const out = new Int32Array(rows * 2);
  const last = spectrogram.bands - 1;
  // A hair of tolerance, so a row edge that lands on a band edge does not take the next band.
  const tolerance = 1e-6;
  const band = (hz: number) => bandOfBin(spectrogram, hz / binHz);
  for (let row = 0; row < rows; row++) {
    // Row 0 is the top: the highest frequencies. A row covers [bottom, top).
    const top = band(scaleFrequency(scale, 1 - row / rows, low, high));
    const bottom = band(scaleFrequency(scale, 1 - (row + 1) / rows, low, high));
    const first = Math.max(0, Math.min(last, Math.floor(bottom + tolerance)));
    out[row * 2] = first;
    out[row * 2 + 1] = Math.max(first, Math.min(last, Math.ceil(top - tolerance) - 1));
  }
  return out;
}

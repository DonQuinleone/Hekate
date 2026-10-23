import { Worker } from "node:worker_threads";
import {
  defaultAnalysis,
  levelToByte,
  type Spectrogram,
  type SpectrogramAnalysis,
  type SpectrogramChannel,
  type SpectrogramWindow,
} from "@hekate/shared";
import { MediaToolError, run, safeInputArgs } from "./ffmpeg.ts";

/** About this many columns across a long file: enough for a sharp overview on any screen. */
export const MAX_COLUMNS = 4096;
/**
 * Never shorter columns than this: each pools several overlapping windows, so what is
 * stored is not a short-time Fourier transform that could be turned back into audio.
 */
export const MIN_COLUMN_SECONDS = 0.1;
/** Nor fewer windows a column than this, whatever its FFT size and overlap (#34). */
export const MIN_WINDOWS_PER_COLUMN = 4;
/** Bands kept at the FFT's own resolution: 1024 bins of about 23 Hz reach 24 kHz. */
export const LOW_BANDS = 1024;
/** At most this many pooled bands above them, at high sample rates. */
export const HIGH_BANDS = 512;

/** Bands about 23 Hz wide whatever the rate: 2048 points at 48 kHz, 4096 at 96 kHz. */
export function fftSizeFor(sampleRate: number): number {
  let size = 2048;
  while (size < 16_384 && sampleRate / size > 24) size *= 2;
  return size;
}

/** The FFT size an analysis asks for at a sample rate: its own, or one about 23 Hz a bin. */
export const analysisFftSize = (analysis: SpectrogramAnalysis, sampleRate: number) =>
  analysis.fftSize === "auto" ? fftSizeFor(sampleRate) : Number(analysis.fftSize);

/** How far each window moves on: a half, a quarter or an eighth of its length. */
export const analysisHop = (analysis: SpectrogramAnalysis, fftSize: number) =>
  Math.max(1, Math.round(fftSize * (1 - Number(analysis.overlap) / 100)));

/** The zeroth modified Bessel function of the first kind, by its series. */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 50; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < sum * 1e-16) break;
  }
  return sum;
}

/** Kaiser's β for side lobes about 90 dB down, near the four-term Blackman–Harris. */
const KAISER_BETA = 9;

/** A window of `size` points, of one of the kinds an analysis may choose. */
export function windowOf(kind: SpectrogramWindow, size: number): Float64Array {
  const out = new Float64Array(size);
  const phase = (i: number) => (2 * Math.PI * i) / size;
  for (let i = 0; i < size; i++) {
    const x = phase(i);
    out[i] =
      kind === "hann"
        ? 0.5 - 0.5 * Math.cos(x)
        : kind === "hamming"
          ? 0.54 - 0.46 * Math.cos(x)
          : kind === "blackman-harris"
            ? 0.35875 -
              0.48829 * Math.cos(x) +
              0.14128 * Math.cos(2 * x) -
              0.01168 * Math.cos(3 * x)
            : besselI0(KAISER_BETA * Math.sqrt(1 - ((2 * i) / size - 1) ** 2)) /
              besselI0(KAISER_BETA);
  }
  return out;
}

/** A radix-2 FFT of one size, with its tables computed once. */
export class Fft {
  readonly size: number;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly reverse: Uint32Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) throw new Error("FFT size must be a power of two");
    this.size = size;
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / size);
    }
    this.reverse = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.reverse[i] = r;
    }
  }

  /** In place, on separate real and imaginary arrays. */
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.reverse[i] as number;
      if (j > i) {
        const tr = re[i] as number;
        re[i] = re[j] as number;
        re[j] = tr;
        const ti = im[i] as number;
        im[i] = im[j] as number;
        im[j] = ti;
      }
    }
    for (let length = 2; length <= n; length *= 2) {
      const half = length / 2;
      const step = n / length;
      for (let start = 0; start < n; start += length) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step] as number;
          const wi = this.sin[k * step] as number;
          const a = start + k;
          const b = a + half;
          const br = re[b] as number;
          const bi = im[b] as number;
          const xr = br * wr - bi * wi;
          const xi = br * wi + bi * wr;
          re[b] = (re[a] as number) - xr;
          im[b] = (im[a] as number) - xi;
          re[a] = (re[a] as number) + xr;
          im[a] = (im[a] as number) + xi;
        }
      }
    }
  }
}

/**
 * Builds spectrograms from interleaved 32-bit float PCM arriving in chunks of any size:
 * one per channel, plus the mid and side of the front pair when there is one. A window
 * (Hann by default) moves on by part of its length (a quarter by default); each column
 * keeps the loudest level every band reached during its span, so a click is never averaged
 * away. Whatever the analysis, a column spans at least `MIN_COLUMN_SECONDS`.
 */
export class SpectrogramBuilder {
  readonly channels: number;
  readonly sampleRate: number;
  readonly fftSize: number;
  readonly hop: number;
  /** Grows (doubling) if a file turns out longer than expected; see `coarsen`. */
  samplesPerColumn: number;
  readonly bands: number;
  readonly lowBands: number;
  readonly highFactor: number;
  private readonly maxColumns: number;
  /** What each output is: the file's channels by index, then mid and side. */
  readonly outputs: SpectrogramChannel[];
  private readonly fft: Fft;
  private readonly window: Float64Array;
  /** The last `fftSize` samples of every output, as a ring. */
  private readonly history: Float64Array[];
  private written = 0;
  private sinceHop = 0;
  private sinceColumn = 0;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  /** The column being built, per output, as linear magnitudes squared. */
  private readonly current: Float64Array[];
  private columnData: Uint8Array[][];
  private frame: Float64Array;
  private channel = 0;
  private carry = Buffer.alloc(0);
  /** Full scale: a 0 dBFS sine through the window, as a squared magnitude. */
  private readonly reference: number;

  constructor(
    channels: number,
    sampleRate: number,
    expectedSamples: number,
    options: { maxColumns?: number; analysis?: SpectrogramAnalysis } = {},
  ) {
    const analysis = options.analysis ?? defaultAnalysis;
    this.channels = channels;
    this.sampleRate = sampleRate;
    this.fftSize = analysisFftSize(analysis, sampleRate);
    this.hop = analysisHop(analysis, this.fftSize);
    this.maxColumns = options.maxColumns ?? MAX_COLUMNS;
    const minimum = Math.max(
      MIN_WINDOWS_PER_COLUMN,
      Math.ceil((MIN_COLUMN_SECONDS * sampleRate) / this.hop),
    );
    const fit = Math.ceil(expectedSamples / this.hop / this.maxColumns);
    this.samplesPerColumn = Math.max(1, minimum, fit) * this.hop;
    const half = this.fftSize / 2;
    this.lowBands = Math.min(half, LOW_BANDS);
    this.highFactor = half > this.lowBands ? Math.ceil((half - this.lowBands) / HIGH_BANDS) : 1;
    this.bands = this.lowBands + Math.ceil((half - this.lowBands) / this.highFactor);
    this.outputs = [
      ...Array.from({ length: channels }, (_, c) => `${c}` as SpectrogramChannel),
      ...(channels >= 2 ? (["mid", "side"] as const) : []),
    ];
    this.fft = new Fft(this.fftSize);
    this.window = windowOf(analysis.window, this.fftSize);
    let sum = 0;
    for (const w of this.window) sum += w;
    this.reference = (sum / 2) ** 2;
    this.history = this.outputs.map(() => new Float64Array(this.fftSize));
    this.re = new Float64Array(this.fftSize);
    this.im = new Float64Array(this.fftSize);
    this.current = this.outputs.map(() => new Float64Array(this.bands));
    this.columnData = this.outputs.map(() => []);
    this.frame = new Float64Array(channels);
  }

  push(chunk: Buffer): void {
    const bytes = this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : chunk;
    const whole = bytes.length - (bytes.length % 4);
    // An aligned copy, read as floats: far quicker than reading sample by sample.
    const samples = new Float32Array(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + whole),
    );
    for (const value of samples) {
      this.frame[this.channel] = value;
      this.channel += 1;
      if (this.channel === this.channels) {
        this.channel = 0;
        this.sample();
      }
    }
    this.carry = Buffer.from(bytes.subarray(whole));
  }

  private sample(): void {
    const at = this.written % this.fftSize;
    for (let c = 0; c < this.channels; c++) {
      (this.history[c] as Float64Array)[at] = this.frame[c] as number;
    }
    if (this.channels >= 2) {
      const left = this.frame[0] as number;
      const right = this.frame[1] as number;
      (this.history[this.channels] as Float64Array)[at] = (left + right) / 2;
      (this.history[this.channels + 1] as Float64Array)[at] = (left - right) / 2;
    }
    this.written += 1;
    this.sinceHop += 1;
    this.sinceColumn += 1;
    if (this.sinceHop === this.hop) {
      this.sinceHop = 0;
      this.analyse();
    }
    if (this.sinceColumn === this.samplesPerColumn) {
      this.sinceColumn = 0;
      this.closeColumn();
    }
  }

  /** Transform the latest window of every output, two outputs per complex FFT. */
  private analyse(): void {
    const n = this.fftSize;
    const start = this.written % n;
    for (let o = 0; o < this.outputs.length; o += 2) {
      const a = this.history[o] as Float64Array;
      const b = this.history[o + 1];
      // The ring holds the oldest sample at `start`: copy it out in two runs.
      for (let i = 0; i < n; i++) {
        const at = i < n - start ? start + i : i - (n - start);
        const w = this.window[i] as number;
        this.re[i] = (a[at] as number) * w;
        this.im[i] = b ? (b[at] as number) * w : 0;
      }
      this.fft.transform(this.re, this.im);
      this.accumulate(o, b ? o + 1 : -1);
    }
  }

  /** Split a two-signal transform into each signal's spectrum and keep each band's loudest. */
  private accumulate(first: number, second: number): void {
    const n = this.fftSize;
    const half = n / 2;
    const low = this.lowBands;
    const factor = this.highFactor;
    const a = this.current[first] as Float64Array;
    const b = second >= 0 ? (this.current[second] as Float64Array) : null;
    for (let k = 0; k < half; k++) {
      const xr = this.re[k] as number;
      const xi = this.im[k] as number;
      const yr = this.re[(n - k) % n] as number;
      const yi = this.im[(n - k) % n] as number;
      // A = (X[k] + conj X[n-k]) / 2, B = (X[k] - conj X[n-k]) / 2i.
      const ar = (xr + yr) / 2;
      const ai = (xi - yi) / 2;
      const powerA = ar * ar + ai * ai;
      const band = k < low ? k : low + Math.floor((k - low) / factor);
      if (powerA > (a[band] as number)) a[band] = powerA;
      if (b) {
        const br = (xi + yi) / 2;
        const bi = (yr - xr) / 2;
        const powerB = br * br + bi * bi;
        if (powerB > (b[band] as number)) b[band] = powerB;
      }
    }
  }

  private closeColumn(): void {
    this.current.forEach((powers, o) => {
      const column = new Uint8Array(this.bands);
      for (let band = 0; band < this.bands; band++) {
        const power = powers[band] as number;
        column[band] = power > 0 ? levelToByte(10 * Math.log10(power / this.reference)) : 0;
      }
      (this.columnData[o] as Uint8Array[]).push(column);
      powers.fill(0);
    });
    // Longer than expected (the duration was missing or wrong): halve the columns rather
    // than let memory grow with the file.
    if ((this.columnData[0]?.length ?? 0) >= this.maxColumns * 2) this.coarsen();
  }

  /** Merge every two columns into one, keeping each band's loudest, and double the span. */
  private coarsen(): void {
    this.columnData.forEach((columns, o) => {
      const merged: Uint8Array[] = [];
      for (let i = 0; i < columns.length; i += 2) {
        const a = columns[i] as Uint8Array;
        const b = columns[i + 1];
        if (b)
          for (let band = 0; band < a.length; band++)
            a[band] = Math.max(a[band] as number, b[band] as number);
        merged.push(a);
      }
      this.columnData[o] = merged;
    });
    this.samplesPerColumn *= 2;
  }

  /** Every output's spectrogram, including a last, partial column. */
  finish(): { channel: SpectrogramChannel; spectrogram: Spectrogram }[] {
    if (this.sinceColumn > 0) {
      if (this.sinceHop > 0) this.analyse();
      this.closeColumn();
    }
    return this.outputs.map((channel, o) => {
      const columns = this.columnData[o] as Uint8Array[];
      const data = new Uint8Array(columns.length * this.bands);
      columns.forEach((column, i) => {
        data.set(column, i * this.bands);
      });
      return {
        channel,
        spectrogram: {
          sampleRate: this.sampleRate,
          fftSize: this.fftSize,
          samplesPerColumn: this.samplesPerColumn,
          columns: columns.length,
          bands: this.bands,
          lowBands: this.lowBands,
          highFactor: this.highFactor,
          data,
        },
      };
    });
  }
}

/**
 * Decode a file's first audio stream and build its spectrograms. CPU-heavy for long
 * surround files, so the worker runs it on its own thread (`spectrogram-thread.ts`); the
 * pipe from ffmpeg gives back-pressure, so memory stays flat however fast ffmpeg decodes.
 */
export async function computeSpectrograms(
  path: string,
  audio: { channels: number; sampleRate: number },
  duration: number | undefined,
  signal: AbortSignal,
  analysis: SpectrogramAnalysis = defaultAnalysis,
) {
  const builder = new SpectrogramBuilder(
    audio.channels,
    audio.sampleRate,
    Math.ceil((duration ?? 0) * audio.sampleRate),
    { analysis },
  );
  await run(
    "ffmpeg",
    [
      ...safeInputArgs("ffmpeg"),
      "-v",
      "error",
      "-i",
      `file:${path}`,
      "-map",
      "0:a:0",
      "-vn",
      "-f",
      "f32le",
      "-acodec",
      "pcm_f32le",
      "-ac",
      String(audio.channels),
      "-ar",
      String(audio.sampleRate),
      "pipe:1",
    ],
    { signal, timeoutMs: 2 * 60 * 60_000, onStdout: (chunk) => builder.push(chunk) },
  );
  return builder.finish();
}

export interface EncodedSpectrogram {
  channel: SpectrogramChannel;
  columns: number;
  bands: number;
  fftSize: number;
  samplesPerColumn: number;
  /** In the format of `packages/shared/src/spectrogram.ts`. */
  bytes: Uint8Array;
}

/** `computeSpectrograms` on its own thread, encoded; cancelling the signal stops it. */
export function spectrogramsInThread(
  path: string,
  audio: { channels: number; sampleRate: number },
  duration: number | undefined,
  signal: AbortSignal,
  analysis: SpectrogramAnalysis = defaultAnalysis,
): Promise<EncodedSpectrogram[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./spectrogram-thread.ts", import.meta.url), {
      workerData: { path, audio, duration, analysis },
    });
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      outcome();
    };
    const onAbort = () => worker.postMessage("abort");
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    worker.on(
      "message",
      (message: { ok: true; encoded: EncodedSpectrogram[] } | { ok: false; message: string }) => {
        finish(() =>
          message.ok ? resolve(message.encoded) : reject(new MediaToolError(message.message)),
        );
        void worker.terminate();
      },
    );
    worker.on("error", (error) => finish(() => reject(error)));
    worker.on("exit", (code) =>
      finish(() => reject(new MediaToolError(`The spectrogram thread stopped (${code})`))),
    );
  });
}

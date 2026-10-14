import { type AlignmentPoints, simplifyAlignment } from "@hekate/shared";
import { run, safeInputArgs } from "./ffmpeg.ts";
import { Fft } from "./spectrogram.ts";

/**
 * Aligning two versions of a piece by their audio (#33): where the same music sits in
 * each, so a comment, a loop or a comparison can follow it across an edit. Each version is
 * reduced to a sequence of spectral fingerprints, ten a second, and the two sequences are
 * matched with dynamic time warping: first coarsely across the whole of both, then finely
 * near the coarse path.
 */

/** The rate both versions are decoded at: enough for the shape of the music, cheap to hold. */
export const ALIGN_SAMPLE_RATE = 11_025;
/** Fingerprints a second. */
export const FRAMES_PER_SECOND = 10;
const HOP = Math.round(ALIGN_SAMPLE_RATE / FRAMES_PER_SECOND);
const WINDOW = 2048;
const BANDS = 24;
const LOW_HZ = 60;
const HIGH_HZ = 5000;
/** How much coarser the first pass is, at least. */
const COARSE = 4;
/** The most cells the coarse pass may hold: long pieces are pooled more coarsely. */
const COARSE_CELLS = 4_000_000;
/** How far either side of the coarse path the fine pass looks, in coarse frames. */
const RADIUS = 2;
/** What a step that holds one version still costs on top of the distance: edits are rare. */
const STALL = 0.15;

/** Mono 32-bit float audio at the alignment rate, decoded from any file ffmpeg reads. */
export async function decodeForAlignment(path: string, signal: AbortSignal): Promise<Float32Array> {
  const chunks: Buffer[] = [];
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
      "-ac",
      "1",
      "-ar",
      String(ALIGN_SAMPLE_RATE),
      "-f",
      "f32le",
      "-acodec",
      "pcm_f32le",
      "pipe:1",
    ],
    { signal, timeoutMs: 30 * 60_000, onStdout: (chunk) => chunks.push(chunk) },
  );
  const all = Buffer.concat(chunks);
  const samples = new Float32Array(Math.floor(all.byteLength / 4));
  for (let i = 0; i < samples.length; i++) samples[i] = all.readFloatLE(i * 4);
  return samples;
}

/** Unit-length vectors, one per frame: the spectrum's shape in log-spaced bands. */
export function fingerprints(samples: Float32Array): Float32Array[] {
  const fft = new Fft(WINDOW);
  const hann = new Float64Array(WINDOW);
  for (let i = 0; i < WINDOW; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WINDOW - 1));
  // Which band each FFT bin falls in, or -1.
  const bandOf = new Int16Array(WINDOW / 2).fill(-1);
  for (let k = 1; k < WINDOW / 2; k++) {
    const hz = (k * ALIGN_SAMPLE_RATE) / WINDOW;
    if (hz < LOW_HZ || hz >= HIGH_HZ) continue;
    bandOf[k] = Math.floor((Math.log(hz / LOW_HZ) / Math.log(HIGH_HZ / LOW_HZ)) * BANDS);
  }
  const frames: Float32Array[] = [];
  const re = new Float64Array(WINDOW);
  const im = new Float64Array(WINDOW);
  for (let start = 0; start + WINDOW <= samples.length || frames.length === 0; start += HOP) {
    for (let i = 0; i < WINDOW; i++) {
      re[i] = (samples[start + i] ?? 0) * (hann[i] as number);
      im[i] = 0;
    }
    fft.transform(re, im);
    const bands = new Float64Array(BANDS);
    for (let k = 1; k < WINDOW / 2; k++) {
      const b = bandOf[k] as number;
      if (b >= 0) bands[b] = (bands[b] as number) + (re[k] as number) ** 2 + (im[k] as number) ** 2;
    }
    frames.push(normalise(bands.map((e) => Math.log1p(e * 1e4))));
    if (start + WINDOW >= samples.length) break;
  }
  return frames;
}

/** Centred and scaled to unit length, so a level change between versions does not matter. */
function normalise(values: ArrayLike<number>): Float32Array {
  const out = new Float32Array(values.length);
  let mean = 0;
  for (let i = 0; i < values.length; i++) mean += values[i] as number;
  mean /= values.length || 1;
  let norm = 0;
  for (let i = 0; i < values.length; i++) {
    const v = (values[i] as number) - mean;
    out[i] = v;
    norm += v * v;
  }
  norm = Math.sqrt(norm);
  if (norm > 1e-9) for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) / norm;
  return out;
}

/** Cosine distance between two fingerprints: 0 the same, 2 opposite; silence is 1 from all. */
function distance(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] as number) * (b[i] as number);
  return 1 - dot;
}

/** Averages of `factor` frames, renormalised: the coarse pass's view. */
function pool(frames: Float32Array[], factor: number): Float32Array[] {
  const out: Float32Array[] = [];
  for (let i = 0; i < frames.length; i += factor) {
    const sum = new Float64Array(BANDS);
    for (let k = i; k < Math.min(frames.length, i + factor); k++) {
      const f = frames[k] as Float32Array;
      for (let b = 0; b < BANDS; b++) sum[b] = (sum[b] as number) + (f[b] as number);
    }
    out.push(normalise(sum));
  }
  return out;
}

/**
 * The cheapest path from the start of both to the end of both, through the cells each row
 * allows (`from[i]` to `to[i]`, inclusive). Returns the path as [row, column] pairs, start
 * first, and its mean distance.
 */
function warp(
  a: Float32Array[],
  b: Float32Array[],
  from: Int32Array,
  to: Int32Array,
): { path: [number, number][]; cost: number } {
  const n = a.length;
  const rows: Float64Array[] = [];
  for (let i = 0; i < n; i++) {
    const lo = from[i] as number;
    const hi = to[i] as number;
    const row = new Float64Array(hi - lo + 1).fill(Number.POSITIVE_INFINITY);
    const prev = i > 0 ? (rows[i - 1] as Float64Array) : null;
    const prevLo = i > 0 ? (from[i - 1] as number) : 0;
    const at = (r: Float64Array | null, rLo: number, j: number) =>
      r && j >= rLo && j - rLo < r.length ? (r[j - rLo] as number) : Number.POSITIVE_INFINITY;
    for (let j = lo; j <= hi; j++) {
      const d = distance(a[i] as Float32Array, b[j] as Float32Array);
      if (i === 0 && j === 0) {
        row[0] = d;
        continue;
      }
      const diagonal = at(prev, prevLo, j - 1);
      const up = at(prev, prevLo, j) + STALL;
      const left = (j > lo ? (row[j - lo - 1] as number) : Number.POSITIVE_INFINITY) + STALL;
      row[j - lo] = d + Math.min(diagonal, up, left);
    }
    rows.push(row);
  }
  // Back from the end of both to the start.
  const path: [number, number][] = [];
  let i = n - 1;
  let j = b.length - 1;
  const cell = (r: number, c: number) => {
    const lo = from[r] as number;
    const row = rows[r] as Float64Array;
    return c >= lo && c - lo < row.length ? (row[c - lo] as number) : Number.POSITIVE_INFINITY;
  };
  const total = cell(i, j);
  while (i > 0 || j > 0) {
    path.push([i, j]);
    const diagonal = i > 0 && j > 0 ? cell(i - 1, j - 1) : Number.POSITIVE_INFINITY;
    const up = i > 0 ? cell(i - 1, j) + STALL : Number.POSITIVE_INFINITY;
    const left = j > 0 ? cell(i, j - 1) + STALL : Number.POSITIVE_INFINITY;
    if (diagonal <= up && diagonal <= left) {
      i--;
      j--;
    } else if (up <= left) i--;
    else j--;
  }
  path.push([0, 0]);
  path.reverse();
  return { path, cost: total / path.length };
}

/** Every cell of every row: the coarse pass over the whole of both. */
function everything(n: number, m: number) {
  return { from: new Int32Array(n), to: new Int32Array(n).fill(m - 1) };
}

/** The cells near a coarse path, at the fine scale. */
function around(coarse: [number, number][], n: number, m: number, factor: number) {
  const from = new Int32Array(n).fill(m);
  const to = new Int32Array(n).fill(-1);
  for (const [ci, cj] of coarse) {
    const lo = Math.max(0, (cj - RADIUS) * factor);
    const hi = Math.min(m - 1, (cj + RADIUS + 1) * factor - 1);
    const first = Math.max(0, (ci - RADIUS) * factor);
    const last = Math.min(n, (ci + RADIUS + 1) * factor);
    for (let i = first; i < last; i++) {
      from[i] = Math.min(from[i] as number, lo);
      to[i] = Math.max(to[i] as number, hi);
    }
  }
  // Every row reaches back to where the one before it starts, so the band is connected.
  for (let i = 0; i < n; i++) {
    if ((to[i] as number) < 0) {
      from[i] = i > 0 ? (from[i - 1] as number) : 0;
      to[i] = i > 0 ? (to[i - 1] as number) : 0;
    }
    if (i > 0) from[i] = Math.min(from[i] as number, to[i - 1] as number);
  }
  from[0] = 0;
  to[n - 1] = m - 1;
  return { from, to };
}

export interface Alignment {
  /** Pairs of times, in seconds: version A's and version B's, rising together. */
  points: AlignmentPoints;
  /** How alike the matched music is, from 0 (not at all) to 1 (identical). */
  quality: number;
}

/** Align two versions' fingerprints. */
export function alignFingerprints(a: Float32Array[], b: Float32Array[]): Alignment {
  if (a.length === 0 || b.length === 0) return { points: [], quality: 0 };
  const factor = Math.max(COARSE, Math.ceil(Math.sqrt((a.length * b.length) / COARSE_CELLS)));
  const ca = pool(a, factor);
  const cb = pool(b, factor);
  const whole = everything(ca.length, cb.length);
  const coarse = warp(ca, cb, whole.from, whole.to);
  const band = around(coarse.path, a.length, b.length, factor);
  const fine = warp(a, b, band.from, band.to);
  // One pair per frame of A: where B is, on average, while A is there.
  const sums = new Float64Array(a.length);
  const counts = new Uint32Array(a.length);
  for (const [i, j] of fine.path) {
    sums[i] = (sums[i] as number) + j;
    counts[i] = (counts[i] as number) + 1;
  }
  const points: AlignmentPoints = [];
  let last = -1;
  for (let i = 0; i < a.length; i++) {
    const j = (sums[i] as number) / Math.max(1, counts[i] as number);
    // Rising only: a held note in A must not send B backwards.
    const at = Math.max(j, last);
    last = at;
    points.push([i / FRAMES_PER_SECOND, at / FRAMES_PER_SECOND]);
  }
  return {
    points: simplifyAlignment(points, 0.05),
    quality: Math.max(0, Math.min(1, 1 - fine.cost)),
  };
}

/** Align two decoded versions. */
export const alignAudio = (a: Float32Array, b: Float32Array): Alignment =>
  alignFingerprints(fingerprints(a), fingerprints(b));

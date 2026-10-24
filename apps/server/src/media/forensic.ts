import { createHmac, hkdfSync } from "node:crypto";
import { Fft } from "./spectrogram.ts";

/**
 * The forensic audio mark (#32, decision 239): the signal processing alone, with no files,
 * processes or database, so every part of it can be tested by itself.
 *
 * A mark is a pattern of small gains on a recording's spectrum. The sound is looked at in
 * frames of 32 ms at an analysis rate of 16 kHz, and its spectrum from 406 Hz to 4.6 kHz is
 * cut into 68 bands of two bins (62.5 Hz). In each symbol (four frames, 64 ms) every band is
 * made a little louder or a little quieter, by `strength`, as the pattern's sign for that
 * band and symbol says. A quarter of the bands carry the workspace's synchronisation signs,
 * which find where a clip sits; the rest carry the recipient's code: 408 signs that follow
 * from the workspace's key and the mark's id and from nothing else. Gains on the spectrum
 * survive what keeps a recording sounding the same: lossy encoding, resampling, a change of
 * level or equalisation, trimming. They do not survive a change of speed of a per cent.
 *
 * Nothing is decoded blindly. A suspected leak is compared with each mark the workspace
 * issued, and each comparison yields a score `z` whose chance of reaching that height by
 * accident, when the clip does not carry that mark, is at most `exp(-z²/2)` (Hoeffding's
 * bound for a sum of independent signs with fixed weights: a code the clip does not carry is
 * independent of it). A match is reported only when that chance, multiplied by every
 * comparison made, is below one in a million.
 */

/** The analysis rate: the mark lives below its Nyquist frequency, so nothing above matters. */
export const MARK_RATE = 16_000;
const FRAME = 512;
const HOP = FRAME / 2;
/** Bins to a band. */
const WIDTH = 2;
/** The first bin of the lowest band: 406 Hz. */
const LOW_BIN = 13;
/** Bands, up to 4.6 kHz, where every common codec keeps detail. */
const BANDS = 68;
const SPAN = BANDS * WIDTH;
/** Frames a sign lasts: 64 ms. */
const SYMBOL_FRAMES = 4;
/** Symbols before the pattern repeats: 32.8 s. */
export const PERIOD = 512;
/** The recipient's code changes every 64 symbols (4.1 s), eight blocks a period. */
const BLOCKS = 8;
const BLOCK = PERIOD / BLOCKS;
const SYNC_BANDS = 17;
const CODE_BANDS = BANDS - SYNC_BANDS;
/** How many signs a recipient's code has. */
export const CODE_LENGTH = CODE_BANDS * BLOCKS;
/** How much each band is raised or lowered: 5 per cent, under half a decibel. */
export const DEFAULT_STRENGTH = 0.05;
/** The mark is scaled down wherever it would take a sample past this. */
const CEILING = 0.98;
/**
 * The least share of its strength a recording's mark may keep, on average over the frames
 * with sound, once the ceiling has made way for the loudest: below it, the download is
 * refused rather than sent with a mark too weak to trace (decision 239).
 */
export const MIN_EMBEDDED = 0.5;
/** Detection tries the frame grid this many ways within a hop. */
const OFFSETS = 4;
/**
 * Symbols either side whose mean (with the symbol itself) is taken off each band's level
 * before comparing: what the music holds from one symbol to the next is not the mark.
 */
const REACH = 1;
/** Detection compares the codes at this many of the likeliest synchronisation positions. */
const POSITIONS = 16;
/** A match is reported only below this chance of a false one. */
export const FALSE_MATCH_LIMIT = 1e-6;

/** The workspace's pattern: which bands synchronise, their signs, and the signs over time. */
export interface MarkPattern {
  /** For each band, its place: below `SYNC_BANDS` among the sync bands, else among the code's. */
  slot: Int16Array;
  syncSigns: Int8Array;
  symbolSigns: Int8Array;
}

/** A recipient's code: `CODE_LENGTH` signs. */
export type MarkCode = Int8Array;

/**
 * The key marks are made with, from a version of the workspace's own key: one-way, so a mark
 * reveals nothing of the key that encrypts the workspace's files.
 */
export function forensicKey(workspaceKey: Buffer): Buffer {
  return Buffer.from(
    hkdfSync("sha256", workspaceKey, Buffer.alloc(0), "hekate forensic mark v1", 32),
  );
}

/** `count` bytes that follow from the key and the label alone (HMAC-SHA256 in counter mode). */
function keyedBytes(key: Buffer, label: string, count: number): Buffer {
  const blocks: Buffer[] = [];
  for (let i = 0; blocks.length * 32 < count; i++)
    blocks.push(createHmac("sha256", key).update(`${label}:${i}`).digest());
  return Buffer.concat(blocks).subarray(0, count);
}

/** `count` signs, one a bit of the keyed bytes. */
function keyedSigns(key: Buffer, label: string, count: number): Int8Array {
  const bytes = keyedBytes(key, label, Math.ceil(count / 8));
  const out = new Int8Array(count);
  for (let i = 0; i < count; i++) out[i] = ((bytes[i >> 3] as number) >> (i & 7)) & 1 ? 1 : -1;
  return out;
}

/** The workspace's pattern, from its forensic key. */
export function markPattern(key: Buffer): MarkPattern {
  // Which bands synchronise: a keyed shuffle, so nobody without the key knows.
  const order = Array.from({ length: BANDS }, (_, i) => i);
  const words = keyedBytes(key, "bands", BANDS * 4);
  for (let i = BANDS - 1; i > 0; i--) {
    const j = words.readUInt32LE(i * 4) % (i + 1);
    [order[i], order[j]] = [order[j] as number, order[i] as number];
  }
  const slot = new Int16Array(BANDS);
  order.forEach((band, i) => {
    slot[band] = i;
  });
  return {
    slot,
    syncSigns: keyedSigns(key, "sync", SYNC_BANDS),
    symbolSigns: keyedSigns(key, "symbols", PERIOD),
  };
}

/** A recipient's code, from the workspace's forensic key and the mark's id. */
export function markCode(key: Buffer, markId: string): MarkCode {
  return keyedSigns(key, `mark:${markId}`, CODE_LENGTH);
}

/** The sign of a band in the symbol at position `j` of the period. */
function signOf(pattern: MarkPattern, code: MarkCode, j: number, band: number): number {
  const slot = pattern.slot[band] as number;
  const time = pattern.symbolSigns[j] as number;
  return slot < SYNC_BANDS
    ? time * (pattern.syncSigns[slot] as number)
    : time * (code[(slot - SYNC_BANDS) * BLOCKS + Math.floor(j / BLOCK)] as number);
}

/** A periodic Hann window's square root: analysis and synthesis together sum to one. */
const window = (() => {
  const out = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++)
    out[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME));
  return out;
})();

const joinAll = (parts: Float32Array[]) => {
  if (parts.length === 1) return parts[0] as Float32Array;
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/**
 * Makes the mark for a recording, a piece at a time: given its sound at `MARK_RATE` as it
 * arrives, returns the signal to add to it, sample for sample, at the same rate. The sound is
 * the mean of the channels the mark will be added to; `peak` (optional) is the largest of
 * those channels at each sample, and the mark gives way wherever it would pass the ceiling.
 */
export class MarkEmbedder {
  private readonly pattern: MarkPattern;
  private readonly code: MarkCode;
  private readonly strength: number;
  private readonly fft = new Fft(FRAME);
  private readonly re = new Float64Array(FRAME);
  private readonly im = new Float64Array(FRAME);
  private readonly markRe = new Float64Array(FRAME);
  private readonly markIm = new Float64Array(FRAME);
  /** Sound not yet framed: the next frame starts at its beginning. */
  private input: Float32Array;
  private peaks: Float32Array;
  /** The second half of the last frame's mark, to overlap with the next. */
  private readonly tail = new Float64Array(HOP);
  private frame = 0;
  /** Samples taken in and given out, so the output ends exactly where the input did. */
  private taken = 0;
  private given = 0;
  /** The share of the strength each frame with sound kept, summed, and how many there were. */
  private kept = 0;
  private sounding = 0;

  constructor(pattern: MarkPattern, code: MarkCode, strength = DEFAULT_STRENGTH) {
    if (code.length !== CODE_LENGTH) throw new Error("A mark's code has the wrong length");
    this.pattern = pattern;
    this.code = code;
    this.strength = strength;
    // A hop of silence first, so the first samples are covered by two frames as all others are.
    this.input = new Float32Array(HOP);
    this.peaks = new Float32Array(HOP);
  }

  /**
   * How much of its strength the mark kept, on average over the frames with sound in its band:
   * 1 where the ceiling never had to make way, 0 for a recording loud everywhere. Null when
   * nothing in the band sounded (silence, or an LFE channel): there is nothing to mark there.
   */
  embedded(): number | null {
    return this.sounding === 0 ? null : this.kept / this.sounding;
  }

  /** Take more sound; return the mark for every sample now settled. */
  push(sound: Float32Array, peak?: Float32Array): Float32Array {
    this.taken += sound.length;
    this.input = this.append(this.input, sound);
    this.peaks = this.append(this.peaks, peak ?? sound.map(Math.abs));
    const out: Float32Array[] = [];
    let at = 0;
    while (this.input.length - at >= FRAME) {
      out.push(this.step(this.input, this.peaks, at));
      at += HOP;
    }
    this.input = this.input.slice(at);
    this.peaks = this.peaks.slice(at);
    return this.emit(out);
  }

  /** The sound has ended: return the rest of the mark. */
  end(): Float32Array {
    const out: Float32Array[] = [];
    const frame = new Float32Array(FRAME);
    const peaks = new Float32Array(FRAME);
    // Silence after the end, until every sample taken is settled.
    for (let settled = 0; this.given + settled < this.taken; ) {
      frame.fill(0);
      peaks.fill(0);
      frame.set(this.input.subarray(0, FRAME));
      peaks.set(this.peaks.subarray(0, FRAME));
      const piece = this.step(frame, peaks, 0);
      out.push(piece);
      settled += piece.length;
      this.input = this.input.subarray(Math.min(HOP, this.input.length));
      this.peaks = this.peaks.subarray(Math.min(HOP, this.peaks.length));
    }
    return this.emit(out);
  }

  private append(a: Float32Array, b: Float32Array) {
    const out = new Float32Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  }

  private emit(parts: Float32Array[]): Float32Array {
    const all = parts.length === 0 ? new Float32Array(0) : joinAll(parts);
    const room = this.taken - this.given;
    const out = all.length > room ? all.subarray(0, room) : all;
    this.given += out.length;
    return out;
  }

  /** One frame, from `at`: its spectrum's band, signed, back to time and overlapped; one hop settled. */
  private step(sound: Float32Array, peaks: Float32Array, at: number): Float32Array {
    const { re, im, markRe, markIm } = this;
    for (let i = 0; i < FRAME; i++) {
      re[i] = (sound[at + i] as number) * (window[i] as number);
      im[i] = 0;
    }
    this.fft.transform(re, im);
    const j = Math.floor(this.frame / SYMBOL_FRAMES) % PERIOD;
    markRe.fill(0);
    markIm.fill(0);
    // Only the band is kept, scaled by its signs; its mirror keeps the result real. The
    // imaginary parts are written conjugated, for the inverse transform below.
    for (let q = 0; q < SPAN; q++) {
      const k = LOW_BIN + q;
      const gain = this.strength * signOf(this.pattern, this.code, j, Math.floor(q / WIDTH));
      markRe[k] = (re[k] as number) * gain;
      markIm[k] = -(im[k] as number) * gain;
      markRe[FRAME - k] = markRe[k] as number;
      markIm[FRAME - k] = -(markIm[k] as number);
    }
    // The inverse transform, as the conjugate of the forward transform of the conjugate.
    this.fft.transform(markRe, markIm);
    let largest = 0;
    let loudest = 0;
    for (let i = 0; i < FRAME; i++) {
      markRe[i] = ((markRe[i] as number) / FRAME) * (window[i] as number);
      largest = Math.max(largest, Math.abs(markRe[i] as number));
      loudest = Math.max(loudest, peaks[at + i] as number);
    }
    // Two frames overlap each sample: each keeps to half of what room the sound leaves.
    const scale = largest === 0 ? 0 : Math.max(0, Math.min(1, (CEILING - loudest) / (2 * largest)));
    if (largest > 0) {
      this.kept += scale;
      this.sounding += 1;
    }
    const out = new Float32Array(HOP);
    for (let i = 0; i < HOP; i++) {
      out[i] = (this.tail[i] as number) + (markRe[i] as number) * scale;
      this.tail[i] = (markRe[HOP + i] as number) * scale;
    }
    this.frame += 1;
    // The first hop is the silence put before the sound, and is not given out.
    return this.frame === 1 ? new Float32Array(0) : out;
  }
}

/** The whole mark for a whole recording at `MARK_RATE`. */
export function markFor(
  sound: Float32Array,
  pattern: MarkPattern,
  code: MarkCode,
  strength = DEFAULT_STRENGTH,
): Float32Array {
  const embedder = new MarkEmbedder(pattern, code, strength);
  return joinAll([embedder.push(sound), embedder.end()]);
}

/**
 * Each frame's level in each band, as a logarithm, less the frame's mean: what the mark
 * changed, whatever the overall level. Frames start at `offset` and every hop after.
 */
function levels(sound: Float32Array, offset: number) {
  const frames = Math.max(0, Math.floor((sound.length - offset - FRAME) / HOP) + 1);
  const values = new Float32Array(frames * BANDS);
  const fft = new Fft(FRAME);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  for (let f = 0; f < frames; f++) {
    const start = offset + f * HOP;
    for (let i = 0; i < FRAME; i++) {
      re[i] = (sound[start + i] as number) * (window[i] as number);
      im[i] = 0;
    }
    fft.transform(re, im);
    let mean = 0;
    for (let b = 0; b < BANDS; b++) {
      let power = 1e-12;
      for (let q = 0; q < WIDTH; q++) {
        const k = LOW_BIN + b * WIDTH + q;
        power += (re[k] as number) ** 2 + (im[k] as number) ** 2;
      }
      const level = Math.log(power);
      values[f * BANDS + b] = level;
      mean += level;
    }
    mean /= BANDS;
    for (let b = 0; b < BANDS; b++)
      values[f * BANDS + b] = (values[f * BANDS + b] as number) - mean;
  }
  return { frames, values };
}

/**
 * Symbols' levels: the sum of each four frames, starting `phase` frames in, less each band's
 * mean over the symbols around it. What the music holds for a while is not the mark, whose
 * signs change from symbol to symbol.
 */
function symbols(frameLevels: { frames: number; values: Float32Array }, phase: number) {
  const count = Math.max(0, Math.floor((frameLevels.frames - phase) / SYMBOL_FRAMES));
  const sums = new Float32Array(count * BANDS);
  for (let s = 0; s < count; s++)
    for (let f = 0; f < SYMBOL_FRAMES; f++) {
      const from = (phase + s * SYMBOL_FRAMES + f) * BANDS;
      for (let b = 0; b < BANDS; b++)
        sums[s * BANDS + b] =
          (sums[s * BANDS + b] as number) + (frameLevels.values[from + b] as number);
    }
  const out = new Float32Array(count * BANDS);
  for (let b = 0; b < BANDS; b++) {
    let sum = 0;
    let n = 0;
    for (let s = 0; s < Math.min(count, REACH + 1); s++) {
      sum += sums[s * BANDS + b] as number;
      n++;
    }
    for (let s = 0; s < count; s++) {
      out[s * BANDS + b] = (sums[s * BANDS + b] as number) - sum / n;
      const enter = s + REACH + 1;
      const leave = s - REACH;
      if (enter < count) {
        sum += sums[enter * BANDS + b] as number;
        n++;
      }
      if (leave >= 0) {
        sum -= sums[leave * BANDS + b] as number;
        n--;
      }
    }
  }
  return { count, values: out };
}

/** A candidate mark: its id, and the code it would carry. */
export interface Candidate {
  id: string;
  code: MarkCode;
}

/** A candidate's score, and the chance of a score that high from a mark not there. */
export interface Score {
  id: string;
  z: number;
  chance: number;
}

export interface Detection {
  /**
   * The workspace's synchronisation signs: how strongly they were found, and the chance of
   * finding them that strongly in a recording that does not carry them.
   */
  sync: { z: number; chance: number };
  /** The best candidate, if any was compared. */
  best: Score | null;
  /** The best candidate, when its chance of being a false match is below `FALSE_MATCH_LIMIT`. */
  match: Score | null;
  /** How much sound was examined, in seconds. */
  seconds: number;
  /** How many comparisons were made: the chances count every one. */
  comparisons: number;
}

/** Hoeffding's bound on a score this high by accident, for `tries` independent tries. */
export const chanceOf = (z: number, tries: number) =>
  Math.min(1, tries * Math.exp(-(Math.max(0, z) ** 2) / 2));

/** How many positions the synchronisation is tried at. */
const SYNC_TRIES = OFFSETS * SYMBOL_FRAMES * PERIOD;

/**
 * The best scores of one pattern's candidates in a recording at `MARK_RATE` (the mean of its
 * channels): where the synchronisation signs sit best, then each candidate's code there.
 */
function scores(sound: Float32Array, pattern: MarkPattern, candidates: readonly Candidate[]) {
  type Position = { z: number; syms: { count: number; values: Float32Array }; shift: number };
  const positions: Position[] = [];
  for (let o = 0; o < OFFSETS; o++) {
    const frameLevels = levels(sound, (o * HOP) / OFFSETS);
    for (let phase = 0; phase < SYMBOL_FRAMES; phase++) {
      const syms = symbols(frameLevels, phase);
      if (syms.count === 0) continue;
      // Each symbol's agreement with the sync bands' signs.
      const h = new Float64Array(syms.count);
      let energy = 0;
      for (let s = 0; s < syms.count; s++) {
        let sum = 0;
        for (let b = 0; b < BANDS; b++) {
          const slot = pattern.slot[b] as number;
          if (slot < SYNC_BANDS)
            sum += (pattern.syncSigns[slot] as number) * (syms.values[s * BANDS + b] as number);
        }
        h[s] = sum;
        energy += sum * sum;
      }
      if (energy === 0) continue;
      const norm = Math.sqrt(energy);
      // And over time with the symbol signs, at every position in the period.
      for (let shift = 0; shift < PERIOD; shift++) {
        let c = 0;
        for (let s = 0; s < syms.count; s++)
          c += (pattern.symbolSigns[(s + shift) % PERIOD] as number) * (h[s] as number);
        const z = c / norm;
        if (positions.length < POSITIONS || z > (positions.at(-1) as Position).z) {
          positions.push({ z, syms, shift });
          positions.sort((a, b) => b.z - a.z);
          if (positions.length > POSITIONS) positions.pop();
        }
      }
    }
  }
  let best: { id: string; z: number } | null = null;
  for (const { syms, shift } of positions) {
    // What the code bands hold at each of the code's signs, the symbol signs taken off.
    const held = new Float64Array(CODE_LENGTH);
    for (let s = 0; s < syms.count; s++) {
      const j = (s + shift) % PERIOD;
      const time = pattern.symbolSigns[j] as number;
      const block = Math.floor(j / BLOCK);
      for (let b = 0; b < BANDS; b++) {
        const slot = pattern.slot[b] as number;
        if (slot >= SYNC_BANDS) {
          const i = (slot - SYNC_BANDS) * BLOCKS + block;
          held[i] = (held[i] as number) + time * (syms.values[s * BANDS + b] as number);
        }
      }
    }
    let energy = 0;
    for (let i = 0; i < CODE_LENGTH; i++) energy += (held[i] as number) ** 2;
    if (energy === 0) continue;
    const norm = Math.sqrt(energy);
    for (const candidate of candidates) {
      let c = 0;
      for (let i = 0; i < CODE_LENGTH; i++)
        c += (candidate.code[i] as number) * (held[i] as number);
      const z = c / norm;
      if (!best || z > best.z) best = { id: candidate.id, z };
    }
  }
  return { sync: positions[0]?.z ?? 0, best };
}

/**
 * Looks for marks in a recording at `MARK_RATE` (the mean of its channels), under each of the
 * patterns given (one for each version of the workspace's key that made marks), comparing
 * every candidate. The chances count every position and candidate tried, under every pattern.
 */
export function detectMarks(
  sound: Float32Array,
  groups: readonly { pattern: MarkPattern; candidates: readonly Candidate[] }[],
): Detection {
  let sync = 0;
  let best: { id: string; z: number } | null = null;
  let compared = 0;
  for (const { pattern, candidates } of groups) {
    const found = scores(sound, pattern, candidates);
    sync = Math.max(sync, found.sync);
    compared += candidates.length;
    if (found.best && (!best || found.best.z > best.z)) best = found.best;
  }
  const comparisons = POSITIONS * compared;
  const scored = best ? { ...best, chance: chanceOf(best.z, comparisons) } : null;
  return {
    sync: { z: sync, chance: chanceOf(sync, SYNC_TRIES * groups.length) },
    best: scored,
    match: scored && scored.chance < FALSE_MATCH_LIMIT ? scored : null,
    seconds: sound.length / MARK_RATE,
    comparisons,
  };
}

/** Looks for one pattern's marks: `detectMarks` with one group. */
export const detectMark = (
  sound: Float32Array,
  pattern: MarkPattern,
  candidates: readonly Candidate[],
): Detection => detectMarks(sound, [{ pattern, candidates }]);

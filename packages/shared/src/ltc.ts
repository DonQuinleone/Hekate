import type { FrameRateId } from "./comment-export.ts";
import { type RecorderTimecode, timecodeFrames } from "./recorders.ts";

/**
 * Linear timecode read from audio (#51, decision 241): a recorder's timecode out (a Sound
 * Devices 8-Series or MixPre, or any recorder that sends LTC) into an audio input on the
 * control room's computer, decoded in the browser without a dependency. The decoder is a pure
 * step over the samples as they arrive (`decodeLtc`), so the same code reads a live input and
 * a test's own signal.
 *
 * LTC is SMPTE 12M's biphase mark code: every bit begins with a transition, and a one has a
 * second in its middle, so it reads the same either way up. A frame is 80 bits, least
 * significant first in each field, ending in the sync word 0011 1111 1111 1101.
 */

/** The sync word, bits 64 to 79 as they are sent. */
const SYNC = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1];

/** A frame read: its timecode, where it began and ended (in samples), and whether it moved on. */
export interface LtcFrame {
  timecode: RecorderTimecode;
  /** The sample its first bit began at, and the one its sync word ended at. */
  start: number;
  end: number;
  /** One frame on from the frame before it: the recorder's timecode is running. */
  advancing: boolean;
}

export interface LtcState {
  sampleRate: number;
  /** Samples taken in so far: the index of the next. */
  index: number;
  /** Which side of the hysteresis band the signal was last on. */
  side: 1 | -1 | 0;
  /** A running peak, for the band to follow the input's level. */
  peak: number;
  /** The sample of the last transition, and the one before a pending half bit. */
  lastEdge: number | null;
  bitStart: number | null;
  /** Samples a bit lasts, as measured. */
  bitPeriod: number;
  /** A half bit read, waiting for its other half to make a one. */
  half: number | null;
  /** The last bits read, with the samples they began at. */
  bits: number[];
  starts: number[];
  /** Recent frames' starts, for the rate, and the last frame read. */
  frameStarts: number[];
  last: { timecode: RecorderTimecode; end: number } | null;
}

/** The nominal rates LTC runs at: 24, 25 and 30, and 23.976 and 29.97 counted as 24 and 30. */
const measuredRates: { id: FrameRateId; fps: number }[] = [
  { id: "23.976", fps: 24000 / 1001 },
  { id: "24", fps: 24 },
  { id: "25", fps: 25 },
  { id: "29.97", fps: 30000 / 1001 },
  { id: "30", fps: 30 },
];

export const initialLtcState = (sampleRate: number): LtcState => ({
  sampleRate,
  index: 0,
  side: 0,
  peak: 0,
  lastEdge: null,
  bitStart: null,
  // Start from 25 frames a second; a bit's length is followed from there.
  bitPeriod: sampleRate / (80 * 25),
  half: null,
  bits: [],
  starts: [],
  frameStarts: [],
  last: null,
});

/** The quietest input read as signal, as a share of full scale. */
const FLOOR = 0.01;

/** A field of a frame, least significant bit first. */
const field = (bits: number[], from: number, count: number) => {
  let n = 0;
  for (let i = 0; i < count; i++) n |= (bits[from + i] ?? 0) << i;
  return n;
};

/**
 * The rate a run of frames shows: dropping frames where the frame says so; otherwise the
 * standard rate nearest how often frames arrived, measured over the last second or so.
 */
function rateOf(state: LtcState, drop: boolean): FrameRateId {
  if (drop) return "29.97df";
  const starts = state.frameStarts;
  const fps =
    starts.length >= 2
      ? (state.sampleRate * (starts.length - 1)) / ((starts.at(-1) ?? 0) - (starts[0] ?? 0))
      : state.sampleRate / (80 * state.bitPeriod);
  let best = measuredRates[0] as (typeof measuredRates)[number];
  for (const r of measuredRates) if (Math.abs(r.fps - fps) < Math.abs(best.fps - fps)) best = r;
  return best.id;
}

/** A frame's 64 data bits, read; null where a digit is out of range. */
function frameOf(bits: number[], rate: (drop: boolean) => FrameRateId): RecorderTimecode | null {
  const fu = field(bits, 0, 4);
  const ft = field(bits, 8, 2);
  const drop = bits[10] === 1;
  const su = field(bits, 16, 4);
  const st = field(bits, 24, 3);
  const mu = field(bits, 32, 4);
  const mt = field(bits, 40, 3);
  const hu = field(bits, 48, 4);
  const ht = field(bits, 56, 2);
  if (fu > 9 || su > 9 || st > 5 || mu > 9 || mt > 5 || hu > 9) return null;
  const tc = {
    hours: ht * 10 + hu,
    minutes: mt * 10 + mu,
    seconds: st * 10 + su,
    frames: ft * 10 + fu,
    rate: rate(drop),
  };
  if (tc.hours > 23 || timecodeFrames(tc) === null) return null;
  return tc;
}

/** Whether one label is the frame after another. */
function follows(prev: RecorderTimecode, next: RecorderTimecode): boolean {
  const a = timecodeFrames(prev);
  const b = timecodeFrames(next);
  return a !== null && b !== null && prev.rate === next.rate && b - a === 1;
}

/**
 * Samples taken in (mono, -1 to 1): the frames they complete, in order. Transitions are found
 * through a band that follows the input's level, so hum and a quiet input are not read as
 * bits; a gap or a transition at the wrong distance starts the frame over.
 */
export function decodeLtc(
  state: LtcState,
  samples: ArrayLike<number>,
): { state: LtcState; frames: LtcFrame[] } {
  const s: LtcState = {
    ...state,
    bits: [...state.bits],
    starts: [...state.starts],
    frameStarts: [...state.frameStarts],
  };
  const frames: LtcFrame[] = [];
  // The peak falls by half in about a tenth of a second.
  const decay = 0.5 ** (1 / (s.sampleRate * 0.1));
  const minPeriod = s.sampleRate / (80 * 31);
  const maxPeriod = s.sampleRate / (80 * 23);
  const push = (bit: number, start: number, end: number) => {
    s.bits.push(bit);
    s.starts.push(start);
    if (s.bits.length > 160) {
      s.bits.splice(0, s.bits.length - 80);
      s.starts.splice(0, s.starts.length - 80);
    }
    const n = s.bits.length;
    if (n < 80) return;
    for (let i = 0; i < 16; i++) if (s.bits[n - 16 + i] !== SYNC[i]) return;
    const data = s.bits.slice(n - 80, n - 16);
    const begin = s.starts[n - 80] ?? start;
    // A frame not right after the last starts the measured run afresh.
    const previous = s.frameStarts.at(-1);
    const expected = 80 * s.bitPeriod;
    if (previous !== undefined && Math.abs(begin - previous - expected) > expected * 0.1)
      s.frameStarts = [];
    s.frameStarts.push(begin);
    if (s.frameStarts.length > 31) s.frameStarts.shift();
    const tc = frameOf(data, (drop) => rateOf(s, drop));
    if (!tc) return;
    const advancing =
      s.last !== null && follows(s.last.timecode, tc) && begin - s.last.end < expected * 0.5;
    frames.push({ timecode: tc, start: begin, end, advancing });
    s.last = { timecode: tc, end };
  };
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i] ?? 0;
    const index = s.index + i;
    s.peak = Math.max(Math.abs(x), s.peak * decay);
    const band = Math.max(FLOOR, s.peak * 0.25);
    const side = x > band ? 1 : x < -band ? -1 : s.side;
    if (side === s.side || side === 0) continue;
    const first = s.side === 0;
    s.side = side;
    if (first || s.lastEdge === null) {
      s.lastEdge = index;
      s.bitStart = index;
      continue;
    }
    const d = index - s.lastEdge;
    const edge = s.lastEdge;
    s.lastEdge = index;
    const T = s.bitPeriod;
    if (d > 0.75 * T && d < 1.5 * T && s.half === null) {
      // A whole bit without a transition inside: a zero.
      s.bitPeriod = Math.min(maxPeriod, Math.max(minPeriod, T * 0.95 + d * 0.05));
      push(0, edge, index);
      s.bitStart = index;
    } else if (d >= 0.25 * T && d <= 0.75 * T) {
      if (s.half === null) {
        s.half = d;
        s.bitStart = edge;
      } else {
        // Two halves: a one.
        const whole = s.half + d;
        s.bitPeriod = Math.min(maxPeriod, Math.max(minPeriod, T * 0.95 + whole * 0.05));
        push(1, s.bitStart ?? edge, index);
        s.half = null;
        s.bitStart = index;
      }
    } else {
      // Out of step (a long after a half, noise, or a gap): read on from this transition.
      s.half = null;
      s.bitStart = index;
      if (d >= 1.5 * T) {
        s.bits = [];
        s.starts = [];
      }
    }
  }
  s.index = state.index + samples.length;
  return { state: s, frames };
}

/**
 * Whether a recorder's timecode runs, from the frames read: rolling once three frames in a row
 * have each moved on by one (so a stray frame is not a start), stopped once none has for a
 * fifth of a second (the timecode held still, as a recorder on Rec Run holds it between takes,
 * or the signal went). Times are in samples, as the decoder counts them.
 */
export interface LtcRun {
  rolling: boolean;
  /** Frames in a row that moved on, and the sample the last of them ended at. */
  streak: number;
  lastAdvance: number | null;
}

export const initialLtcRun = (): LtcRun => ({ rolling: false, streak: 0, lastAdvance: null });

/** Frames in a row that must move on before the timecode counts as running. */
const ROLLING_AFTER = 3;
/** How long without a frame moving on before it counts as stopped, in seconds. */
const STOPPED_AFTER = 0.2;

/**
 * A frame read (or none, as time passes to `now`, in samples): the run as it stands, and what
 * changed. A frame that does not move on breaks the streak towards rolling, but stops a run
 * only as silence does, a fifth of a second on, so one frame misread never stops a take.
 */
export function ltcRunStep(
  run: LtcRun,
  frame: LtcFrame | null,
  now: number,
  sampleRate: number,
): { run: LtcRun; change: "rolling" | "stopped" | null } {
  if (frame?.advancing) {
    const streak = run.streak + 1;
    const rolling = run.rolling || streak >= ROLLING_AFTER;
    return {
      run: { rolling, streak, lastAdvance: frame.end },
      change: rolling && !run.rolling ? "rolling" : null,
    };
  }
  const streak = frame ? 0 : run.streak;
  const quiet = run.lastAdvance === null || now - run.lastAdvance > STOPPED_AFTER * sampleRate;
  if (run.rolling && quiet)
    return { run: { rolling: false, streak: 0, lastAdvance: run.lastAdvance }, change: "stopped" };
  return { run: { ...run, streak }, change: null };
}

/**
 * A loop over a passage of a recording or video: playback runs from `start` to `end` and
 * back again, optionally with some time before (pre-roll) and after (post-roll) the
 * passage so the ear settles in and out of it. Times are seconds.
 */
export interface Loop {
  start: number;
  end: number;
}

export interface Rolls {
  /** Seconds played before the loop each time round. */
  pre: number;
  /** Seconds played after the loop before going round again. */
  post: number;
}

/** Shorter than this, a loop is a click rather than a passage. */
export const MIN_LOOP = 0.05;

/** The most pre-roll or post-roll offered. */
export const MAX_ROLL = 10;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
/** To the millisecond: finer than anyone hears, and short in an address. */
const ms = (value: number) => Math.round(value * 1000) / 1000;

/** A loop between two points in either order, kept inside the media; null if too short. */
export function loopFrom(a: number, b: number, duration: number): Loop | null {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !(duration > 0)) return null;
  const start = ms(clamp(Math.min(a, b), 0, duration));
  const end = ms(clamp(Math.max(a, b), 0, duration));
  return end - start >= MIN_LOOP ? { start, end } : null;
}

/**
 * Move one edge of a loop by some seconds (negative is earlier), never past the other
 * edge or out of the media.
 */
export function nudge(loop: Loop, edge: "start" | "end", by: number, duration: number): Loop {
  if (edge === "start") {
    return { ...loop, start: ms(clamp(loop.start + by, 0, loop.end - MIN_LOOP)) };
  }
  return { ...loop, end: ms(clamp(loop.end + by, loop.start + MIN_LOOP, duration)) };
}

/** Where a loop's playback begins: the start, less any pre-roll. */
export const loopEntry = (loop: Loop, rolls: Rolls) => Math.max(0, loop.start - rolls.pre);

/**
 * Where to jump to, or null to carry on. Playback that reaches the end of the loop (plus
 * any post-roll) goes back to the start (less any pre-roll); playback that has been moved
 * outside the loop is left alone, so the playhead can still be dragged elsewhere.
 */
export function wrapTarget(time: number, loop: Loop, rolls: Rolls, duration: number) {
  const exit = Math.min(duration, loop.end + rolls.post);
  const entry = loopEntry(loop, rolls);
  // Only while inside the looped stretch: before it, or well past it, the listener moved.
  if (time < entry || time > exit + 0.5) return null;
  return time >= exit - 0.005 ? entry : null;
}

/** A loop in an address: "12.5-18.25". */
export const formatLoop = (loop: Loop) => `${loop.start}-${loop.end}`;

/** A loop from an address, or null if it is not one. */
export function parseLoop(text: string | undefined): Loop | null {
  const match = text?.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return end - start >= MIN_LOOP ? { start, end } : null;
}

/** A pre-roll or post-roll setting, kept to what is offered. */
export const roll = (value: number) =>
  Number.isFinite(value) ? clamp(Math.round(value * 10) / 10, 0, MAX_ROLL) : 0;

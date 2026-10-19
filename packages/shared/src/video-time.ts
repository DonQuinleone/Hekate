import {
  type FrameRate,
  type FrameRateId,
  frameRates,
  nearestFrameRate,
  timecode,
} from "./comment-export.ts";

/**
 * A timecode as a file writes it (#146): hours, minutes, seconds and frames, with a semicolon
 * before the frames where it drops frames.
 */
export const timecodePattern = /^(\d{2}):(\d{2}):(\d{2})([:;])(\d{2})$/;

/** How a video counts its frames: at a standard rate, from the timecode it starts at. */
export interface VideoClock {
  rate: FrameRate;
  /** The frame count of the file's first frame on its own timecode. */
  start: number;
}

const dropOf = (rate: FrameRate) => (rate.drop ? (rate.nominal === 60 ? 4 : 2) : 0);

/**
 * The frame count a timecode label stands for, the inverse of `timecode`; null for a label
 * that cannot be read at the rate, including one drop-frame timecode skips.
 */
export function labelFrames(
  label: { hours: number; minutes: number; seconds: number; frames: number },
  rate: FrameRate,
): number | null {
  const { hours, minutes, seconds, frames } = label;
  if (minutes > 59 || seconds > 59 || frames >= rate.nominal) return null;
  const drop = dropOf(rate);
  if (drop && seconds === 0 && minutes % 10 !== 0 && frames < drop) return null;
  const totalMinutes = hours * 60 + minutes;
  return (
    (totalMinutes * 60 + seconds) * rate.nominal +
    frames -
    drop * (totalMinutes - Math.floor(totalMinutes / 10))
  );
}

/**
 * A video's clock: the standard rate nearest its own, dropping frames where its timecode does
 * (at 29.97 or 59.94), counted from the timecode it starts at, or from zero where it has none.
 * Null where its frame rate is not known.
 */
export function videoClock(video: { fps?: number; timecode?: string }): VideoClock | null {
  if (!video.fps) return null;
  const id = nearestFrameRate(video.fps);
  const written = video.timecode ? timecodePattern.exec(video.timecode) : null;
  const dropId = `${id}df`;
  const rate =
    frameRates[written?.[4] === ";" && dropId in frameRates ? (dropId as FrameRateId) : id];
  const start = written
    ? labelFrames(
        {
          hours: Number(written[1]),
          minutes: Number(written[2]),
          seconds: Number(written[3]),
          frames: Number(written[5]),
        },
        rate,
      )
    : 0;
  return { rate, start: start ?? 0 };
}

/**
 * The frame showing at a time. A frame shows from its own time until the next, so a time a
 * hair short of a frame's, as arithmetic leaves one, still counts as that frame.
 */
export function frameShowing(seconds: number, rate: FrameRate): number {
  return Math.max(0, Math.floor((seconds * rate.num) / rate.den + 1e-3));
}

/** The time a frame starts showing. */
export const frameTime = (frame: number, rate: FrameRate) => (frame * rate.den) / rate.num;

/** The timecode at a time in the file, on the file's own clock. */
export const videoTimecode = (seconds: number, clock: VideoClock) =>
  timecode(clock.start + frameShowing(seconds, clock.rate), clock.rate);

/** A length as a timecode from zero: how long a file runs. */
export const timecodeFor = (seconds: number, clock: VideoClock) =>
  timecode(frameShowing(seconds, clock.rate), clock.rate);

/**
 * The frame a typed timecode means, from the file's first frame (#146). Four fields (or eight
 * digits) are a timecode on the file's own clock; fewer count from the start, right-aligned
 * as editors type them: "12:00" and "1200" are twelve seconds in, "5" is the fifth frame.
 * Null for anything that is not a timecode at the rate or falls before the file.
 */
export function parseTimecode(text: string, clock: VideoClock): number | null {
  const typed = text.trim();
  if (!/^[\d:;.,]+$/.test(typed)) return null;
  const parts = /[:;.,]/.test(typed)
    ? typed.split(/[:;.,]/)
    : (typed.padStart(typed.length + (typed.length % 2), "0").match(/\d\d/g) ?? []);
  if (parts.length === 0 || parts.length > 4 || parts.some((p) => !/^\d{1,2}$/.test(p)))
    return null;
  const [frames = 0, seconds = 0, minutes = 0, hours = 0] = parts.map(Number).reverse();
  const count = labelFrames({ hours, minutes, seconds, frames }, clock.rate);
  if (count === null) return null;
  if (parts.length < 4) return count;
  return count >= clock.start ? count - clock.start : null;
}

/** Mattes a frame can be seen through (#146): the widths cinema and television frame for. */
export const mattes = {
  "2.39": { label: "2.39:1", ratio: 2.39 },
  "1.85": { label: "1.85:1", ratio: 1.85 },
  "4:3": { label: "4:3", ratio: 4 / 3 },
} as const;

export type Matte = keyof typeof mattes;

/**
 * The bars a matte lays over a frame: above and below where the matte is wider than the
 * frame, either side where it is narrower, each as a share of the frame's height or width.
 */
export function matteBars(frameAspect: number, ratio: number): { top: number; side: number } {
  if (!(frameAspect > 0) || Math.abs(ratio - frameAspect) < 0.005) return { top: 0, side: 0 };
  return ratio > frameAspect
    ? { top: (1 - frameAspect / ratio) / 2, side: 0 }
    : { top: 0, side: (1 - ratio / frameAspect) / 2 };
}

/**
 * Safe areas as SMPTE ST 2046-1 sets them for television: action within 93% of the frame,
 * titles within 90%. Each is the inset from every edge, as a share of the frame.
 */
export const safeAreas = {
  action: (1 - 0.93) / 2,
  title: (1 - 0.9) / 2,
} as const;

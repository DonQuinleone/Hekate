import { z } from "zod";
import { type FrameRateId, frameRates, timecode } from "./comment-export.ts";
import { labelFrames } from "./video-time.ts";

/**
 * Recorders in the take log (#51, #450, decision 240): the control room's browser reads the
 * recorder live, through one adapter interface, and the take log acts on what it hears. Every
 * adapter (a DAW over MIDI, a recorder's timecode out, and later one that also knows its take
 * names, as a Zaxcom's ZaxNet does) turns what its recorder says into the same few events,
 * and only the browser that connected one drives takes from it. This module holds what those
 * events are, the timecode arithmetic they need, and what the take log does with each.
 */

/** A timecode label: hours, minutes, seconds and frames, as a recorder shows it. */
export interface TimecodeLabel {
  hours: number;
  minutes: number;
  seconds: number;
  frames: number;
}

/** A label with the rate it counts at. */
export interface RecorderTimecode extends TimecodeLabel {
  rate: FrameRateId;
}

const two = (n: number) => String(n).padStart(2, "0");

/** "10:02:14:05", or "10:02:14;05" where the rate drops frames, as the take log keeps it. */
export function timecodeLabel(tc: RecorderTimecode): string {
  const drop = frameRates[tc.rate].drop;
  return `${two(tc.hours)}:${two(tc.minutes)}:${two(tc.seconds)}${drop ? ";" : ":"}${two(tc.frames)}`;
}

/** Frames in a day of timecode at a rate, where it wraps to midnight. */
export function dayFrames(rate: FrameRateId): number {
  return labelFrames({ hours: 24, minutes: 0, seconds: 0, frames: 0 }, frameRates[rate]) ?? 0;
}

/** The frame count a label stands for at its rate; null for a label the rate skips or lacks. */
export const timecodeFrames = (tc: RecorderTimecode): number | null =>
  labelFrames(tc, frameRates[tc.rate]);

/** The label a frame count stands for, wrapping at midnight either way. */
export function timecodeAtFrame(frames: number, rate: FrameRateId): RecorderTimecode {
  const day = dayFrames(rate);
  const within = ((Math.round(frames) % day) + day) % day;
  const [hours = 0, minutes = 0, seconds = 0, f = 0] = timecode(within, frameRates[rate])
    .split(/[:;]/)
    .map(Number);
  return { hours, minutes, seconds, frames: f, rate };
}

/** A label moved on (or back) by some frames, across drop-frame skips and midnight. */
export function addFrames(tc: RecorderTimecode, frames: number): RecorderTimecode {
  const at = timecodeFrames(tc);
  if (at === null) return tc;
  return timecodeAtFrame(at + frames, tc.rate);
}

/** Seconds since midnight a label stands for, as its frames run in real time. */
export function secondsOfTimecode(tc: RecorderTimecode): number {
  const rate = frameRates[tc.rate];
  return ((timecodeFrames(tc) ?? 0) * rate.den) / rate.num;
}

/** Whether two labels are the same frame. */
export const sameFrame = (a: RecorderTimecode, b: RecorderTimecode) =>
  a.rate === b.rate &&
  a.hours === b.hours &&
  a.minutes === b.minutes &&
  a.seconds === b.seconds &&
  a.frames === b.frames;

/** A label typed or kept as text ("01:00:00:00", ";" before frames that drop), at a rate. */
export function parseTimecodeLabel(text: string, rate: FrameRateId): RecorderTimecode | null {
  const m = /^(\d{1,2})[:.](\d{2})[:.](\d{2})[:;.](\d{2})$/.exec(text.trim());
  if (!m) return null;
  const tc = {
    hours: Number(m[1]),
    minutes: Number(m[2]),
    seconds: Number(m[3]),
    frames: Number(m[4]),
    rate,
  };
  if (tc.hours > 23 || timecodeFrames(tc) === null) return null;
  return tc;
}

/**
 * Where the recorder is: the last timecode it gave, when (ms since the epoch, this browser's
 * clock), and whether it was rolling. A rolling recorder has moved on since, at its rate.
 */
export interface RecorderPosition {
  timecode: RecorderTimecode;
  at: number;
  rolling: boolean;
}

/**
 * How long a rolling position may be played on from its last word: past this, the recorder is
 * taken to have stopped saying, and its position is held where it was last heard.
 */
export const POSITION_STALE_MS = 1000;

/** The recorder's timecode now: its last, played on while it rolls, but not past a second. */
export function timecodeNow(position: RecorderPosition, now: number): RecorderTimecode {
  if (!position.rolling) return position.timecode;
  const elapsed = Math.min(Math.max(0, now - position.at), POSITION_STALE_MS) / 1000;
  const rate = frameRates[position.timecode.rate];
  return addFrames(position.timecode, Math.floor((elapsed * rate.num) / rate.den));
}

/**
 * What an adapter says. Every adapter turns its recorder's own words into these:
 * - `position`: where it is, as often as it says (a few times a second at least while rolling);
 * - `rolling` and `stopped`: its transport started or stopped moving;
 * - `record` and `record-stop`: it started or stopped recording, with the take's number or
 *   name where the recorder gives them (a DAW over MIDI gives neither);
 * - `status`: its connection changed, with words for the person who connected it.
 */
export type RecorderEvent =
  | { type: "position"; position: RecorderPosition }
  | { type: "rolling" | "stopped"; timecode: RecorderTimecode | null; at: number }
  | {
      type: "record" | "record-stop";
      timecode: RecorderTimecode | null;
      take?: { number?: number; name?: string };
      at: number;
    }
  | { type: "status"; status: RecorderStatus };

/**
 * An adapter's connection: not connected; asking the browser or the person; connected and
 * hearing the recorder; connected but hearing nothing yet; or failed, with why. A failure is
 * always said, never swallowed: the take log shows its words where the recorder is chosen.
 */
export type RecorderStatus =
  | { state: "idle" }
  | { state: "connecting" }
  | { state: "listening"; detail?: string }
  | { state: "silent"; detail: string }
  | { state: "failed"; reason: string };

/**
 * When a recorder starts and stops the take log's takes: never (it only fills in timecode),
 * when it records (a DAW's MMC record strobe, a recorder that says so), or when it rolls (a
 * DAW's timecode starting, or a recorder's timecode on Rec Run, which runs only while it
 * records).
 */
export const takeTriggers = ["off", "record", "rolling"] as const;
export type TakeTrigger = (typeof takeTriggers)[number];

/** The take the log has live, as the driver needs it. */
export interface LiveTake {
  id: string;
  lifecycle: "idle" | "armed" | "recording" | "recorded" | "aborted";
}

/** What the take log does with a recorder's event. */
export type TakeAction =
  | { kind: "start"; timecodeIn: string | null; number: number | null }
  | { kind: "roll"; takeId: string; timecodeIn: string | null }
  | { kind: "stop"; takeId: string; timecodeOut: string | null }
  | null;

/**
 * What the take log does with a recorder's event, in the browser that drives takes: start the
 * next take (or roll the one armed) when the recorder starts as the trigger says, and stop the
 * one recording when it stops. A take already recording is left alone; nothing is stopped that
 * is not recording. Every other event changes no take.
 */
export function takeActionFor(
  event: RecorderEvent,
  trigger: TakeTrigger,
  live: LiveTake | null,
): TakeAction {
  if (trigger === "off") return null;
  const starts = trigger === "record" ? "record" : "rolling";
  const stops = trigger === "record" ? ["record-stop", "stopped"] : ["stopped"];
  if (event.type === starts) {
    const timecodeIn = event.timecode ? timecodeLabel(event.timecode) : null;
    if (live?.lifecycle === "recording") return null;
    if (live?.lifecycle === "armed") return { kind: "roll", takeId: live.id, timecodeIn };
    const number = event.type === "record" ? (event.take?.number ?? null) : null;
    return { kind: "start", timecodeIn, number };
  }
  if (stops.includes(event.type) && "timecode" in event && live?.lifecycle === "recording")
    return {
      kind: "stop",
      takeId: live.id,
      timecodeOut: event.timecode ? timecodeLabel(event.timecode) : null,
    };
  return null;
}

/** How often the browser driving takes says it still is, and how long that holds. */
export const RECORDER_HEARTBEAT_MS = 10_000;
export const RECORDER_GONE_MS = 30_000;

/** An adapter's name, as the registry in the web app knows it ("daw-midi", "sound-devices"). */
export const recorderKind = z.string().regex(/^[a-z0-9-]{1,40}$/, "An adapter's name");

/** Driving a session's takes from a recorder connected in this browser. */
export const recorderClaimInput = z.object({ kind: recorderKind });
export type RecorderClaim = z.infer<typeof recorderClaimInput>;

/** Who drives a session's takes from a recorder, as everyone in the room sees it. */
export interface SessionRecorder {
  kind: string;
  by: { id: string; name: string };
  /** When their browser last said it still drives. */
  seenAt: string;
}

/** Whether the browser that claimed a session's recorder still holds it. */
export const recorderHeld = (seenAt: Date | null, now: Date) =>
  seenAt !== null && now.getTime() - seenAt.getTime() <= RECORDER_GONE_MS;

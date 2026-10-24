import { POSITION_STALE_MS, type RecorderPosition, secondsOfTimecode } from "@hekate/shared";
import { type FollowStep, followStep } from "../listening";

/**
 * The player chasing a DAW (#450, decision 240): playback follows the recorder's position,
 * less where the file starts on the DAW's timeline, moving only past half a second as a
 * listening room's listener does (`followStep`), so a member leading a room from the file page
 * leads it from the DAW, with nothing new on the server.
 */

const DAY = 24 * 60 * 60;

/** Seconds since midnight the recorder is at now: its last word, played on while it rolls. */
export function recorderSeconds(position: RecorderPosition, now: number): number {
  const base = secondsOfTimecode(position.timecode);
  if (!position.rolling) return base;
  return base + Math.min(Math.max(0, now - position.at), POSITION_STALE_MS) / 1000;
}

/**
 * Where in the file the recorder is: its seconds less the file's start, across midnight both
 * ways (a file starting at 23:59:00:00 and a DAW at 00:00:30:00 is ninety seconds in).
 */
export function fileTime(position: RecorderPosition, startsAt: number, now: number): number {
  let t = recorderSeconds(position, now) - startsAt;
  if (t < -DAY / 2) t += DAY;
  if (t > DAY / 2) t -= DAY;
  return t;
}

/**
 * The step from where the player is to where the DAW is: play while it rolls and pause when
 * it stops, seeking only when the two have drifted. Before the file's start the player waits
 * paused at its start; past its end, at its end.
 */
export function chaseStep(
  local: { time: number; paused: boolean; rate: number; duration: number },
  position: RecorderPosition,
  startsAt: number,
  now: number,
): FollowStep {
  const t = fileTime(position, startsAt, now);
  const before = t < 0;
  const after = Number.isFinite(local.duration) && t >= local.duration;
  const playing = position.rolling && !before && !after;
  const step = followStep(
    local,
    { playing, position: Math.max(0, t), rate: 1, at: new Date(now).toISOString() },
    now,
    false,
  );
  return step;
}

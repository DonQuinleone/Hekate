import { type ListeningRoom, positionAt } from "@hekate/shared";

/**
 * Following a listening room's leader (#200), as pure steps the page's hook applies to its
 * media element: where the leader is now, by the server's clock, and what to do to be there.
 */

/** How far a listener may drift from the leader before being moved back: half a second. */
export const FOLLOW_TOLERANCE = 0.5;

/**
 * The server's clock less this browser's, from an event's `now` and when it arrived. A
 * listener's clock that runs fast or slow then plays the leader's position, not its own.
 */
export const clockOffset = (serverNow: string, receivedAt: number) =>
  Date.parse(serverNow) - receivedAt;

/** What the listener's player should do to be where the leader is. */
export interface FollowStep {
  /** Seek here first, or not at all. */
  seek: number | null;
  /** Play or pause; null to leave it as it is. */
  play: boolean | null;
  rate: number | null;
}

/**
 * The step from where the listener's player is to where the leader is now: seek when it has
 * drifted (or on every change the leader made, as `moved` says), play or pause to match, and
 * take the leader's speed. A player still finding its feet is left to settle first.
 */
export function followStep(
  local: { time: number; paused: boolean; rate: number; duration: number },
  room: Pick<ListeningRoom, "playing" | "position" | "rate" | "at">,
  serverNow: number,
  moved: boolean,
): FollowStep {
  const target = positionAt(room, serverNow);
  // Past the end of this file, the leader's position is its end.
  const at = Number.isFinite(local.duration) ? Math.min(target, local.duration) : target;
  const drifted = Math.abs(local.time - at) > FOLLOW_TOLERANCE;
  return {
    seek: drifted || (moved && Math.abs(local.time - at) > 0.05) ? at : null,
    play: room.playing === local.paused ? room.playing : null,
    rate: local.rate === room.rate ? null : room.rate,
  };
}

/** What the leader sends: their file and media element as they are now. */
export function leaderState(fileId: string, media: HTMLMediaElement) {
  return {
    fileId,
    playing: !media.paused && !media.ended,
    position: Math.max(0, Number.isFinite(media.currentTime) ? media.currentTime : 0),
    rate: Math.min(4, Math.max(0.25, media.playbackRate || 1)),
  };
}

/**
 * Sends the leader's moves one at a time, newest last: a burst (dragging the playhead) sends
 * the first at once and then only the latest, so the room is never moved backwards by a slow
 * request arriving after a later one.
 */
export function createSender<T>(send: (value: T) => Promise<unknown>) {
  let pending: { value: T } | null = null;
  let busy = false;
  const drain = async () => {
    busy = true;
    while (pending) {
      const { value } = pending;
      pending = null;
      try {
        await send(value);
      } catch {
        // A move refused or lost is overtaken by the next; the room keeps the last that landed.
      }
    }
    busy = false;
  };
  return (value: T) => {
    pending = { value };
    if (!busy) void drain();
  };
}

import { z } from "zod";

/**
 * Listening together (#200): one member leads a listening room, and everyone who joins hears
 * what they play, as they play it. The room carries only where the leader is (which file,
 * playing or paused, the position, the speed); every listener's player fetches that file
 * through their own protected stream and permissions, so nothing of the media passes from the
 * leader to anyone.
 */

/** The longest position a room holds: two days, as the file page's own start time allows. */
export const LISTENING_MAX_POSITION = 172_800;

/** How often a connected page says it is still there, and how long that holds. */
export const LISTENING_HEARTBEAT_MS = 15_000;
/** A listener not heard from in this long has gone. */
export const LISTENER_GONE_MS = 45_000;
/** A room whose leader has not been heard from in this long has ended. */
export const LEADER_GONE_MS = 90_000;
/**
 * How often a connected page reads its room again in any case: the fallback when word between
 * replicas cannot arrive (behind a transaction pooler, decision 188).
 */
export const LISTENING_REREAD_MS = 5_000;

/** Starting a room, on the file the leader has open. */
export const startListeningInput = z.object({ fileId: z.uuid() });
export type StartListeningInput = z.infer<typeof startListeningInput>;

/** Where the leader is now: what they play, whether it plays, from where, and how fast. */
export const listeningStateInput = z.object({
  fileId: z.uuid(),
  playing: z.boolean(),
  position: z.number().min(0).max(LISTENING_MAX_POSITION),
  rate: z.number().min(0.25).max(4).default(1),
});
export type ListeningStateInput = z.input<typeof listeningStateInput>;

export interface ListeningPerson {
  id: string;
  name: string;
}

/** A room as everyone in it sees it. */
export interface ListeningRoom {
  id: string;
  projectId: string;
  leader: ListeningPerson;
  /** What the leader plays; null once that file is deleted, until they choose another. */
  fileId: string | null;
  playing: boolean;
  /** Seconds into the file at `at`. */
  position: number;
  rate: number;
  /** When `position` was true, by the server's clock. */
  at: string;
  /** Counts the leader's changes, so a page applies each once. */
  revision: number;
  /** Who else is in it now, leader excluded, by name. */
  listeners: ListeningPerson[];
}

/** What a room's stream sends: the room, and the server's time as it was sent. */
export interface ListeningEvent {
  room: ListeningRoom;
  now: string;
}

/** Where the leader is at `now` (ms since the epoch, the server's clock): played on from `at`. */
export function positionAt(
  room: Pick<ListeningRoom, "playing" | "position" | "rate" | "at">,
  now: number,
): number {
  if (!room.playing) return room.position;
  const elapsed = Math.max(0, now - Date.parse(room.at)) / 1000;
  return Math.min(LISTENING_MAX_POSITION, room.position + elapsed * room.rate);
}

/** Whether a room is open: not ended, and its leader heard from lately. */
export function roomOpen(
  room: { endedAt: Date | null; leaderSeenAt: Date | null },
  now: Date,
): boolean {
  if (room.endedAt) return false;
  if (!room.leaderSeenAt) return false;
  return now.getTime() - room.leaderSeenAt.getTime() <= LEADER_GONE_MS;
}

/** Whether someone in a room is still there. */
export const stillThere = (seenAt: Date, now: Date) =>
  now.getTime() - seenAt.getTime() <= LISTENER_GONE_MS;

import type { SessionDetail, TakeLifecycle } from "@hekate/shared";

/**
 * The take log's reckoning (#51): which take the keys act on, how long it has rolled, and how
 * long the slot has left. Every time is worked out from the clock when it is shown, never
 * counted up by a timer, so the log keeps true time through a laptop's sleep.
 */

export type LoggedTake = SessionDetail["takeRows"][number];

/** The session's takes in the order they were logged. */
export const logOrder = (rows: readonly LoggedTake[]) =>
  [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.number - b.number);

const live: readonly TakeLifecycle[] = ["armed", "recording"];

/** The take rolling or armed, the newest if more than one is; null when none is. */
export function liveTake(rows: readonly LoggedTake[]): LoggedTake | null {
  return (
    logOrder(rows)
      .filter((t) => live.includes(t.lifecycle))
      .at(-1) ?? null
  );
}

/** The take the keys act on: the live one, else the last logged. */
export const keyTake = (rows: readonly LoggedTake[]) =>
  liveTake(rows) ?? logOrder(rows).at(-1) ?? null;

/** How long a take has rolled, or rolled for, in whole seconds; 0 before it starts. */
export function rolled(take: Pick<LoggedTake, "wallIn" | "wallOut">, now: number): number {
  if (!take.wallIn) return 0;
  const end = take.wallOut ? Date.parse(take.wallOut) : now;
  return Math.max(0, Math.floor((end - Date.parse(take.wallIn)) / 1000));
}

/** Under ten minutes left, the countdown turns to the signal colour. */
export const SLOT_WARNING = 10 * 60;

/**
 * The session clock's state, for its colour: plenty of time, under ten minutes, or over the slot
 * (with by how much, since a slot running over is what the room most needs to see).
 */
export type SlotStatus =
  | { kind: "plenty" | "short"; left: number }
  | { kind: "over"; over: number }
  | null;

export function slotStatus(session: Pick<SessionDetail, "slotEnd">, now: number): SlotStatus {
  if (!session.slotEnd) return null;
  const left = Math.floor((Date.parse(session.slotEnd) - now) / 1000);
  if (left < 0) return { kind: "over", over: -left };
  return { kind: left < SLOT_WARNING ? "short" : "plenty", left };
}

/** "4:07", or "1:04:07" past the hour. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** The track the next take is of: the one chosen, else the last take's, else the session's first. */
export function nextTrack(
  chosen: string | null,
  rows: readonly LoggedTake[],
  tracks: readonly { id: string }[],
): string | null {
  if (chosen && tracks.some((t) => t.id === chosen)) return chosen;
  const last = keyTake(rows);
  if (last && tracks.some((t) => t.id === last.track.id)) return last.track.id;
  return tracks[0]?.id ?? null;
}

const two = (n: number) => String(n).padStart(2, "0");

/** A slot's time typed as "14:00" on a session's day (today without one), as a moment. */
export function slotMoment(day: string | null, time: string, today = new Date()): string | null {
  if (!/^\d{2}:\d{2}$/.test(time)) return null;
  const date = day ?? `${today.getFullYear()}-${two(today.getMonth() + 1)}-${two(today.getDate())}`;
  const moment = new Date(`${date}T${time}:00`);
  return Number.isNaN(moment.getTime()) ? null : moment.toISOString();
}

/** A moment as the time a slot input shows, in the browser's own time zone: "14:00". */
export function slotTime(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  return `${two(at.getHours())}:${two(at.getMinutes())}`;
}

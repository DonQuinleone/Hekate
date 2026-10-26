import type { EditDecisions, TakePlace } from "@hekate/shared";
import { barsUsedOf } from "./edit-decisions";
import { type Loop, loopFrom } from "./loop";

/**
 * A take's timecode in and out, as the session's table and the take's page write it:
 * "10:14:02:00 – 10:19:40:00", or with the out point's hours left off where they are the
 * in point's ("10:14:02:00 – 19:40:00"). Null where neither is known.
 */
export function timecodeSpan(
  timecodeIn: string | null,
  timecodeOut: string | null,
  short = false,
): string | null {
  if (!timecodeIn && !timecodeOut) return null;
  if (!timecodeOut) return `${timecodeIn} –`;
  if (!timecodeIn) return `– ${timecodeOut}`;
  const sameHour = timecodeIn.slice(0, 3) === timecodeOut.slice(0, 3);
  return `${timecodeIn} – ${short && sameHour ? timecodeOut.slice(3) : timecodeOut}`;
}

/**
 * Where the latest version's edit decision list uses a take (#56): "V3 bars 12–40", with
 * every stretch it uses ("V3 bars 12–40, 52–60"), "V3" where the list places none by bars,
 * or null where it does not use the take.
 */
export function usedInLabel(d: EditDecisions | null | undefined, takeId: string): string | null {
  if (!d?.uses.some((u) => u.takeId === takeId)) return null;
  const version = `V${d.version.number}`;
  const ranges = barsUsedOf(d, takeId).sort((a, b) => a[0] - b[0]);
  if (ranges.length === 0) return version;
  const one = ranges.length === 1 && ranges[0]?.[0] === ranges[0]?.[1];
  const bars = ranges.map(([from, to]) => (from === to ? String(from) : `${from}–${to}`));
  return `${version} ${one ? "bar" : "bars"} ${bars.join(", ")}`;
}

/** "2 false starts", or null for none. */
export const falseStartsLabel = (n: number) =>
  n > 0 ? `${n} false ${n === 1 ? "start" : "starts"}` : null;

/** Where a take lies in the score, in a line: "p. 7 · bars 64–88"; null without bars. */
export function coverageLabel(t: Pick<TakePlace, "page" | "barFrom" | "barTo">): string | null {
  if (t.barFrom === null) return null;
  const to = t.barTo ?? t.barFrom;
  const bars = to === t.barFrom ? `bar ${t.barFrom}` : `bars ${t.barFrom}–${to}`;
  return t.page ? `p. ${t.page} · ${bars}` : bars;
}

/**
 * What the take page's Loop plays: the take from its in point to its out point, where they
 * are given, else the whole of it. Null where that is too short to loop or its length unknown.
 */
export function takeLoop(
  t: Pick<TakePlace, "inPoint" | "outPoint">,
  duration: number | null,
): Loop | null {
  if (duration === null || !(duration > 0)) return null;
  return loopFrom(t.inPoint ?? 0, t.outPoint ?? duration, duration);
}

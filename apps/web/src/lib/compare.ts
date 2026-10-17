import type { CompareFamily } from "./queries";

/**
 * Quick comparison (#44): flip between a track's variations and versions at the same
 * position. Times are assumed to line up across versions until alignment (#33) maps them.
 */

/** As many sources as there are number keys a hand reaches without looking. */
export const MAX_SOURCES = 4;

export interface CompareSource {
  fileId: string;
  /** "V3 · Wet mix": which version, and which treatment. */
  label: string;
  versionNumber: number;
}

/**
 * What a file can be compared with: the other variations of its version, then the primary
 * variation of every other version, newest first. Only files ready to play are offered.
 */
export function compareSources(track: CompareFamily, fileId: string): CompareSource[] {
  const versions = [...track.versions].sort((a, b) => b.number - a.number);
  const mine = versions.find((v) => v.variations.some((x) => x.fileId === fileId));
  const label = (n: number, name: string) => `V${n} · ${name}`;
  const ready = (status: string) => status === "ready";
  const siblings = (mine?.variations ?? [])
    .filter((x) => x.fileId !== fileId && ready(x.streamStatus))
    .sort((a, b) => a.position - b.position)
    .map((x) => ({
      fileId: x.fileId,
      label: label(mine?.number ?? 0, x.name),
      versionNumber: mine?.number ?? 0,
    }));
  const others = versions
    .filter((v) => v.id !== mine?.id)
    .flatMap((v) => {
      const primary = v.variations.find((x) => x.isPrimary) ?? v.variations[0];
      return primary && ready(primary.streamStatus)
        ? [
            {
              fileId: primary.fileId,
              label: label(v.number, primary.name),
              versionNumber: v.number,
            },
          ]
        : [];
    });
  return [...siblings, ...others];
}

/** Any ready variation of the track as a source, whichever version it belongs to. */
export function sourceFor(track: CompareFamily, fileId: string): CompareSource | undefined {
  for (const v of track.versions) {
    const x = v.variations.find((y) => y.fileId === fileId);
    if (x) {
      return x.streamStatus === "ready"
        ? { fileId, label: `V${v.number} · ${x.name}`, versionNumber: v.number }
        : undefined;
    }
  }
  return undefined;
}

const measuredLevel = (l: number | null | undefined): l is number =>
  typeof l === "number" && Number.isFinite(l);

/** Whether every source has an integrated loudness, so they can be matched at all. */
export const levelMatchable = (loudness: (number | null | undefined)[]) =>
  loudness.length > 1 && loudness.every(measuredLevel);

/**
 * Gains that bring every source to the quietest one's integrated loudness, so a louder
 * mix never sounds better for being louder. Until every source is measured, all play as
 * they are: turning some down and not others would bias the comparison.
 * Gains only ever turn down: a media element cannot play above full volume.
 */
export function levelGains(loudness: (number | null | undefined)[]): number[] {
  if (!levelMatchable(loudness)) return loudness.map(() => 1);
  const measured = loudness.filter(measuredLevel);
  const quietest = Math.min(...measured);
  return measured.map((l) => Math.min(1, 10 ** ((quietest - l) / 20)));
}

/** How far a gain turns a source down, for showing beside it: "−2.4 dB". */
export function gainLabel(gain: number) {
  if (gain >= 0.9995) return "0 dB";
  return `−${Math.abs(20 * Math.log10(gain)).toFixed(1)} dB`;
}

/**
 * For blind listening: which source sits behind each key, shuffled, so neither the key
 * nor its place in the list says which source it is.
 */
export function blindOrder(count: number, random: () => number = Math.random): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j] as number, order[i] as number];
  }
  return order;
}

/** The letter for a key in blind listening: A for 1, B for 2. */
export const blindLetter = (key: number) => "ABCD"[key] ?? "?";

/** How far a source is offset from this file, beside it: "1.5 s earlier", "0.3 s later". */
export function shiftLabel(shift: number) {
  const amount = `${Math.abs(shift).toFixed(1)} s`;
  return shift < 0 ? `${amount} earlier` : `${amount} later`;
}

/** Followers drift a little; past this, they are put back on the master's time. */
export const DRIFT_TOLERANCE = 0.08;

export const needsResync = (master: number, follower: number) =>
  Math.abs(master - follower) > DRIFT_TOLERANCE;

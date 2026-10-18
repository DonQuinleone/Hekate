import { channelPairs, type LoudnessSeries } from "@hekate/shared";

/**
 * Phase between any two channels (#74): the pairs a multichannel recording's series keeps, by
 * their speakers' names, and the correlation of the one chosen at a frame.
 */

/** Each pair of channels by its speakers' names, "L–R", in the series' order. */
export const pairNames = (channels: number, names: readonly string[]) =>
  channelPairs(channels).map(([a, b]) => `${names[a] ?? a + 1}–${names[b] ?? b + 1}`);

/**
 * The correlation at a frame: of the chosen pair where the series keeps every pair, else of
 * the front pair, as files measured before pairs were kept have; 0 outside the file.
 */
export function phaseAt(series: LoudnessSeries, frame: number | null, pair: number): number {
  if (frame === null) return 0;
  const count = series.hasPairs ? (series.channels * (series.channels - 1)) / 2 : 0;
  if (count > 1 && pair < count) return series.pairs[frame * count + pair] ?? 0;
  return series.phase[frame] ?? 0;
}

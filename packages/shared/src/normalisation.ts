import { z } from "zod";

/**
 * Normalised playback (#240): a recording heard at its delivery target's loudness, so a louder
 * version is not mistaken for a better one. Off; each person's choice, for roles with the
 * tool; or always, for everyone who hears the project.
 */
export const normalisationModes = ["off", "optional", "forced"] as const;
export const normalisationMode = z.enum(normalisationModes);
export type NormalisationMode = z.infer<typeof normalisationMode>;

export const normalisationWords: Record<NormalisationMode, string> = {
  off: "Off",
  optional: "Each person's choice",
  forced: "Always",
};

/**
 * The volume that brings a recording's integrated loudness to the target. Only ever down: a
 * media element cannot play above full volume, and turning a quiet recording up would clip
 * its peaks. A recording under the target plays as it is.
 */
export function normalisedGain(integrated: number, target: number): number {
  if (!Number.isFinite(integrated) || !Number.isFinite(target)) return 1;
  return Math.min(1, 10 ** ((target - integrated) / 20));
}

/** What a file's player is told: how normalisation applies here, and the volume it means. */
export interface Normalisation {
  mode: Exclude<NormalisationMode, "off">;
  /** The delivery profile's loudness target, in LUFS. */
  target: number;
  /** The volume, from 0 to 1, that brings the recording to the target (or 1, under it). */
  gain: number;
}

/**
 * What the player says it is doing: brought down to the target, or, for a recording already
 * under it, left as it is. It never claims a level the recording was not brought to.
 */
export function normalisationLabel(normalisation: Pick<Normalisation, "target" | "gain">): string {
  const target = `${normalisation.target.toFixed(0).replace("-", "−")} LUFS`;
  return normalisation.gain < 1 ? `Normalised to ${target}` : `As it is: at or under ${target}`;
}

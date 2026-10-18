import { FIELD_BINS, FIELD_CENTRE } from "@hekate/shared";

/**
 * Reading the stereo field (#34): where the front pair's energy sits at a moment, from the
 * shares the analysis keeps for each frame, as a goniometer shows it.
 */

/** Steps from the centre, -8 to 8, of a bin; the flat bin is both ends. */
const stepOf = (bin: number) => bin - FIELD_CENTRE;

/**
 * Bins this far from the centre or further lie beyond the speakers: where unrelated left and
 * right (a wide room, a reverb) spill some energy, and out-of-phase material puts most of it.
 */
const BEYOND_STEP = 5;

export interface FieldReading {
  /** Where it leans, or null in silence. */
  lean: "left" | "centre" | "right" | null;
  /** The share of the energy beyond the speakers, from 0 to 1. */
  beyond: number;
}

export function readField(shares: ArrayLike<number>): FieldReading {
  let total = 0;
  let weighted = 0;
  let outside = 0;
  for (let bin = 0; bin < FIELD_BINS; bin++) {
    const share = shares[bin] ?? 0;
    const step = stepOf(bin);
    total += share;
    if (Math.abs(step) >= BEYOND_STEP) outside += share;
    // Flat across is neither side.
    if (Math.abs(step) < 8) weighted += share * step;
  }
  if (!(total > 0)) return { lean: null, beyond: 0 };
  const mean = weighted / total;
  return {
    lean: Math.abs(mean) < 0.5 ? "centre" : mean < 0 ? "left" : "right",
    beyond: outside / total,
  };
}

/** The reading in words: "Centred", "Leans left, 12% beyond the speakers". */
export function describeField({ lean, beyond }: FieldReading): string {
  if (lean === null) return "Silent";
  const where = lean === "centre" ? "Centred" : `Leans ${lean}`;
  return beyond >= 0.05 ? `${where}, ${Math.round(beyond * 100)}% beyond the speakers` : where;
}

/** More than half beyond the speakers: more out of phase than any wide mix, worth a look. */
export const mostlyBeyond = ({ beyond }: FieldReading) => beyond > 0.5;

/**
 * The outline a goniometer's trace fills, as points from the centre of a half disc of radius
 * 1 (x to the right, y up), left to right: each bin at its angle, at a radius by the square
 * root of its share against the largest, so a quiet direction still shows.
 */
export function fieldOutline(shares: ArrayLike<number>): { x: number; y: number }[] {
  let largest = 0;
  for (let bin = 0; bin < FIELD_BINS; bin++) largest = Math.max(largest, shares[bin] ?? 0);
  if (!(largest > 0)) return [];
  const steps = Array.from({ length: FIELD_BINS + 1 }, (_, i) => i - 8);
  return steps.map((step) => {
    const bin = (step === -8 ? 8 : step) + FIELD_CENTRE;
    const radius = Math.sqrt((shares[bin] ?? 0) / largest);
    const angle = (step * Math.PI) / FIELD_BINS;
    return { x: radius * Math.sin(angle), y: radius * Math.cos(angle) };
  });
}

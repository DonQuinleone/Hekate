import { z } from "zod";

const label = (what: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${what} needs a name`)
    .max(max, `${what} names can be at most ${max} characters`);

export const trackName = label("A track", 200);
export const variationName = label("A variation", 80);

export const createTrackInput = z.object({
  name: trackName,
  /** A score in the same project, for bar anchors and the score view. */
  scoreFileId: z.uuid().nullish(),
  /** The folder it sits in, like a folder of its own; null or left out is the top. */
  folderId: z.uuid().nullish(),
});

export const updateTrackInput = z
  .object({
    name: trackName.optional(),
    scoreFileId: z.uuid().nullable().optional(),
    position: z.number().int().nonnegative().optional(),
    /** Move it to a folder; null is the top of the project. */
    folderId: z.uuid().nullable().optional(),
  })
  .refine((t) => Object.keys(t).length > 0, { message: "Nothing to change" });

const variationInput = z.object({
  fileId: z.uuid(),
  name: variationName,
  primary: z.boolean().optional(),
});

/**
 * A new version of a track: the next number, with its variations. Every version has at
 * least one variation and exactly one primary; when none is marked, the first is primary.
 */
export const createVersionInput = z
  .object({
    notes: z.string().trim().max(2000).optional(),
    variations: z.array(variationInput).min(1, "A version needs at least one file").max(16),
  })
  .refine((v) => v.variations.filter((x) => x.primary).length <= 1, {
    message: "Only one variation can be primary",
    path: ["variations"],
  })
  .refine((v) => new Set(v.variations.map((x) => x.fileId)).size === v.variations.length, {
    message: "A file can be one variation only",
    path: ["variations"],
  });

export const addVariationInput = variationInput;

/** The variations as they will be stored: positions in order, and exactly one primary. */
export function withPrimary<T extends { primary?: boolean }>(
  variations: T[],
): (T & { isPrimary: boolean; position: number })[] {
  const primary = Math.max(
    0,
    variations.findIndex((v) => v.primary),
  );
  return variations.map((v, position) => ({ ...v, isPrimary: position === primary, position }));
}

/** A variation name from a file name: "Maple Leaf Rag - Dry mix v3.wav" reads "Dry mix v3". */
export function variationNameFrom(fileName: string, trackName?: string): string {
  let name = fileName.replace(/\.[a-z0-9]{1,5}$/i, "").trim();
  if (trackName) {
    const escaped = trackName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    name = name.replace(new RegExp(`^${escaped}\\s*[-–_:]\\s*`, "i"), "");
  }
  return name.slice(0, 80) || "Main";
}

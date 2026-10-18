import { z } from "zod";
import type { DeliveryProfile } from "./qa.ts";

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
/**
 * What becomes of each of the previous version's open threads on the new one (decision
 * 029): carried and shown (the default), carried but hidden, or settled as it lands.
 */
export const carryChoices = ["open", "hidden", "fixed", "wont_fix"] as const;
export type CarryChoice = (typeof carryChoices)[number];

export const createVersionInput = z
  .object({
    notes: z.string().trim().max(2000).optional(),
    variations: z.array(variationInput).min(1, "A version needs at least one file").max(16),
    /** The previous version's threads, by id, where not simply carried and shown. */
    carry: z.record(z.uuid(), z.enum(carryChoices)).optional(),
    /** An edit decision list in the same project: how this version was cut from the takes. */
    edlFileId: z.uuid().nullish(),
    /** Let it in past the project's version checks: for those who may edit workflows. */
    letThrough: z.boolean().optional(),
  })
  .refine((v) => v.variations.filter((x) => x.primary).length <= 1, {
    message: "Only one variation can be primary",
    path: ["variations"],
  })
  .refine((v) => new Set(v.variations.map((x) => x.fileId)).size === v.variations.length, {
    message: "A file can be one variation only",
    path: ["variations"],
  });

export type CreateVersionInput = z.input<typeof createVersionInput>;

export const addVariationInput = variationInput;

/** A version's edit decision list (#56): an .edl file of the project, or null to take it off. */
export const versionEdlInput = z.object({ fileId: z.uuid().nullable() });

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

/** Replacing a variation's file: the new file takes its place, and its threads follow. */
export const replaceVariationInput = z.object({ fileId: z.uuid() });

/** What a project checks before a new version lands; off unless the project asks. */
export interface VersionChecks {
  /** Refuse audio whose true peak is over the delivery profile's ceiling. */
  truePeak: boolean;
  /** Refuse a version without an edit decision list. */
  edl: boolean;
}

/** A file of a new version, as the checks see it. */
export interface CheckedFile {
  /** Its id, where the caller needs to find the file again. */
  id?: string;
  name: string;
  /** Audio channels; files without audio are not checked; undefined until it is probed. */
  channels: number | null | undefined;
  /** Its highest true peak in dBTP; undefined while it is still being measured. */
  truePeak: number | null | undefined;
}

export type VersionRefusal =
  | { check: "true_peak"; file: string; truePeak: number; ceiling: number; message: string }
  | { check: "measuring"; file: string; message: string }
  | { check: "edl"; message: string };

const dB = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1).replace("-", "\u2212")}`;

/**
 * Why a new version may not land, if it may not: the project's checks against its files.
 * The ceiling is the delivery profile's (or the one suggested by each file's channels).
 * A file still being measured cannot be judged yet, which is a refusal of its own.
 */
export function versionRefusals(
  checks: VersionChecks,
  /** The profile each file is measured against (see `effectiveProfile`). */
  profileOf: (file: CheckedFile & { channels: number }) => DeliveryProfile,
  files: CheckedFile[],
  hasEdl: boolean,
): VersionRefusal[] {
  const out: VersionRefusal[] = [];
  if (checks.truePeak) {
    for (const f of files) {
      if (f.channels === null || f.channels === 0) continue;
      if (f.channels === undefined || f.truePeak === undefined) {
        out.push({
          check: "measuring",
          file: f.name,
          message: `${f.name} is still being measured; its true peak is checked once that finishes.`,
        });
        continue;
      }
      const chosen = profileOf({ ...f, channels: f.channels });
      if (f.truePeak !== null && f.truePeak > chosen.truePeakMax) {
        out.push({
          check: "true_peak",
          file: f.name,
          truePeak: f.truePeak,
          ceiling: chosen.truePeakMax,
          message: `The upload workflow refused ${f.name}: true peak ${dB(f.truePeak)} dBTP is over the ${dB(chosen.truePeakMax)} dBTP ceiling of ${chosen.label}. Fix the export and upload again, or ask a producer to let it through.`,
        });
      }
    }
  }
  if (checks.edl && !hasEdl) {
    out.push({
      check: "edl",
      message:
        "This project asks for an edit decision list with every version. Attach the EDL, or ask a producer to let it through.",
    });
  }
  return out;
}

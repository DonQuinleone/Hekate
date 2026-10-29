import { z } from "zod";
import type { DeliveryProfile } from "./qa.ts";
import { workflowRestartInput } from "./workflows.ts";

const label = (what: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${what} needs a name`)
    .max(max, `${what} names can be at most ${max} characters`);

export const trackName = label("A track", 200);
export const variantName = label("A variant", 80);
/** @deprecated The name before decision 275; release 2 of the rename removes it. Use `variantName`. */
export const variationName = variantName;

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
    /** Its deadline (#505), an instant; null clears it. */
    dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .refine((t) => Object.keys(t).length > 0, { message: "Nothing to change" });

const variantInput = z.object({
  fileId: z.uuid(),
  name: variantName,
  primary: z.boolean().optional(),
});

/**
 * A new version of a track: the next number, with its variants. Every version has at
 * least one variant and exactly one primary; when none is marked, the first is primary.
 */
/**
 * What becomes of each of the previous version's open threads on the new one (decision
 * 029): carried and shown (the default), carried but hidden, or settled as it lands.
 */
export const carryChoices = ["open", "hidden", "fixed", "wont_fix"] as const;
export type CarryChoice = (typeof carryChoices)[number];

const versionVariants = z.array(variantInput).min(1, "A version needs at least one file").max(16);

const versionFields = z.object({
  notes: z.string().trim().max(2000).optional(),
  /** The version's files, each a variant; one is primary. */
  variants: versionVariants.optional(),
  /**
   * @deprecated The field's name before decision 275, read for one release so a client of the
   * release before still lands versions; release 2 of the rename removes it. Send `variants`.
   */
  variations: versionVariants.optional(),
  /** The previous version's threads, by id, where not simply carried and shown. */
  carry: z.record(z.uuid(), z.enum(carryChoices)).optional(),
  /** An edit decision list in the same project: how this version was cut from the takes. */
  edlFileId: z.uuid().nullish(),
  /** Let it in past the project's version checks: for those who may edit workflows. */
  letThrough: z.boolean().optional(),
  /** Start one of the track's workflows again from a stage (#25): for those who edit them. */
  restartFrom: workflowRestartInput.nullish(),
});

/** A version as the routes read it: its variants under the one name, whichever was sent. */
export type ParsedVersionInput = Omit<z.output<typeof versionFields>, "variations" | "variants"> & {
  variants: z.output<typeof versionVariants>;
};

export const createVersionInput = versionFields
  .transform(({ variations, variants, ...rest }, ctx): ParsedVersionInput => {
    const given = variants ?? variations;
    if (!given) {
      ctx.addIssue({
        code: "custom",
        message: "A version needs at least one file",
        path: ["variants"],
      });
      return z.NEVER;
    }
    return { ...rest, variants: given };
  })
  .refine((v) => v.variants.filter((x) => x.primary).length <= 1, {
    message: "Only one variant can be primary",
    path: ["variants"],
  })
  .refine((v) => new Set(v.variants.map((x) => x.fileId)).size === v.variants.length, {
    message: "A file can be one variant only",
    path: ["variants"],
  });

export type CreateVersionInput = z.input<typeof createVersionInput>;

export const addVariantInput = variantInput;
/** @deprecated The name before decision 275; release 2 of the rename removes it. Use `addVariantInput`. */
export const addVariationInput = addVariantInput;

/** A version's edit decision list (#56): an .edl file of the project, or null to take it off. */
export const versionEdlInput = z.object({ fileId: z.uuid().nullable() });

/** The variants as they will be stored: positions in order, and exactly one primary. */
export function withPrimary<T extends { primary?: boolean }>(
  variants: T[],
): (T & { isPrimary: boolean; position: number })[] {
  const primary = Math.max(
    0,
    variants.findIndex((v) => v.primary),
  );
  return variants.map((v, position) => ({ ...v, isPrimary: position === primary, position }));
}

/** A variant name from a file name: "Maple Leaf Rag - Dry mix v3.wav" reads "Dry mix v3". */
export function variantNameFrom(fileName: string, trackName?: string): string {
  let name = fileName.replace(/\.[a-z0-9]{1,5}$/i, "").trim();
  if (trackName) {
    const escaped = trackName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    name = name.replace(new RegExp(`^${escaped}\\s*[-–_:]\\s*`, "i"), "");
  }
  return name.slice(0, 80) || "Main";
}
/** @deprecated The name before decision 275; release 2 of the rename removes it. Use `variantNameFrom`. */
export const variationNameFrom = variantNameFrom;

/** Replacing a variant's file: the new file takes its place, and its threads follow. */
export const replaceVariantInput = z.object({ fileId: z.uuid() });
/** @deprecated The name before decision 275; release 2 of the rename removes it. Use `replaceVariantInput`. */
export const replaceVariationInput = replaceVariantInput;

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
  /** How long it runs, in seconds; undefined while it is still being probed, null for a file
   * with no length (a document) or one that could not be probed. */
  duration?: number | null;
}

/** The edit decision list given with a new version, as the checks read it. */
export interface GivenEdl {
  name: string;
  /** How many edits could be read from it. */
  edits: number;
  /** Where its last edit ends, in seconds from the start of the version's timeline. */
  end: number;
}

/** How far a list may run past the version's end: an export's tail, a frame's rounding. */
const EDL_END_TOLERANCE = 1;

/** "3:05" for a refusal's message. */
const minutes = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export type VersionRefusal =
  | { check: "true_peak"; file: string; truePeak: number; ceiling: number; message: string }
  | { check: "measuring"; file: string; message: string }
  | { check: "edl"; message: string }
  | { check: "edl_unreadable"; file: string; message: string }
  | { check: "edl_too_long"; file: string; end: number; duration: number; message: string };

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
  /** The edit decision list given with it, as read; null without one. */
  edl: GivenEdl | null,
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
  if (checks.edl && !edl) {
    out.push({
      check: "edl",
      message:
        "This project asks for an edit decision list with every version. Attach the EDL, or ask a producer to let it through.",
    });
  }
  // The list is read as well as asked for (#56): one with no edits, or one running past the
  // end of the version (most often another version's list), is no record of this edit.
  if (checks.edl && edl) {
    // The longest variant counts, so the length is judged only once every one is probed.
    const durations = files.flatMap((f) => (typeof f.duration === "number" ? [f.duration] : []));
    const probed = files.every((f) => f.duration !== undefined);
    const duration = probed && durations.length > 0 ? Math.max(...durations) : null;
    if (edl.edits === 0) {
      out.push({
        check: "edl_unreadable",
        file: edl.name,
        message: `The upload workflow could not read any edits in ${edl.name}. Export it again as a CMX 3600 edit decision list, or ask a producer to let it through.`,
      });
    } else if (duration !== null && edl.end > duration + EDL_END_TOLERANCE) {
      out.push({
        check: "edl_too_long",
        file: edl.name,
        end: edl.end,
        duration,
        message: `The upload workflow refused ${edl.name}: its edits run to ${minutes(edl.end)}, past the end of this version at ${minutes(duration)}, so it may be another version's list. Attach this version's EDL, or ask a producer to let it through.`,
      });
    }
  }
  return out;
}

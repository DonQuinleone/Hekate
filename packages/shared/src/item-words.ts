import { z } from "zod";
import type { MediaInfo } from "./media.ts";
import type { ProjectProfile } from "./profile.ts";
import { variantName } from "./tracks.ts";

/**
 * What a project calls its tracks, versions and variants (#16, decision 138). A video
 * project's deliverables are tracks in the tables: a deliverable has cuts (its versions), and
 * each cut has renditions (its variants). Only the words differ; everything that works for
 * a track works for a deliverable.
 */
export interface ItemWords {
  track: string;
  tracks: string;
  version: string;
  versions: string;
  variant: string;
  variants: string;
  /** @deprecated The names before decision 275, the same words; release 2 of the rename removes them. */
  variation: string;
  variations: string;
}

const musicWords: ItemWords = {
  track: "track",
  tracks: "tracks",
  version: "version",
  versions: "versions",
  variant: "variant",
  variants: "variants",
  variation: "variant",
  variations: "variants",
};

const videoWords: ItemWords = {
  track: "deliverable",
  tracks: "deliverables",
  version: "cut",
  versions: "cuts",
  variant: "rendition",
  variants: "renditions",
  variation: "rendition",
  variations: "renditions",
};

export const itemWords = (profile: ProjectProfile | null | undefined): ItemWords =>
  profile === "video" ? videoWords : musicWords;

/** A word with its first letter in capitals, as it starts a label. */
export const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** A version's short name: "V3" for a track, "Cut 3" for a deliverable. */
export const versionLabel = (number: number, profile: ProjectProfile | null | undefined) =>
  profile === "video" ? `Cut ${number}` : `V${number}`;

/**
 * A rendition's treatment, as its people describe it: subtitled or clean, graded or ungraded.
 * Each is null until someone says, so a rendition never claims what no one checked.
 */
export const renditionTreatment = z
  .object({
    subtitled: z.boolean().nullable(),
    graded: z.boolean().nullable(),
  })
  .partial();
export type RenditionTreatment = z.infer<typeof renditionTreatment>;

/** Changing a variant: its name, and for a rendition its treatment. */
export const updateVariantInput = renditionTreatment
  .extend({ name: variantName })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to change" });
export type UpdateVariantInput = z.infer<typeof updateVariantInput>;
/** @deprecated The names before decision 275; release 2 of the rename removes them. */
export const updateVariationInput = updateVariantInput;
/** @deprecated See `UpdateVariantInput`. */
export type UpdateVariationInput = UpdateVariantInput;

/** The usual picture shapes, by the ratio of width to height they stand for. */
const namedAspects: [ratio: number, name: string][] = [
  [16 / 9, "16:9"],
  [9 / 16, "9:16"],
  [4 / 3, "4:3"],
  [3 / 4, "3:4"],
  [1, "1:1"],
  [4 / 5, "4:5"],
  [2.39, "2.39:1"],
  [2.35, "2.35:1"],
  [1.85, "1.85:1"],
  [2, "2:1"],
  [256 / 135, "DCI 1.90:1"],
];

/**
 * A picture's shape in the words of the trade: "16:9", "9:16", "2.39:1". A size near a known
 * shape (within one percent, as 1920 × 1088 is) takes its name; anything else is its ratio.
 */
export function aspectName(width: number, height: number): string {
  if (width <= 0 || height <= 0) return "";
  const ratio = width / height;
  const known = namedAspects.find(([r]) => Math.abs(ratio / r - 1) < 0.01);
  if (known) return known[1];
  return ratio >= 1 ? `${ratio.toFixed(2)}:1` : `1:${(1 / ratio).toFixed(2)}`;
}

/**
 * How a rendition differs from its siblings, in a few words: its shape, its codec, and what
 * its people said of it. "16:9 · ProRes · subtitled · graded".
 */
export function renditionTraits(
  info: { video?: MediaInfo["video"] | null } | null | undefined,
  treatment: RenditionTreatment,
): string[] {
  const video = info?.video;
  return [
    video ? aspectName(video.width, video.height) : "",
    video ? codecName(video.codec) : "",
    treatment.subtitled === true ? "subtitled" : treatment.subtitled === false ? "clean" : "",
    treatment.graded === true ? "graded" : treatment.graded === false ? "ungraded" : "",
  ].filter(Boolean);
}

/** A video codec as people name it, from the name the probe gives. */
export function codecName(codec: string): string {
  const names: Record<string, string> = {
    h264: "H.264",
    hevc: "HEVC",
    h265: "HEVC",
    prores: "ProRes",
    dnxhd: "DNxHD",
    dnxhr: "DNxHR",
    av1: "AV1",
    vp9: "VP9",
    vp8: "VP8",
    mpeg2video: "MPEG-2",
    mjpeg: "Motion JPEG",
  };
  return names[codec.toLowerCase()] ?? codec;
}

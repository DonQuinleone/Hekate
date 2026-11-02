import type { FileKind } from "./files.ts";
import type { ProjectProfile } from "./profile.ts";
import {
  type WatermarkSettings,
  watermarkPositionWords,
  watermarkScopeWords,
} from "./watermark.ts";

/**
 * A project's Watermarks and downloads page (decision 287, #580): a section for each kind of file it protects,
 * in the order its profile puts first, each open where the project has that kind of file and
 * folded to a heading with its summary where it has none. Nothing is hidden: a folded section
 * opens on a click.
 */
export const assetSections = ["audio", "video", "documents"] as const;
export type AssetSection = (typeof assetSections)[number];

/** The profile's own kind first: music hears, video watches, a general project reads. */
const orders: Record<ProjectProfile, readonly AssetSection[]> = {
  music: ["audio", "documents", "video"],
  video: ["video", "audio", "documents"],
  general: ["documents", "audio", "video"],
};

/** Which kinds of file make each section matter. */
const kindsOf: Record<AssetSection, readonly FileKind[]> = {
  audio: ["audio"],
  video: ["video"],
  documents: ["document", "image"],
};

/** The profile that makes each section matter even before a file arrives. */
const profileOf: Record<AssetSection, ProjectProfile> = {
  audio: "music",
  video: "video",
  documents: "general",
};

export interface AssetSectionLayout {
  section: AssetSection;
  /** Open at first: folded to its heading and summary otherwise. */
  open: boolean;
}

/**
 * The sections in the profile's order, each open when the project holds that kind of file or
 * is of its profile. Audio is always open: the forensic mark is the page's lead, and one row.
 * Without knowing what the project holds, the profile alone decides.
 */
export function assetSecurityLayout(
  profile: ProjectProfile,
  holds?: readonly FileKind[] | null,
): AssetSectionLayout[] {
  return orders[profile].map((section) => ({
    section,
    open:
      section === "audio" ||
      profileOf[section] === profile ||
      (holds ?? []).some((kind) => kindsOf[section].includes(kind)),
  }));
}

/** The page's sections once video, pictures and documents share their one mark (#674). */
export type ProtectionSection = "audio" | "watermark";

/**
 * The page as it is drawn (#674): the visible watermark covers video, pictures and documents
 * alike, so it is one section, where the first of them stands in the profile's order, open when
 * either is.
 */
export function protectionLayout(
  layout: readonly AssetSectionLayout[],
): { section: ProtectionSection; open: boolean }[] {
  const marked = layout.filter((s) => s.section !== "audio");
  return layout.flatMap((s): { section: ProtectionSection; open: boolean }[] => {
    if (s.section === "audio") return [{ section: "audio", open: s.open }];
    if (s !== marked[0]) return [];
    return [{ section: "watermark", open: marked.some((m) => m.open) }];
  });
}

/** The visible watermark in a line, for a folded section: "Guests only · Tiled · 30%". */
export function watermarkSummary(settings: WatermarkSettings): string {
  if (settings.scope === "off") return "No visible watermark";
  return [
    watermarkScopeWords[settings.scope],
    watermarkPositionWords[settings.position],
    `${settings.opacity}%`,
  ].join(" · ");
}

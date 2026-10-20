import { z } from "zod";

/**
 * Downloads (decision 010, docs/security.md): what someone may take away from a file. A
 * project role gives a level through its permissions; a review gives a guest one directly.
 * Every download is made for its recipient, through a link that works once, and is logged.
 */
export const downloadLevels = ["none", "proxy", "original"] as const;
export type DownloadLevel = (typeof downloadLevels)[number];

/** What one download is: the proxy (the stream's own encode) or the original file. */
export const downloadKinds = ["proxy", "original"] as const;
export type DownloadKind = (typeof downloadKinds)[number];

export const downloadInput = z
  .object({
    kind: z.enum(downloadKinds),
    /** For a track's score: the track whose score marks to draw over its pages (#52). */
    marks: z.uuid().optional(),
  })
  .strict();
export type DownloadInput = z.infer<typeof downloadInput>;

/** Every track's score in a project with its marks, as one PDF (#52): the proxy or the original. */
export const scoresDownloadInput = z.object({ kind: z.enum(downloadKinds) }).strict();

const rank: Record<DownloadLevel, number> = { none: 0, proxy: 1, original: 2 };

/** Whether a level lets someone take a kind of download: the original allows the proxy too. */
export const allowsDownload = (level: DownloadLevel, kind: DownloadKind) =>
  rank[level] >= rank[kind];

/** The level a role's permissions give. */
export function downloadLevelOf(permissions: Iterable<string>): DownloadLevel {
  const held = new Set(permissions);
  if (held.has("download_original")) return "original";
  if (held.has("download_proxy")) return "proxy";
  return "none";
}

/** The widest of several levels, for someone reaching a file through several reviews. */
export const widestDownload = (levels: readonly (DownloadLevel | undefined)[]): DownloadLevel =>
  levels.reduce<DownloadLevel>(
    (wide, level) => (level && rank[level] > rank[wide] ? level : wide),
    "none",
  );

/** How long a download link works, once. */
export const DOWNLOAD_LINK_SECONDS = 5 * 60;

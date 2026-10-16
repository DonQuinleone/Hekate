export * from "./comments.ts";
export * from "./env.ts";
export * from "./flows.ts";
export * from "./notifications.ts";
export * from "./people.ts";
export * from "./production.ts";
export * from "./projects.ts";
export * from "./qa.ts";
export * from "./reviews.ts";
export * from "./support.ts";
export * from "./takes.ts";
export * from "./types.ts";
export * from "./workflows.ts";

import { files, folders, projects, tracks } from "./projects.ts";
import { reviews } from "./reviews.ts";
import type { File, Project, Review, Track, Version } from "./types.ts";

/** The prototype's clock: the sample data is written around this moment. */
export const NOW = new Date("2026-10-14T21:00:00Z");

export const projectById = (id: string): Project | undefined => projects.find((p) => p.id === id);
export const fileById = (id: string): File | undefined => files.find((f) => f.id === id);
export const trackById = (id: string): Track | undefined => tracks.find((t) => t.id === id);
export const reviewById = (id: string): Review | undefined => reviews.find((r) => r.id === id);
export const folderById = (id: string) => folders.find((f) => f.id === id);

/** The track and version a file is a variation of, if any. */
export function variationOf(
  fileId: string,
): { track: Track; version: Version; variationName: string } | null {
  for (const track of tracks) {
    for (const version of track.versions) {
      const v = version.variations.find((x) => x.fileId === fileId);
      if (v) return { track, version, variationName: v.name };
    }
  }
  return null;
}

export const latestVersion = (track: Track): Version | undefined =>
  [...track.versions].sort((a, b) => b.number - a.number)[0];

export const primaryFile = (version: Version): File | undefined =>
  fileById((version.variations.find((v) => v.primary) ?? version.variations[0])?.fileId ?? "");

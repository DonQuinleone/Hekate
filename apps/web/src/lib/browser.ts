import type { Folder, ProjectFile, Track, Version } from "./queries";

/** What a folder holds: folders, tracks (a folder of a piece's versions) and loose files. */
export type Item =
  | { kind: "folder"; id: string; folder: Folder }
  | { kind: "track"; id: string; track: Track }
  | { kind: "file"; id: string; file: ProjectFile }
  | { kind: "version"; id: string; track: Track; version: Version };

/** Every file that is a variation of some track's version: it lives in the track. */
export const filesInTracks = (tracks: Track[]) =>
  new Set(tracks.flatMap((t) => t.versions.flatMap((v) => v.variations.map((x) => x.fileId))));

/**
 * What one folder (null, the top) holds, folders first, then tracks, then files that are not
 * a track's: a track is a special kind of folder, so it sits among them.
 */
export function itemsIn(
  folders: Folder[],
  tracks: Track[],
  files: ProjectFile[],
  folderId: string | null,
): Item[] {
  const inTracks = filesInTracks(tracks);
  return [
    ...folders
      .filter((f) => f.parentId === folderId)
      .map((folder): Item => ({ kind: "folder", id: folder.id, folder })),
    ...tracks
      .filter((t) => t.folderId === folderId)
      .map((track): Item => ({ kind: "track", id: track.id, track })),
    ...files
      .filter((f) => f.folderId === folderId && !inTracks.has(f.id))
      .map((file): Item => ({ kind: "file", id: file.id, file })),
  ];
}

/** A track's versions as items, newest first, for the column view. */
export const versionsOf = (track: Track): Item[] =>
  [...track.versions]
    .sort((a, b) => b.number - a.number)
    .map((version): Item => ({ kind: "version", id: version.id, track, version }));

/** The columns a path of choices opens: each folder or track chosen opens the next. */
export function columnsFor(
  root: Item[],
  path: Item[],
  open: (item: Item) => Item[] | null,
): { items: Item[]; selected: Item | null }[] {
  const columns: { items: Item[]; selected: Item | null }[] = [];
  let items = root;
  for (let depth = 0; ; depth++) {
    const selected = path[depth] ?? null;
    columns.push({ items, selected });
    if (!selected) break;
    const next = open(selected);
    if (!next) break;
    items = next;
  }
  return columns;
}

/**
 * A path of choices as the items now stand: each choice looked up by id in the column it
 * was made in, and the path cut short where one has gone.
 */
export function freshPath(root: Item[], path: Item[], open: (item: Item) => Item[] | null): Item[] {
  const fresh: Item[] = [];
  let items: Item[] | null = root;
  for (const chosen of path) {
    const now = items?.find((i) => i.kind === chosen.kind && i.id === chosen.id);
    if (!now) break;
    fresh.push(now);
    items = open(now);
  }
  return fresh;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "V3 of 4 · 2 variations", or a dash for a track with nothing yet. */
export function versionSummary(track: Track): string {
  const latest = track.versions.at(-1);
  if (!latest) return "—";
  const of = track.versions.length > 1 ? ` of ${track.versions.length}` : "";
  const variations =
    latest.variations.length > 1 ? ` · ${plural(latest.variations.length, "variation")}` : "";
  return `V${latest.number}${of}${variations}`;
}

/** How much a folder holds, counting what it shows: folders, tracks and loose files. */
export function folderCount(
  folders: Folder[],
  tracks: Track[],
  files: ProjectFile[],
  folderId: string,
): string {
  const n = itemsIn(folders, tracks, files, folderId).length;
  return n === 0 ? "Empty" : plural(n, "item");
}

/** The primary file of a track's latest version, if it has one. */
export function latestFile(track: Track): string | null {
  const latest = track.versions.at(-1);
  return (
    latest?.variations.find((v) => v.isPrimary)?.fileId ?? latest?.variations[0]?.fileId ?? null
  );
}

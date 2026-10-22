import type { IconName } from "~/components/icons";
import {
  files as allFiles,
  comments,
  type File,
  type Folder,
  findingsFor,
  folders,
  loudness,
  type Track,
  tracks,
  variationOf,
} from "~/data";

export const kindIcon: Record<File["kind"], IconName> = {
  audio: "music",
  video: "film",
  document: "file",
  image: "image",
  other: "file",
};

export function folderPath(folderId: string | null): Folder[] {
  const path: Folder[] = [];
  let id = folderId;
  while (id) {
    const f = folders.find((x) => x.id === id);
    if (!f) break;
    path.unshift(f);
    id = f.parentId;
  }
  return path;
}

/** A file's details line: format, length, pages, size. */
export function fileDetails(file: File): string {
  const m = file.media;
  switch (file.kind) {
    case "audio":
      return [
        m.container,
        m.sampleRate ? `${m.sampleRate / 1000} kHz` : "",
        m.bitDepth ? `${m.bitDepth}-bit` : "",
        m.layout,
      ]
        .filter(Boolean)
        .join(" · ");
    case "video":
      return [`${m.width} × ${m.height}`, m.fps ? `${m.fps} fps` : "", m.codec]
        .filter(Boolean)
        .join(" · ");
    case "document":
      return `PDF · ${m.pages} page${m.pages === 1 ? "" : "s"}`;
    case "image":
      return `${m.width} × ${m.height}`;
    default:
      return file.name.split(".").pop()?.toUpperCase() ?? "";
  }
}

export const openCommentCount = (fileId: string) =>
  comments.filter((c) => c.fileId === fileId && !c.parentId && !c.resolved).length;

/** The loudness chip under a player: the number and how many findings need a look. */
export function qaSummary(
  fileId: string,
): { loudness: number | null; issues: number; advisories: number } | null {
  const l = loudness[fileId] ?? null;
  const f = findingsFor(fileId);
  if (!l && f.length === 0) return null;
  return {
    loudness: l?.integrated ?? null,
    issues: f.filter((x) => x.severity === "fail" || x.severity === "warn").length,
    advisories: f.filter((x) => x.severity === "info").length,
  };
}

/**
 * Files that are nobody's variation: the loose files of a folder. A version chain shows by
 * its latest file (#149); the files a later version replaces are a step away on its page.
 */
export function looseFiles(files: File[]): File[] {
  return files.filter((f) => !variationOf(f.id) && !allFiles.some((x) => x.previousId === f.id));
}

/** A loose file's simple version chain (#149), oldest first; empty for a file in none. */
export function chainOf(file: File): File[] {
  const chain = [file];
  for (let at = allFiles.find((f) => f.id === file.previousId); at; ) {
    chain.unshift(at);
    const previous: string | undefined = at.previousId;
    at = allFiles.find((f) => f.id === previous);
  }
  for (let at = allFiles.find((f) => f.previousId === file.id); at; ) {
    chain.push(at);
    const id: string = at.id;
    at = allFiles.find((f) => f.previousId === id);
  }
  return chain.length > 1 ? chain : [];
}

export const tracksIn = (projectId: string, folderId: string | null): Track[] =>
  tracks.filter((t) => t.projectId === projectId && t.folderId === folderId);

/** "V2 · " for the latest of a chain, before its details in a list (#149). */
export function chainLabel(file: File): string {
  const chain = chainOf(file);
  return chain.length ? `V${chain.findIndex((f) => f.id === file.id) + 1} · ` : "";
}

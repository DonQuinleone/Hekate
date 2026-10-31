import type { FileKind } from "@hekate/shared";
import type { Folder, ProjectFile, Track } from "./queries";

/** A file of the project as the picker lists it (#527): where it sits, said and to filter by. */
export interface PickableFile {
  file: ProjectFile;
  /** Its track, version and variant ("Maple Leaf Rag · V2 · Dry"), or its folder's path. */
  where: string;
  /** The folder it is in, a track's file its track's: what the folder filter goes by. */
  folderId: string | null;
}

/** What each kind is called in the picker's filter. */
export const kindNames: Record<FileKind, string> = {
  audio: "Audio",
  video: "Video",
  document: "Documents",
  image: "Pictures",
  other: "Other",
};

/** A folder's path from the top of the project, by name: "Sessions / Day 2". */
export function folderPathOf(folders: Folder[], folderId: string | null): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let id = folderId;
  while (id && !seen.has(id)) {
    seen.add(id);
    const folder = folders.find((f) => f.id === id);
    if (!folder) break;
    path.unshift(folder.name);
    id = folder.parentId;
  }
  return path;
}

/**
 * The project's files to link to a comment, sorted by where they sit and then by name: loose
 * files with their folder's path, a track's with its track, version and variant. The file being
 * commented on is left out, as it is the comment's already; a take's file never comes here (the
 * server lists none), as takes are shared from their track.
 */
export function pickableFiles(
  folders: Folder[],
  tracks: Track[],
  files: ProjectFile[],
  exclude: string | null,
  versionName: (n: number) => string = (n) => `V${n}`,
): PickableFile[] {
  const inTracks = new Map<string, { track: Track; number: number; variant: string }>();
  for (const track of tracks)
    for (const version of track.versions)
      for (const variant of version.variants)
        inTracks.set(variant.fileId, { track, number: version.number, variant: variant.name });
  return files
    .filter((f) => f.id !== exclude)
    .map((file) => {
      const of = inTracks.get(file.id);
      if (of)
        return {
          file,
          where: [of.track.name, versionName(of.number), of.variant].join(" · "),
          folderId: of.track.folderId,
        };
      const path = folderPathOf(folders, file.folderId);
      return {
        file,
        where: path.length > 0 ? path.join(" / ") : "Top of the project",
        folderId: file.folderId,
      };
    })
    .sort((a, b) => a.where.localeCompare(b.where) || a.file.name.localeCompare(b.file.name));
}

/** The project's folders to filter by, each under its parent, named by its path. */
export function folderChoices(folders: Folder[]): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  const visit = (parentId: string | null, trail: string[]) => {
    for (const folder of folders
      .filter((f) => f.parentId === parentId)
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const path = [...trail, folder.name];
      out.push({ id: folder.id, label: path.join(" / ") });
      visit(folder.id, path);
    }
  };
  visit(null, []);
  return out;
}

/** The kinds among these files, in the filter's order. */
export const kindsAmong = (rows: PickableFile[]): FileKind[] =>
  (Object.keys(kindNames) as FileKind[]).filter((k) => rows.some((r) => r.file.kind === k));

/**
 * The files a search, a folder (everything beneath it too) and a kind leave. The search reads
 * the name and where it sits, ignoring case.
 */
export function filesMatching(
  rows: PickableFile[],
  folders: Folder[],
  filter: { query: string; folderId: string | null; kind: FileKind | null },
): PickableFile[] {
  const needle = filter.query.trim().toLowerCase();
  const beneath = (folderId: string | null) => {
    if (!filter.folderId) return true;
    const seen = new Set<string>();
    let id = folderId;
    while (id && !seen.has(id)) {
      if (id === filter.folderId) return true;
      seen.add(id);
      id = folders.find((f) => f.id === id)?.parentId ?? null;
    }
    return false;
  };
  return rows.filter(
    (r) =>
      (!filter.kind || r.file.kind === filter.kind) &&
      beneath(r.folderId) &&
      (!needle ||
        r.file.name.toLowerCase().includes(needle) ||
        r.where.toLowerCase().includes(needle)),
  );
}

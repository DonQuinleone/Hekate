import {
  type BrowserFilter,
  browserFilters,
  columnWidths,
  type FileColumn,
  type FileColumnLayout,
  fileColumns,
  itemWords,
  type Mark,
  maxColumnWidth,
  minColumnWidth,
  type ProjectProfile,
  replacedFiles,
  versionLabel,
} from "@hekate/shared";
import type { Folder, ProjectFile, Tag, Track, Version } from "./queries";

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
 * The files a list leaves out: a track's, shown by their track, and those a later version
 * replaces, shown by the latest of their chain (#149).
 */
const notListed = (tracks: Track[], files: ProjectFile[]) =>
  new Set([
    ...filesInTracks(tracks),
    ...replacedFiles(files.map((f) => ({ id: f.id, previousFileId: f.previousFileId ?? null }))),
  ]);

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
  const inTracks = notListed(tracks, files);
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

/**
 * "V3 of 4 · 2 variations", or a dash for a track with nothing yet; a deliverable's in its own
 * words (#16): "Cut 3 of 4 · 2 renditions".
 */
export function versionSummary(track: Track, profile?: ProjectProfile): string {
  const latest = track.versions.at(-1);
  if (!latest) return "—";
  const words = itemWords(profile);
  const of = track.versions.length > 1 ? ` of ${track.versions.length}` : "";
  const variations =
    latest.variations.length > 1 ? ` · ${plural(latest.variations.length, words.variation)}` : "";
  return `${versionLabel(latest.number, profile)}${of}${variations}`;
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

/** What a track's row offers as the one thing it most wants next. */
export type TrackNext = "add" | "replace" | "deliver" | "review";

/**
 * The one thing a track most wants next, as the prototype's file list offers it, for someone
 * who may do it: its first version; a file to replace where its latest could not be read;
 * delivering it once approved; or a review, unless one is under way. Null for none.
 */
export function trackNext(
  track: Track,
  may: { upload: boolean; organise: boolean; download: boolean; requestReviews: boolean },
): TrackNext | null {
  const latest = track.versions.at(-1);
  const file = latestFile(track);
  if (!latest && may.upload) return "add";
  if (latest?.variations.some((v) => v.streamStatus === "failed") && may.organise) return "replace";
  if (file && track.state === "approved" && may.download) return "deliver";
  if (file && may.requestReviews && track.state !== "in_review") return "review";
  return null;
}

/** Someone's marks, by `kind:id`, for quick lookups. */
export interface MarkIndex {
  favourite: Set<string>;
  viewed: Set<string>;
}

export const markKey = (item: { kind: string; id: string }) => `${item.kind}:${item.id}`;

export function indexMarks(marks: Mark[]): MarkIndex {
  const index: MarkIndex = { favourite: new Set(), viewed: new Set() };
  for (const m of marks) {
    const key = markKey(m);
    // One mark (decision 269): a pin kept from before reads as a favourite until it is written
    // again, which writes both.
    if (m.favourite || m.pinned) index.favourite.add(key);
    if (m.viewed) index.viewed.add(key);
  }
  return index;
}

/** Whether someone has yet to open a file. What they uploaded themselves they have seen. */
export const unviewed = (file: ProjectFile, me: string | undefined, marks: MarkIndex) =>
  file.uploadedById !== me && !marks.viewed.has(markKey({ kind: "file", id: file.id }));

/** Favourites first, otherwise in the order given. */
export const favouritesFirst = (items: Item[], marks: MarkIndex): Item[] => [
  ...items.filter((i) => marks.favourite.has(markKey(i))),
  ...items.filter((i) => !marks.favourite.has(markKey(i))),
];

/** What narrows the file browser: ways of looking, and tags (any of them). */
export interface BrowserFilters {
  show: BrowserFilter[];
  tags: string[];
}

export const noFilters: BrowserFilters = { show: [], tags: [] };
export const filtering = (f: BrowserFilters) => f.show.length > 0 || f.tags.length > 0;

const list = (value: unknown) =>
  typeof value === "string" ? value.split(",").filter(Boolean) : [];
const uuid = /^[0-9a-f-]{36}$/i;

/** The filters in the address, as `show=unviewed,comments&tags=<id>,<id>`; anything else is dropped. */
export function filtersFrom(search: Record<string, unknown>): BrowserFilters {
  return {
    show: browserFilters.filter((f) => list(search.show).includes(f)),
    tags: [...new Set(list(search.tags).filter((t) => uuid.test(t)))].slice(0, 20),
  };
}

/** The filters as the address carries them, leaving out what is not set. */
export const filtersTo = (f: BrowserFilters): { show?: string; tags?: string } => ({
  ...(f.show.length ? { show: f.show.join(",") } : {}),
  ...(f.tags.length ? { tags: f.tags.join(",") } : {}),
});

/**
 * Everything in a project that passes the filters, wherever it is: tracks and loose files,
 * and folders too when looking for favourites. Every condition must hold; any one of the
 * tags will do. A track is judged by the files in its versions: it has comments or is unseen
 * by its latest version, and is someone's if they uploaded any of it.
 */
export function filterProject(
  folders: Folder[],
  tracks: Track[],
  files: ProjectFile[],
  filters: BrowserFilters,
  me: string | undefined,
  marks: MarkIndex,
): Item[] {
  const byId = new Map(files.map((f) => [f.id, f]));
  const inTracks = notListed(tracks, files);
  const filesOf = (t: Track, latestOnly: boolean) =>
    (latestOnly ? t.versions.slice(-1) : t.versions)
      .flatMap((v) => v.variations.map((x) => byId.get(x.fileId)))
      .filter((f): f is ProjectFile => f !== undefined);
  const tagged = (f: ProjectFile) => f.tagIds?.some((t) => filters.tags.includes(t)) ?? false;
  const passes = (item: Item): boolean => {
    if (item.kind === "version") return false;
    const latest =
      item.kind === "file" ? [item.file] : item.kind === "track" ? filesOf(item.track, true) : [];
    const every = item.kind === "track" ? filesOf(item.track, false) : latest;
    return (
      filters.show.every((f) => {
        if (f === "favourites") return marks.favourite.has(markKey(item));
        if (item.kind === "folder") return false;
        if (f === "comments") return latest.some((x) => (x.openComments ?? 0) > 0);
        if (f === "unviewed") {
          const primary =
            item.kind === "track" ? byId.get(latestFile(item.track) ?? "") : item.file;
          return primary !== undefined && unviewed(primary, me, marks);
        }
        return every.some((x) => x.uploadedById === me);
      }) &&
      (filters.tags.length === 0 || every.some(tagged))
    );
  };
  const name = (i: Item) =>
    i.kind === "folder"
      ? i.folder.name
      : i.kind === "track"
        ? i.track.name
        : i.kind === "file"
          ? i.file.name
          : "";
  const candidates: Item[] = [
    ...folders.map((folder): Item => ({ kind: "folder", id: folder.id, folder })),
    ...tracks.map((track): Item => ({ kind: "track", id: track.id, track })),
    ...files
      .filter((f) => !inTracks.has(f.id))
      .map((file): Item => ({ kind: "file", id: file.id, file })),
  ];
  return favouritesFirst(
    candidates.filter(passes).sort((a, b) => name(a).localeCompare(name(b), "en-GB")),
    marks,
  );
}

/** The row's cell for its quick actions (three at most, 28px each, 2px apart) and the one for its menu. */
export const quickCellWidth = 88;
export const menuCellWidth = 28;

/** The list's grid: the icon, the name taking what is left, each chosen column, the actions. */
export const gridTemplate = (columns: FileColumnLayout) =>
  [
    "20px",
    "minmax(0,1fr)",
    ...columns.map((c) => `${c.width}px`),
    `${quickCellWidth}px`,
    `${menuCellWidth}px`,
  ].join(" ");

/**
 * The narrowest the list may be before it scrolls sideways: the icon, a readable name, each
 * column, the quick actions, the menu, the gaps between them and the padding either side.
 */
export const listMinWidth = (columns: FileColumnLayout) =>
  20 +
  240 +
  columns.reduce((w, c) => w + c.width, 0) +
  quickCellWidth +
  menuCellWidth +
  12 * (columns.length + 3) +
  24;

/**
 * The columns that fit a list of the given width, in the member's order: those at the end are
 * left off until the rest fit beside a readable name. The Columns menu still shows them all.
 */
export function fitColumns(columns: FileColumnLayout, width: number): FileColumnLayout {
  const fitted = [...columns];
  while (fitted.length > 0 && listMinWidth(fitted) > width) fitted.pop();
  return fitted;
}

/** Show a column, at its usual width and in its usual place among those shown, or hide it. */
export function toggleColumn(columns: FileColumnLayout, id: FileColumn): FileColumnLayout {
  if (columns.some((c) => c.id === id)) return columns.filter((c) => c.id !== id);
  const rank = (c: FileColumn) => fileColumns.indexOf(c);
  const at = columns.findIndex((c) => rank(c.id) > rank(id));
  const added = { id, width: columnWidths[id] };
  return at < 0 ? [...columns, added] : [...columns.slice(0, at), added, ...columns.slice(at)];
}

/** Move a shown column one place earlier (-1) or later (1). */
export function moveColumn(
  columns: FileColumnLayout,
  id: FileColumn,
  by: -1 | 1,
): FileColumnLayout {
  const from = columns.findIndex((c) => c.id === id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= columns.length) return columns;
  const next = [...columns];
  [next[from], next[to]] = [
    next[to] as FileColumnLayout[number],
    next[from] as FileColumnLayout[number],
  ];
  return next;
}

/** A column at a new width, kept within what fits a header and stays readable. */
export const resizeColumn = (
  columns: FileColumnLayout,
  id: FileColumn,
  width: number,
): FileColumnLayout =>
  columns.map((c) =>
    c.id === id
      ? { ...c, width: Math.round(Math.min(maxColumnWidth, Math.max(minColumnWidth, width))) }
      : c,
  );

/**
 * The keys from one to another, either way round, in the order shown: what a shift-click or
 * shift-arrow selects. Without a starting point, just the one.
 */
export function rangeBetween(order: string[], from: string | null, to: string): string[] {
  const a = from === null ? -1 : order.indexOf(from);
  const b = order.indexOf(to);
  if (b < 0) return [];
  if (a < 0) return [to];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** What a set of things says to do to all of them: pin unless every one is pinned already. */
export const allHave = (keys: Iterable<string>, have: Set<string>) => {
  let any = false;
  for (const k of keys) {
    any = true;
    if (!have.has(k)) return false;
  }
  return any;
};

/** The folders something may move to: not into itself, nor into anything inside it. */
export function movableTo(folders: Folder[], moving: Item[]): Folder[] {
  const out = new Set<string>();
  for (const item of moving) {
    if (item.kind !== "folder") continue;
    const stack = [item.folder.id];
    while (stack.length) {
      const id = stack.pop() as string;
      if (out.has(id)) continue;
      out.add(id);
      for (const f of folders) if (f.parentId === id) stack.push(f.id);
    }
  }
  return folders.filter((f) => !out.has(f.id));
}

/** Where something sits: its folder, or null at the top of the project. */
export const parentIdOf = (item: Item): string | null =>
  item.kind === "folder"
    ? item.folder.parentId
    : item.kind === "track"
      ? item.track.folderId
      : item.kind === "file"
        ? item.file.folderId
        : null;

/**
 * What a drop, a paste or a Move does: everything moving that is not there already and may go
 * there (a folder never into itself or anything inside it; a version is not moved on its own).
 */
export function movesInto(folders: Folder[], moving: Item[], to: string | null): Item[] {
  const allowed = new Set(movableTo(folders, moving).map((f) => f.id));
  return moving.filter(
    (i) => i.kind !== "version" && parentIdOf(i) !== to && (to === null || allowed.has(to)),
  );
}

/**
 * The files a track takes when rows are dropped on it: it is a folder of a piece's versions,
 * so loose files go in as its next version. A folder or another track makes it no target.
 */
export function droppableOnTrack(moving: Item[]): ProjectFile[] | null {
  const files = moving.flatMap((i) => (i.kind === "file" ? [i.file] : []));
  return files.length > 0 && files.length === moving.length ? files : null;
}

/** How much of a name to select for renaming: a file's, without its extension, as the Finder does. */
export function nameStem(name: string, file: boolean): number {
  if (!file) return name.length;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? dot : name.length;
}

/**
 * The tags offered as one is typed: the workspace's that are not on the thing already and
 * whose names contain what was typed, most used first; and what was typed as a new tag,
 * unless a tag has that name.
 */
export function tagSuggestions(
  tags: Tag[],
  chosen: string[],
  typed: string,
): { matches: Tag[]; create: string | null } {
  const wanted = typed.trim();
  const q = wanted.toLowerCase();
  const matches = tags
    .filter((t) => !chosen.includes(t.id) && (!q || t.name.toLowerCase().includes(q)))
    .sort((a, b) => b.files - a.files || a.name.localeCompare(b.name, "en-GB"));
  const create = q && !tags.some((t) => t.name.toLowerCase() === q) ? wanted : null;
  return { matches, create };
}

/** A project's folders as a tree reads, top to bottom, each with its depth, for a picker. */
export function folderTree(folders: Folder[]): { folder: Folder; depth: number }[] {
  const out: { folder: Folder; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null, depth: number) => {
    const children = folders
      .filter((f) => f.parentId === parentId && !seen.has(f.id))
      .sort((a, b) => a.name.localeCompare(b.name, "en-GB"));
    for (const f of children) {
      seen.add(f.id);
      out.push({ folder: f, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** Tags to put on a file when many are tagged at once: those chosen, less those taken off all. */
export const bulkTags = (current: string[], common: string[], chosen: string[]) => [
  ...new Set([...current.filter((t) => !common.includes(t) || chosen.includes(t)), ...chosen]),
];

/**
 * Where a file is in its preparation, in words, or null once it is ready (or needs none):
 * a recording is measured, made playable and analysed; a document's pages are drawn.
 */
export function processingStage(file: ProjectFile): string | null {
  if (file.streamStatus === "failed" || file.analysisStatus === "failed") return "Failed";
  const media = file.kind === "audio" || file.kind === "video";
  if (media && file.mediaInfo === null && file.streamStatus === "pending") return "Measuring";
  if (file.streamStatus === "pending") return media ? "Preparing playback" : "Drawing pages";
  if (file.analysisStatus === "pending") return "Analysing";
  return null;
}

/** A variation's name from its file's: the extension and the track's own name dropped. */
export function variationNameFor(fileName: string, trackName: string): string {
  const bare = fileName.replace(/\.[^.]+$/, "");
  const rest = bare.toLowerCase().startsWith(trackName.toLowerCase())
    ? bare.slice(trackName.length).replace(/^[\s\-–_:·]+/, "")
    : bare;
  return (rest || bare).slice(0, 80);
}

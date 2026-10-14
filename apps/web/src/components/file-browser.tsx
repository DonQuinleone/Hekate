import { descendantsOf, folderPath, formatBytes } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { cn } from "~/lib/cn";
import {
  type Folder,
  type ProjectFile,
  projectFilesQuery,
  projectFoldersQuery,
  projectTracksQuery,
  type Track,
  useOrganise,
  useProjectCan,
  useTrackMutations,
} from "~/lib/queries";
import { kindIcon, mediaSummary, UploadButton, UploadList } from "./files";
import { Icon, type IconName } from "./icons";
import { Button } from "./ui/button";
import { ActionMenu } from "./ui/menu";

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const control =
  "h-8 min-w-0 rounded-control border border-edge bg-ground px-3 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-ink-3";
const action =
  "cursor-pointer border-0 bg-transparent p-0 text-xs text-ink-3 hover:text-ink disabled:cursor-default disabled:opacity-50";

type View = "list" | "grid";
const VIEW_KEY = "hekate.files.view";

/** The remembered view, per browser; storage can be missing or refuse, so list is the fallback. */
function storedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

/** What a folder holds: folders, tracks (a folder of a piece's versions) and loose files. */
type Item =
  | { kind: "folder"; folder: Folder }
  | { kind: "track"; track: Track }
  | { kind: "file"; file: ProjectFile };
const itemId = (item: Item) =>
  item.kind === "folder" ? item.folder.id : item.kind === "track" ? item.track.id : item.file.id;
const itemName = (item: Item) =>
  item.kind === "folder"
    ? item.folder.name
    : item.kind === "track"
      ? item.track.name
      : item.file.name;
const itemIcon = (item: Item): IconName =>
  item.kind === "folder" ? "folder" : item.kind === "track" ? "track" : kindIcon[item.file.kind];

/** What is being done to one item: renaming it, choosing where it goes, or confirming its removal. */
type Editing = { id: string; mode: "rename" | "move" | "delete" } | null;

/** Every folder as a path ("Mixes / Stems"), for choosing where something goes. */
function destinations(folders: Folder[], exclude: Set<string>) {
  return folders
    .filter((f) => !exclude.has(f.id))
    .map((f) => ({
      id: f.id,
      label: folderPath(folders, f.id)
        .map((p) => p.name)
        .join(" / "),
    }))
    .sort((a, b) => a.label.localeCompare(b.label, "en-GB"));
}

function RenameForm({
  initial,
  pending,
  onSave,
  onCancel,
}: {
  initial: string;
  pending: boolean;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() && name.trim() !== initial) onSave(name.trim());
    else onCancel();
  };
  return (
    <form onSubmit={submit} className="flex min-w-0 flex-1 items-center gap-2">
      <input
        // biome-ignore lint/a11y/noAutofocus: the field appears because the person asked to rename
        autoFocus
        aria-label="New name"
        className={cn(control, "flex-1")}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
      />
      <Button size="sm" type="submit" disabled={pending}>
        Save
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}

function MoveForm({
  options,
  current,
  pending,
  onMove,
  onCancel,
}: {
  options: { id: string; label: string }[];
  current: string | null;
  pending: boolean;
  onMove: (folderId: string | null) => void;
  onCancel: () => void;
}) {
  const [to, setTo] = useState(current ?? "");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onMove(to || null);
      }}
      className="flex flex-wrap items-center gap-2"
    >
      <select
        aria-label="Move to"
        className={cn(control, "max-w-72")}
        value={to}
        onChange={(e) => setTo(e.target.value)}
      >
        <option value="">Top of the project</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <Button size="sm" type="submit" disabled={pending || to === (current ?? "")}>
        Move
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}

/** "3 versions · V3": what a track holds, in a glance. */
function trackSummary(track: Track) {
  const latest = track.versions.at(-1);
  if (!latest) return "No versions yet";
  const count = track.versions.length;
  return `${count} ${count === 1 ? "version" : "versions"} · V${latest.number} ${latest.variations.map((v) => v.name).join(", ")}`;
}

/**
 * A project's folders, tracks and files, one folder at a time, as a list or a grid. A track
 * is a special kind of folder: it sits among them, and the files in its versions live in it
 * rather than loose beside it. Those who can organise make folders and tracks, and rename,
 * move and delete what is here; files dropped anywhere on the page land in the open folder.
 */
export function FileBrowser({
  projectId,
  folderId,
  onOpenFolder,
  tracks: withTracks,
}: {
  projectId: string;
  folderId: string | null;
  onOpenFolder: (folderId: string | null) => void;
  /** Music projects hold tracks. */
  tracks: boolean;
}) {
  const { data: files, error } = useQuery(projectFilesQuery(projectId));
  const { data: folders, error: foldersError } = useQuery(projectFoldersQuery(projectId));
  const { data: trackList, error: tracksError } = useQuery({
    ...projectTracksQuery(projectId),
    enabled: withTracks,
  });
  const can = useProjectCan(projectId);
  const organise = useOrganise(projectId);
  const trackMutations = useTrackMutations(projectId);
  const [view, setView] = useState<View>(storedView);
  const [naming, setNaming] = useState<"folder" | "track" | null>(null);
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<Editing>(null);
  const manage = can("organise");

  // A folder that has gone (deleted elsewhere) leaves the viewer at the top.
  const known = !folderId || !folders || folders.some((f) => f.id === folderId);
  useEffect(() => {
    if (!known) onOpenFolder(null);
  }, [known, onOpenFolder]);

  const chooseView = (next: View) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Not remembered; the choice still holds for this visit.
    }
  };

  const all = folders ?? [];
  const allTracks = trackList ?? [];
  const path = folderPath(all, folderId);
  // Files that are a track's variations live in the track, not loose in its folder.
  const inTracks = new Set(
    allTracks.flatMap((t) => t.versions.flatMap((v) => v.variations.map((x) => x.fileId))),
  );
  const items: Item[] = [
    ...all
      .filter((f) => f.parentId === folderId)
      .map((folder) => ({ kind: "folder" as const, folder })),
    ...allTracks
      .filter((t) => t.folderId === folderId)
      .map((track) => ({ kind: "track" as const, track })),
    ...(files ?? [])
      .filter((f) => f.folderId === folderId && !inTracks.has(f.id))
      .map((file) => ({ kind: "file" as const, file })),
  ];
  const parentName = path.at(-2)?.name ?? "the top of the project";
  const failure =
    organise.createFolder.error ??
    organise.updateFolder.error ??
    organise.deleteFolder.error ??
    organise.updateFile.error ??
    organise.deleteFile.error ??
    trackMutations.createTrack.error ??
    trackMutations.updateTrack.error;

  const create = (event: FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    const done = {
      onSuccess: () => {
        setNewName("");
        setNaming(null);
      },
    };
    if (naming === "track") trackMutations.createTrack.mutate({ name, folderId }, done);
    else organise.createFolder.mutate({ name, parentId: folderId }, done);
  };
  const done = { onSuccess: () => setEditing(null) };
  const rename = (item: Item, name: string) =>
    item.kind === "folder"
      ? organise.updateFolder.mutate({ id: item.folder.id, name }, done)
      : item.kind === "track"
        ? trackMutations.updateTrack.mutate({ id: item.track.id, name }, done)
        : organise.updateFile.mutate({ id: item.file.id, name }, done);
  const move = (item: Item, to: string | null) =>
    item.kind === "folder"
      ? organise.updateFolder.mutate({ id: item.folder.id, parentId: to }, done)
      : item.kind === "track"
        ? trackMutations.updateTrack.mutate({ id: item.track.id, folderId: to }, done)
        : organise.updateFile.mutate({ id: item.file.id, folderId: to }, done);
  const remove = (item: Item) => {
    if (item.kind === "folder") organise.deleteFolder.mutate(item.folder.id, done);
    else if (item.kind === "file") organise.deleteFile.mutate(item.file.id, done);
  };
  const pending =
    organise.updateFolder.isPending ||
    organise.updateFile.isPending ||
    organise.deleteFolder.isPending ||
    organise.deleteFile.isPending ||
    trackMutations.updateTrack.isPending;

  /** The name, opening a folder or a track, or a file. */
  const title = (item: Item) =>
    item.kind === "folder" ? (
      <button
        type="button"
        onClick={() => onOpenFolder(item.folder.id)}
        className="cursor-pointer truncate border-0 bg-transparent p-0 text-left text-sm text-ink hover:text-signal"
      >
        {item.folder.name}
      </button>
    ) : item.kind === "track" ? (
      <Link
        to="/tracks/$trackId"
        params={{ trackId: item.track.id }}
        className="truncate text-sm text-ink no-underline hover:text-signal"
      >
        {item.track.name}
      </Link>
    ) : (
      <Link
        to="/files/$fileId"
        params={{ fileId: item.file.id }}
        className="truncate text-sm text-ink no-underline hover:text-signal"
      >
        {item.file.name}
      </Link>
    );

  const details = (item: Item) => {
    if (item.kind === "track") return trackSummary(item.track);
    if (item.kind === "folder") {
      const inside =
        all.filter((f) => f.parentId === item.folder.id).length +
        allTracks.filter((t) => t.folderId === item.folder.id).length +
        (files ?? []).filter((f) => f.folderId === item.folder.id && !inTracks.has(f.id)).length;
      return inside === 0 ? "Empty" : inside === 1 ? "1 item" : `${inside} items`;
    }
    return (
      mediaSummary(item.file.kind, item.file.mediaInfo, item.file.streamStatus) ??
      item.file.contentType
    );
  };

  const menu = (item: Item) =>
    manage && (
      <ActionMenu
        label={itemName(item)}
        actions={[
          { label: "Rename", onSelect: () => setEditing({ id: itemId(item), mode: "rename" }) },
          { label: "Move to…", onSelect: () => setEditing({ id: itemId(item), mode: "move" }) },
          ...(item.kind === "track"
            ? []
            : [
                {
                  label: "Delete…",
                  danger: true,
                  onSelect: () => setEditing({ id: itemId(item), mode: "delete" as const }),
                },
              ]),
        ]}
      />
    );

  /** The open editor for an item, in place of its menu. */
  const editor = (item: Item) => {
    if (!editing || editing.id !== itemId(item)) return null;
    if (editing.mode === "rename") {
      return (
        <RenameForm
          initial={itemName(item)}
          pending={pending}
          onSave={(name) => rename(item, name)}
          onCancel={() => setEditing(null)}
        />
      );
    }
    if (editing.mode === "move") {
      const exclude =
        item.kind === "folder" ? descendantsOf(all, item.folder.id) : new Set<string>();
      return (
        <MoveForm
          options={destinations(all, exclude)}
          current={folderId}
          pending={pending}
          onMove={(to) => move(item, to)}
          onCancel={() => setEditing(null)}
        />
      );
    }
    return (
      <span className="flex flex-wrap items-center gap-2" role="alert">
        <span className="text-[13px] text-ink-2">
          {item.kind === "folder"
            ? `Delete ${item.folder.name}? What is in it moves to ${parentName}.`
            : `Delete ${itemName(item)}? This cannot be undone.`}
        </span>
        <Button size="sm" variant="primary" disabled={pending} onClick={() => remove(item)}>
          Delete
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
          Keep
        </Button>
      </span>
    );
  };

  const loadError = error ?? foldersError ?? tracksError;
  if (loadError) return <p className="m-0 text-signal">{loadError.message}</p>;

  return (
    <section aria-label="Files" className="flex flex-col gap-3">
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-3">
        <nav
          aria-label="Folder path"
          className="flex min-w-0 flex-wrap items-center gap-2 text-[13px]"
        >
          {path.length === 0 ? (
            <span className="text-ink-2">All files</span>
          ) : (
            <button
              type="button"
              className={cn(action, "text-[13px]")}
              onClick={() => onOpenFolder(null)}
            >
              All files
            </button>
          )}
          {path.map((f, i) => (
            <span key={f.id} className="flex min-w-0 items-center gap-2">
              <span className="text-edge">/</span>
              {i === path.length - 1 ? (
                <span className="truncate text-ink">{f.name}</span>
              ) : (
                <button
                  type="button"
                  className={cn(action, "truncate text-[13px]")}
                  onClick={() => onOpenFolder(f.id)}
                >
                  {f.name}
                </button>
              )}
            </span>
          ))}
        </nav>
        <div className="flex flex-wrap items-center gap-2">
          <fieldset className="m-0 flex gap-0.5 border-0 p-0" aria-label="View">
            {(["list", "grid"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => chooseView(v)}
                className={cn(
                  "h-7 cursor-pointer rounded-chip border px-2.5 text-xs",
                  view === v
                    ? "border-edge bg-raised text-ink"
                    : "border-transparent bg-transparent text-ink-3 hover:text-ink",
                )}
              >
                {v === "list" ? "List" : "Grid"}
              </button>
            ))}
          </fieldset>
          {manage && (
            <Button
              size="sm"
              variant="ghost"
              aria-label="New folder"
              onClick={() => setNaming("folder")}
            >
              <Icon name="folder" size={14} />
              <span className="hidden sm:inline">New folder</span>
            </Button>
          )}
          {manage && withTracks && (
            <Button
              size="sm"
              variant="ghost"
              aria-label="New track"
              onClick={() => setNaming("track")}
            >
              <Icon name="track" size={14} />
              <span className="hidden sm:inline">New track</span>
            </Button>
          )}
          <UploadButton />
        </div>
      </div>

      {naming && (
        <form
          onSubmit={create}
          className="flex flex-wrap items-center gap-2"
          aria-label={naming === "track" ? "New track" : "New folder"}
        >
          <input
            // biome-ignore lint/a11y/noAutofocus: the field appears because the person asked for it
            autoFocus
            aria-label={naming === "track" ? "Track name" : "Folder name"}
            placeholder={naming === "track" ? "Maple Leaf Rag" : "Mixes"}
            className={cn(control, "w-64")}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setNaming(null)}
          />
          <Button
            size="sm"
            type="submit"
            disabled={
              !newName.trim() ||
              organise.createFolder.isPending ||
              trackMutations.createTrack.isPending
            }
          >
            Create
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setNaming(null)}>
            Cancel
          </Button>
        </form>
      )}
      {failure && <p className="m-0 text-xs text-signal">{failure.message}</p>}

      <UploadList />

      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-panel border border-dashed border-hairline px-6 py-12 text-center">
          <Icon name="upload" size={20} className="text-ink-3" />
          <p className="m-0 text-[13px] text-ink-2">
            {folderId ? "This folder is empty." : "Nothing here yet."}
          </p>
          {can("upload") && (
            <p className="m-0 text-xs text-ink-3">Drop files anywhere on this page to add them.</p>
          )}
        </div>
      ) : view === "list" ? (
        <ul className="m-0 flex list-none flex-col p-0" aria-label="Contents">
          <li className="label hidden grid-cols-[auto_minmax(0,1fr)_minmax(0,280px)_72px_104px_28px] gap-3 border-b border-hairline px-2 pb-2 sm:grid">
            <span className="w-4" />
            <span>Name</span>
            <span>Details</span>
            <span className="text-right">Size</span>
            <span className="text-right">Added</span>
            <span />
          </li>
          {items.map((item) => {
            const open = editing?.id === itemId(item);
            return (
              <li
                key={itemId(item)}
                className="group flex flex-col gap-2 border-b border-hairline px-2 py-1.5 hover:bg-surface"
              >
                <div className="grid min-h-9 grid-cols-[auto_minmax(0,1fr)_28px] items-center gap-x-3 gap-y-0.5 sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,280px)_72px_104px_28px]">
                  <Icon name={itemIcon(item)} className="text-ink-2" />
                  <span className="flex min-w-0 flex-col sm:flex-row sm:items-center sm:gap-3">
                    {open && editing?.mode === "rename" ? editor(item) : title(item)}
                    <span className="tabular truncate text-xs text-ink-3 sm:hidden">
                      {details(item)}
                    </span>
                  </span>
                  <span className="tabular hidden truncate text-xs text-ink-2 sm:block">
                    {details(item)}
                  </span>
                  <span className="tabular hidden text-right text-xs text-ink-3 sm:block">
                    {item.kind === "file" ? formatBytes(item.file.byteSize) : ""}
                  </span>
                  <span className="tabular hidden text-right text-xs text-ink-3 sm:block">
                    {item.kind === "file" ? dateFormat.format(new Date(item.file.createdAt)) : ""}
                  </span>
                  <span className="flex justify-end">{!open && menu(item)}</span>
                </div>
                {open && editing?.mode !== "rename" && <div className="pl-7">{editor(item)}</div>}
              </li>
            );
          })}
        </ul>
      ) : (
        <ul
          className="m-0 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3 lg:grid-cols-4"
          aria-label="Contents"
        >
          {items.map((item) => {
            const open = editing?.id === itemId(item);
            return (
              <li
                key={itemId(item)}
                className={cn(
                  "group flex min-w-0 flex-col gap-3 rounded-panel border border-hairline p-3 hover:border-edge",
                  open && "col-span-2 sm:col-span-3 lg:col-span-4",
                )}
              >
                <span className="flex items-start justify-between">
                  <Icon name={itemIcon(item)} size={28} className="text-ink-2" />
                  {!open && menu(item)}
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  {open && editing?.mode === "rename" ? editor(item) : title(item)}
                  <span className="tabular truncate text-xs text-ink-3">{details(item)}</span>
                </span>
                {open && editing?.mode !== "rename" && editor(item)}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

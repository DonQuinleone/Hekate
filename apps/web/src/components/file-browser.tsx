import { descendantsOf, folderPath, formatBytes } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import {
  columnsFor,
  folderCount,
  freshPath,
  type Item,
  itemsIn,
  latestFile,
  versionSummary,
  versionsOf,
} from "~/lib/browser";
import { cn } from "~/lib/cn";
import { ago } from "~/lib/comments";
import { trackStateCopy } from "~/lib/overview";
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
import { Avatar, AvatarRow } from "./avatar";
import { Empty } from "./empty";
import { kindIcon, mediaSummary, UploadButton, UploadList } from "./files";
import { Icon, type IconName } from "./icons";
import { Card } from "./page";
import { Button } from "./ui/button";
import { Input, Select } from "./ui/input";
import { ActionMenu, type MenuAction } from "./ui/menu";
import { StatusDot } from "./ui/status";

type View = "list" | "columns" | "grid";
const VIEW_KEY = "hekate.files.view";
const views: [View, IconName, string][] = [
  ["list", "list", "List"],
  ["columns", "columns", "Columns"],
  ["grid", "grid", "Grid"],
];

/** The remembered view, per browser; storage can be missing or refuse, so list is the fallback. */
function storedView(): View {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === "grid" || v === "columns" ? v : "list";
  } catch {
    return "list";
  }
}

const itemName = (item: Item) =>
  item.kind === "folder"
    ? item.folder.name
    : item.kind === "track"
      ? item.track.name
      : item.kind === "file"
        ? item.file.name
        : `${item.track.name} · V${item.version.number}`;
const itemIcon = (item: Item): IconName =>
  item.kind === "folder"
    ? "folder"
    : item.kind === "track" || item.kind === "version"
      ? "track"
      : kindIcon[item.file.kind];

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
    <form onSubmit={submit} className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <Input
        autoFocus
        aria-label="New name"
        className="max-w-80 min-w-0 flex-1"
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
      <Select
        aria-label="Move to"
        className="max-w-72"
        value={to}
        onChange={(e) => setTo(e.target.value)}
      >
        <option value="">Top of the project</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </Select>
      <Button size="sm" type="submit" disabled={pending || to === (current ?? "")}>
        Move
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}

/** A quick way in, shown when its row is hovered or focused. */
function Quick({ fileId, icon, label }: { fileId: string; icon: IconName; label: string }) {
  return (
    <Link
      to="/files/$fileId"
      params={{ fileId }}
      aria-label={label}
      title={label}
      className="flex size-7 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-raised hover:text-ink"
    >
      <Icon name={icon} size={14} />
    </Link>
  );
}

const rowGrid =
  "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 @3xl/app:grid-cols-[20px_minmax(0,1fr)_150px_170px_100px_100px_88px]";

/** Whether a file is still being prepared, or failed to be. */
const processing = (file: ProjectFile) =>
  file.streamStatus === "failed" ||
  file.analysisStatus === "failed" ||
  file.streamStatus === "pending" ||
  file.analysisStatus === "pending";

/** A file's state while it is prepared, or a dash once it is ready. */
function FileStatus({ file }: { file: ProjectFile }) {
  if (file.streamStatus === "failed" || file.analysisStatus === "failed")
    return (
      <>
        <Icon name="warning" size={14} className="text-signal" />
        <span className="text-ink-2">Failed</span>
      </>
    );
  if (file.streamStatus === "pending" || file.analysisStatus === "pending")
    return (
      <>
        <StatusDot state="in_review" />
        <span className="text-ink-2">Processing</span>
      </>
    );
  return <span className="text-ink-3">—</span>;
}

const details = (file: ProjectFile) =>
  mediaSummary(file.kind, file.mediaInfo, file.streamStatus) ?? file.contentType;

function Comments({ n }: { n: number }) {
  return n > 0 ? (
    <span className="flex items-center gap-0.5" title={`${n} open comments`}>
      <Icon name="comment" size={11} /> {n}
    </span>
  ) : null;
}

/**
 * A project's folders, tracks and files, one folder at a time: as a list, as columns that open
 * one into the next (as the Finder does), or as a grid. A track is a special kind of folder:
 * it sits among them, and the files in its versions live in it rather than loose beside it.
 * Those who can organise make folders and tracks, and rename, move and delete what is here;
 * files dropped anywhere on the page land in the open folder.
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
  const [columnPath, setColumnPath] = useState<Item[]>([]);
  const manage = can("organise");

  // A folder that has gone (deleted elsewhere) leaves the viewer at the top.
  const known = !folderId || !folders || folders.some((f) => f.id === folderId);
  useEffect(() => {
    if (!known) onOpenFolder(null);
  }, [known, onOpenFolder]);
  // The columns start again from the open folder.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the folder is the trigger.
  useEffect(() => setColumnPath([]), [folderId]);

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
  const allFiles = files ?? [];
  const path = folderPath(all, folderId);
  const items = itemsIn(all, allTracks, allFiles, folderId);
  const fileById = new Map(allFiles.map((f) => [f.id, f]));
  const trackComments = (t: Track) =>
    (t.versions.at(-1)?.variations ?? []).reduce(
      (n, v) => n + (fileById.get(v.fileId)?.openComments ?? 0),
      0,
    );
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
        : item.kind === "file" && organise.updateFile.mutate({ id: item.file.id, name }, done);
  const move = (item: Item, to: string | null) =>
    item.kind === "folder"
      ? organise.updateFolder.mutate({ id: item.folder.id, parentId: to }, done)
      : item.kind === "track"
        ? trackMutations.updateTrack.mutate({ id: item.track.id, folderId: to }, done)
        : item.kind === "file" &&
          organise.updateFile.mutate({ id: item.file.id, folderId: to }, done);
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

  const menu = (item: Item, always = false) => {
    if (!manage || item.kind === "version") return null;
    const actions: (MenuAction | "divider")[] = [
      { label: "Rename", onSelect: () => setEditing({ id: item.id, mode: "rename" }) },
      { label: "Move to…", onSelect: () => setEditing({ id: item.id, mode: "move" }) },
      ...(item.kind === "track"
        ? []
        : [
            "divider" as const,
            {
              label: "Delete…",
              danger: true,
              onSelect: () => setEditing({ id: item.id, mode: "delete" as const }),
            },
          ]),
    ];
    return <ActionMenu label={itemName(item)} actions={actions} always={always} />;
  };

  /** The open editor for an item, in place of its menu. */
  const editor = (item: Item) => {
    if (!editing || editing.id !== item.id) return null;
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

  /** A row's name, opening what it is: a folder here, a track or a file on its page. */
  const nameOf = (item: Item, sub?: ReactNode, compact = false) => {
    const pad = compact ? "min-w-0 text-left" : "min-w-0 py-3 text-left";
    const inner = (
      <>
        <span
          className={cn(
            "block truncate text-[14px] text-ink",
            item.kind !== "file" && "font-medium",
          )}
        >
          {itemName(item)}
        </span>
        {sub && (
          <span className="block truncate text-[12px] text-ink-3 @3xl/app:hidden">{sub}</span>
        )}
      </>
    );
    if (item.kind === "folder")
      return (
        <button type="button" onClick={() => onOpenFolder(item.folder.id)} className={pad}>
          {inner}
        </button>
      );
    if (item.kind === "track") {
      const file = latestFile(item.track);
      return file ? (
        <Link to="/files/$fileId" params={{ fileId: file }} className={pad}>
          {inner}
        </Link>
      ) : (
        <Link to="/tracks/$trackId" params={{ trackId: item.track.id }} className={pad}>
          {inner}
        </Link>
      );
    }
    if (item.kind === "file")
      return (
        <Link to="/files/$fileId" params={{ fileId: item.file.id }} className={pad}>
          {inner}
        </Link>
      );
    return null;
  };

  const row = (item: Item) => {
    const open = editing?.id === item.id;
    let cells: ReactNode;
    if (item.kind === "folder") {
      cells = (
        <>
          <Icon name="folder" className="text-ink-2" />
          {open && editing?.mode === "rename"
            ? editor(item)
            : nameOf(item, folderCount(all, allTracks, allFiles, item.folder.id))}
          <span className="hidden text-[13px] text-ink-3 @3xl/app:block">—</span>
          <span className="hidden truncate text-[13px] text-ink-3 @3xl/app:block">
            {folderCount(all, allTracks, allFiles, item.folder.id)}
          </span>
          <span className="hidden @3xl/app:block" />
          <span className="hidden @3xl/app:block" />
        </>
      );
    } else if (item.kind === "track") {
      const t = item.track;
      const copy = trackStateCopy[t.state ?? (t.versions.length ? "not_reviewed" : "no_version")];
      const latest = t.versions.at(-1);
      // While its latest file is prepared, or after that failed, that is what the track says.
      const latestReady = fileById.get(latestFile(t) ?? "");
      const preparing = latestReady && processing(latestReady);
      cells = (
        <>
          <Icon name="track" className="text-ink-2" />
          {open && editing?.mode === "rename"
            ? editor(item)
            : nameOf(item, `${copy.label}${latest ? ` · V${latest.number}` : ""}`)}
          <span className="hidden items-center gap-2 text-[13px] text-ink-2 @3xl/app:flex">
            {preparing ? (
              <FileStatus file={latestReady} />
            ) : (
              <>
                {copy.dot && <StatusDot state={copy.dot} />}
                <span className="truncate">{copy.label}</span>
              </>
            )}
          </span>
          <span className="tabular hidden truncate text-[13px] text-ink-3 @3xl/app:block">
            {versionSummary(t)}
          </span>
          <span className="hidden items-center @3xl/app:flex">
            {t.waitingOn?.length ? (
              <AvatarRow people={t.waitingOn} size={22} max={3} />
            ) : (
              <span className="text-[13px] text-ink-3">—</span>
            )}
          </span>
          <span className="tabular hidden items-center gap-1.5 text-[13px] text-ink-3 @3xl/app:flex">
            {latest ? ago(latest.createdAt) : ""}
            <Comments n={trackComments(t)} />
          </span>
        </>
      );
    } else if (item.kind === "file") {
      const f = item.file;
      cells = (
        <>
          <Icon name={kindIcon[f.kind]} className="text-ink-3" />
          {open && editing?.mode === "rename" ? editor(item) : nameOf(item, details(f))}
          <span className="hidden items-center gap-2 text-[13px] @3xl/app:flex">
            <FileStatus file={f} />
          </span>
          <span className="tabular hidden truncate text-[13px] text-ink-3 @3xl/app:block">
            {details(f)} · {formatBytes(f.byteSize)}
          </span>
          <span className="hidden items-center @3xl/app:flex">
            {f.uploadedBy && f.uploadedById ? (
              <span title={f.uploadedBy}>
                <Avatar id={f.uploadedById} name={f.uploadedBy} size={22} />
              </span>
            ) : (
              <span className="text-[13px] text-ink-3">—</span>
            )}
          </span>
          <span className="tabular hidden items-center gap-1.5 text-[13px] text-ink-3 @3xl/app:flex">
            {ago(f.createdAt)}
            <Comments n={f.openComments ?? 0} />
          </span>
        </>
      );
    }
    const quickFile =
      item.kind === "track" ? latestFile(item.track) : item.kind === "file" ? item.file.id : null;
    return (
      <li key={item.id} className="group border-b border-line last:border-b-0 hover:bg-raised/40">
        <div className={rowGrid}>
          {cells}
          <span className="flex items-center justify-end gap-0.5">
            {quickFile && !open && (
              <span className="hidden opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 @3xl/app:flex">
                <Quick
                  fileId={quickFile}
                  icon={item.kind === "track" ? "play" : "eye"}
                  label={item.kind === "track" ? "Open in the player" : "Open"}
                />
              </span>
            )}
            {!open && menu(item)}
          </span>
        </div>
        {open && editing?.mode !== "rename" && (
          <div className="px-3 pb-3 pl-11">{editor(item)}</div>
        )}
      </li>
    );
  };

  const loadError = error ?? foldersError ?? tracksError;
  if (loadError) return <p className="m-0 text-signal">{loadError.message}</p>;

  const openItem = (item: Item): Item[] | null =>
    item.kind === "folder"
      ? itemsIn(all, allTracks, allFiles, item.folder.id)
      : item.kind === "track" && item.track.versions.length
        ? versionsOf(item.track)
        : null;

  return (
    <section aria-label="Files" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <nav aria-label="Folder path" className="flex min-w-0 items-center gap-1 text-[14px]">
          {path.length === 0 ? (
            <span className="font-medium text-ink">All files</span>
          ) : (
            <button
              type="button"
              className="text-ink-3 hover:text-ink"
              onClick={() => onOpenFolder(null)}
            >
              All files
            </button>
          )}
          {path.map((f, i) => (
            <span key={f.id} className="flex min-w-0 items-center gap-1">
              <span className="text-edge">/</span>
              {i === path.length - 1 ? (
                <span className="truncate font-medium text-ink">{f.name}</span>
              ) : (
                <button
                  type="button"
                  className="truncate text-ink-3 hover:text-ink"
                  onClick={() => onOpenFolder(f.id)}
                >
                  {f.name}
                </button>
              )}
            </span>
          ))}
          <span className="tabular ml-2 shrink-0 text-[13px] text-ink-3">
            {items.length} {items.length === 1 ? "item" : "items"}
          </span>
        </nav>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <fieldset className="m-0 flex rounded-control border border-line bg-raised/40 p-0.5">
            <legend className="sr-only">View</legend>
            {views.map(([v, icon, label]) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                aria-label={label}
                title={label}
                onClick={() => chooseView(v)}
                className={cn(
                  "flex size-7 items-center justify-center rounded-[4px]",
                  view === v ? "bg-overlay text-ink shadow-2" : "text-ink-3 hover:text-ink",
                )}
              >
                <Icon name={icon} size={14} />
              </button>
            ))}
          </fieldset>
          {manage && (
            <ActionMenu
              always
              label="this folder"
              actions={[
                { label: "New folder", onSelect: () => setNaming("folder") },
                ...(withTracks ? [{ label: "New track", onSelect: () => setNaming("track") }] : []),
              ]}
            />
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
          <Input
            autoFocus
            aria-label={naming === "track" ? "Track name" : "Folder name"}
            placeholder={naming === "track" ? "Maple Leaf Rag" : "Mixes"}
            className="w-64"
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
      {failure && <p className="m-0 text-[13px] text-signal">{failure.message}</p>}

      <UploadList />

      {items.length === 0 ? (
        <Empty
          title={folderId ? "This folder is empty" : "Nothing here yet"}
          text={
            can("upload")
              ? `Drop files anywhere on this page to upload them here, or use Upload.${withTracks ? " A track groups a piece's versions." : ""}`
              : "Files appear here once someone uploads them."
          }
        />
      ) : view === "columns" ? (
        <ColumnBrowser
          root={items}
          path={columnPath}
          onPath={setColumnPath}
          open={openItem}
          folders={all}
          tracks={allTracks}
          files={allFiles}
          menu={(item) => menu(item, true)}
          editor={editor}
        />
      ) : view === "list" ? (
        <Card>
          <div
            aria-hidden="true"
            className={cn(
              rowGrid,
              "eyebrow hidden h-9 border-b border-line text-ink-3 @3xl/app:grid",
            )}
          >
            <span />
            <span>Name</span>
            <span>Status</span>
            <span>{withTracks ? "Versions" : "Details"}</span>
            <span>People</span>
            <span>Updated</span>
            <span />
          </div>
          <ul className="m-0 list-none p-0" aria-label="Contents">
            {items.map(row)}
          </ul>
        </Card>
      ) : (
        <ul
          className="m-0 grid list-none grid-cols-2 gap-4 p-0 @3xl/app:grid-cols-4 @6xl/app:grid-cols-5"
          aria-label="Contents"
        >
          {items.map((item) => {
            const open = editing?.id === item.id;
            const sub =
              item.kind === "folder"
                ? folderCount(all, allTracks, allFiles, item.folder.id)
                : item.kind === "track"
                  ? trackStateCopy[item.track.state ?? "no_version"].label
                  : item.kind === "file"
                    ? details(item.file)
                    : "";
            return (
              <li
                key={item.id}
                className={cn(
                  "group relative flex min-w-0 flex-col gap-2.5 rounded-panel-lg border border-line bg-raised/30 p-3 shadow-1 transition-colors hover:border-edge",
                  open && "col-span-2 @3xl/app:col-span-4 @6xl/app:col-span-5",
                )}
              >
                <span className="flex aspect-[2/1] items-center justify-center rounded-[6px] bg-sunken text-ink-3">
                  <Icon name={itemIcon(item)} size={24} />
                </span>
                <span className="flex min-w-0 items-start gap-1">
                  <span className="min-w-0 flex-1">
                    {open && editing?.mode === "rename"
                      ? editor(item)
                      : nameOf(item, undefined, true)}
                    <span className="block truncate text-[12px] text-ink-3">{sub}</span>
                  </span>
                  {!open && menu(item)}
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

function ColumnRow({
  item,
  name,
  hint,
  selected,
  container,
  onClick,
}: {
  item: Item;
  name: string;
  hint?: string;
  selected: boolean;
  container: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors",
          selected ? "bg-raised text-ink" : "text-ink-2 hover:bg-raised/50 hover:text-ink",
        )}
      >
        <Icon name={itemIcon(item)} size={15} className="shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px]">{name}</span>
          {hint && <span className="block truncate text-[11px] text-ink-3">{hint}</span>}
        </span>
        {container && <Icon name="chevronRight" size={12} className="shrink-0 text-ink-3" />}
      </button>
    </li>
  );
}

/** Columns, as the Finder does it: each choice opens the next column; the last shows a preview. */
function ColumnBrowser({
  root,
  path,
  onPath,
  open,
  folders,
  tracks,
  files,
  menu,
  editor,
}: {
  root: Item[];
  path: Item[];
  onPath: (path: Item[]) => void;
  open: (item: Item) => Item[] | null;
  folders: Folder[];
  tracks: Track[];
  files: ProjectFile[];
  menu: (item: Item) => ReactNode;
  editor: (item: Item) => ReactNode;
}) {
  // The path holds what was chosen; after a rename, move, delete or refresh, it follows the
  // current items, and stops where a choice no longer exists.
  const fresh = freshPath(root, path, open);
  const columns = columnsFor(root, fresh, open);
  const last = fresh.at(-1);
  const choose = (depth: number, item: Item) => onPath([...fresh.slice(0, depth), item]);
  const fileById = new Map(files.map((f) => [f.id, f]));
  return (
    <Card className="scroll-quiet flex min-h-[420px] overflow-x-auto">
      {columns.map((col, depth) => (
        <ul
          key={String(depth)}
          aria-label={depth === 0 ? "Contents" : undefined}
          className="m-0 flex w-[240px] shrink-0 list-none flex-col overflow-y-auto border-r border-line p-0 py-1"
        >
          {col.items.map((item) => {
            const selected = col.selected?.id === item.id;
            const common = { item, selected, onClick: () => choose(depth, item) };
            if (item.kind === "folder")
              return <ColumnRow key={item.id} {...common} name={item.folder.name} container />;
            if (item.kind === "track") {
              const copy = trackStateCopy[item.track.state ?? "no_version"];
              const latest = item.track.versions.at(-1);
              return (
                <ColumnRow
                  key={item.id}
                  {...common}
                  name={item.track.name}
                  hint={`${copy.label}${latest ? ` · V${latest.number}` : ""}`}
                  container={item.track.versions.length > 0}
                />
              );
            }
            if (item.kind === "version")
              return (
                <ColumnRow
                  key={item.id}
                  {...common}
                  name={`V${item.version.number}`}
                  hint={`${item.version.variations.length} variation${item.version.variations.length === 1 ? "" : "s"} · ${ago(item.version.createdAt)}`}
                  container={false}
                />
              );
            return (
              <ColumnRow
                key={item.id}
                {...common}
                name={item.file.name}
                hint={details(item.file)}
                container={false}
              />
            );
          })}
          {col.items.length === 0 && <li className="px-3 py-3 text-[12px] text-ink-3">Empty</li>}
        </ul>
      ))}
      {last && open(last) === null ? (
        <Preview
          item={last}
          folders={folders}
          tracks={tracks}
          files={files}
          fileById={fileById}
          menu={menu}
          editor={editor}
        />
      ) : (
        <div className="flex w-[280px] shrink-0 items-center justify-center p-4 text-center text-[12px] text-ink-3">
          {last ? "Choose something inside" : "Choose something to see its details"}
        </div>
      )}
    </Card>
  );
}

function Preview({
  item,
  folders,
  tracks,
  files,
  fileById,
  menu,
  editor,
}: {
  item: Item;
  folders: Folder[];
  tracks: Track[];
  files: ProjectFile[];
  fileById: Map<string, ProjectFile>;
  menu: (item: Item) => ReactNode;
  editor: (item: Item) => ReactNode;
}) {
  const file =
    item.kind === "file"
      ? item.file
      : item.kind === "version"
        ? fileById.get(
            item.version.variations.find((v) => v.isPrimary)?.fileId ??
              item.version.variations[0]?.fileId ??
              "",
          )
        : item.kind === "track"
          ? fileById.get(latestFile(item.track) ?? "")
          : undefined;
  const rows: [string, ReactNode][] = [];
  if (item.kind === "folder")
    rows.push(["Holds", folderCount(folders, tracks, files, item.folder.id)]);
  if (item.kind === "track") {
    rows.push(["Status", trackStateCopy[item.track.state ?? "no_version"].label]);
    rows.push(["Versions", String(item.track.versions.length)]);
  }
  if (item.kind === "version") {
    rows.push(["Added", ago(item.version.createdAt)]);
    rows.push(["Variations", item.version.variations.map((v) => v.name).join(", ")]);
    if (item.version.notes) rows.push(["Notes", item.version.notes]);
  }
  if (file) {
    rows.push(["Format", details(file)]);
    rows.push(["Size", formatBytes(file.byteSize)]);
    rows.push(["Comments", String(file.openComments ?? 0)]);
    if (file.uploadedBy) rows.push(["Uploaded by", file.uploadedBy]);
  }
  return (
    <div className="flex w-[280px] shrink-0 flex-col gap-4 p-4">
      <span className="flex h-[110px] items-center justify-center rounded-[6px] bg-sunken text-ink-3">
        <Icon name={file ? kindIcon[file.kind] : itemIcon(item)} size={28} />
      </span>
      <div className="flex items-start gap-2">
        <h3 className="m-0 min-w-0 flex-1 text-[14px] font-medium break-words text-ink">
          {itemName(item)}
        </h3>
        {menu(item)}
      </div>
      {editor(item)}
      <dl className="m-0 flex flex-col gap-1.5 text-[13px]">
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-3">
            <dt className="w-24 shrink-0 text-ink-3">{k}</dt>
            <dd className="m-0 min-w-0 flex-1 break-words text-ink-2">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-1.5">
        {file && (
          <Button variant="primary" size="sm" asChild>
            <Link to="/files/$fileId" params={{ fileId: file.id }}>
              Open
            </Link>
          </Button>
        )}
        {(item.kind === "track" || item.kind === "version") && (
          <Button variant="ghost" size="sm" asChild>
            <Link to="/tracks/$trackId" params={{ trackId: item.track.id }}>
              Versions
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}

import {
  defaultFileColumns,
  descendantsOf,
  type FileColumn,
  type FileColumnLayout,
  folderPath,
  formatBytes,
  formatDuration,
  type MarkKind,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  type CSSProperties,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import {
  allHave,
  type BrowserFilters,
  bulkTags,
  columnsFor,
  filtering,
  filterProject,
  folderCount,
  freshPath,
  gridTemplate,
  type Item,
  indexMarks,
  itemsIn,
  latestFile,
  markKey,
  movableTo,
  pinnedFirst,
  rangeBetween,
  unviewed,
  versionSummary,
  versionsOf,
} from "~/lib/browser";
import { cn } from "~/lib/cn";
import { ago } from "~/lib/comments";
import { trackStateCopy } from "~/lib/overview";
import {
  type Folder,
  fileColumnsQuery,
  meQuery,
  type ProjectFile,
  projectFilesQuery,
  projectFoldersQuery,
  projectMarksQuery,
  projectTracksQuery,
  type Tag,
  type Track,
  tagsQuery,
  useFileColumns,
  useMarks,
  useOrganise,
  useProjectCan,
  useTagMutations,
  useTrackMutations,
} from "~/lib/queries";
import { Avatar, AvatarRow } from "./avatar";
import { Empty } from "./empty";
import { ColumnHeading, ColumnsMenu, columnNames } from "./file-columns";
import { FilterChips, FilterMenu, TagEditor } from "./file-filters";
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

/**
 * What is being done to one item: renaming it, choosing where it goes, tagging it, or
 * confirming its removal.
 */
type Editing = { id: string; mode: "rename" | "move" | "tags" | "delete" } | null;

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
  any = false,
}: {
  options: { id: string; label: string }[];
  current: string | null;
  pending: boolean;
  onMove: (folderId: string | null) => void;
  onCancel: () => void;
  /** For many things from different places: no destination is where they all are. */
  any?: boolean;
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
      <Button size="sm" type="submit" disabled={pending || (!any && to === (current ?? ""))}>
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

/** On a phone: icon, name, actions. Wider, the columns the member chose (`--cols`). */
const rowGrid =
  "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 @3xl/app:grid-cols-[var(--cols)]";

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

/** A file's first tags, and how many more. */
function TagPills({ ids, tags }: { ids: string[]; tags: Map<string, Tag> }) {
  const names = ids.flatMap((id) => tags.get(id)?.name ?? []);
  if (names.length === 0) return null;
  return (
    <span className="hidden shrink-0 items-center gap-1 @3xl/app:flex">
      {names.slice(0, 2).map((n) => (
        <span
          key={n}
          className="max-w-24 truncate rounded-full border border-line px-1.5 text-[11px] leading-[18px] text-ink-2"
        >
          {n}
        </span>
      ))}
      {names.length > 2 && <span className="text-[11px] text-ink-3">+{names.length - 2}</span>}
    </span>
  );
}

/** What a drag of rows carries: their `kind:id` keys. */
const dragType = "application/x-hekate-items";

/**
 * A row's icon, which becomes its checkbox on hover, on focus, or while anything is
 * selected. Shift with a click selects everything from the last one chosen.
 */
function Pick({
  item,
  checked,
  showing,
  onPick,
}: {
  item: Item;
  checked: boolean;
  showing: boolean;
  onPick: (range: boolean) => void;
}) {
  return (
    <span className="relative flex size-5 items-center justify-center">
      <Icon
        name={itemIcon(item)}
        className={cn(
          item.kind === "file" ? "text-ink-3" : "text-ink-2",
          showing ? "invisible" : "group-focus-within:invisible @3xl/app:group-hover:invisible",
        )}
      />
      <input
        type="checkbox"
        aria-label={`Select ${itemName(item)}`}
        checked={checked}
        onChange={() => {}}
        onClick={(event) => onPick(event.shiftKey)}
        className={cn(
          "absolute inset-0 m-auto size-3.5 cursor-pointer accent-[var(--hk-ink)]",
          showing
            ? "opacity-100"
            : "opacity-0 focus:opacity-100 group-focus-within:opacity-100 @3xl/app:group-hover:opacity-100",
        )}
      />
    </span>
  );
}

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
 * Those who can organise make folders and tracks, and rename, move, tag and delete what is
 * here; files dropped anywhere on the page land in the open folder. Everyone pins things to
 * the top of their folder, keeps favourites and sees what they have not opened, for
 * themselves; filters look across the whole project.
 */
export function FileBrowser({
  projectId,
  folderId,
  onOpenFolder,
  filters,
  onFilter,
  tracks: withTracks,
}: {
  projectId: string;
  folderId: string | null;
  onOpenFolder: (folderId: string | null) => void;
  filters: BrowserFilters;
  onFilter: (filters: BrowserFilters) => void;
  /** Music projects hold tracks. */
  tracks: boolean;
}) {
  const { data: files, error } = useQuery(projectFilesQuery(projectId));
  const { data: folders, error: foldersError } = useQuery(projectFoldersQuery(projectId));
  const { data: trackList, error: tracksError } = useQuery({
    ...projectTracksQuery(projectId),
    enabled: withTracks,
  });
  const { data: markList } = useQuery(projectMarksQuery(projectId));
  const { data: tagList } = useQuery(tagsQuery);
  const { data: me } = useQuery(meQuery);
  const can = useProjectCan(projectId);
  const organise = useOrganise(projectId);
  const trackMutations = useTrackMutations(projectId);
  const setMarks = useMarks(projectId);
  const { data: savedColumns } = useQuery(fileColumnsQuery);
  const saveColumns = useFileColumns();
  /** Widths while a column edge is dragged; kept once it is let go. */
  const [dragging, setDragging] = useState<FileColumnLayout | null>(null);
  const columns = dragging ?? savedColumns ?? defaultFileColumns;
  const gridVars = { "--cols": gridTemplate(columns) } as CSSProperties;
  const names = { ...columnNames, versions: withTracks ? "Versions" : "Details" };
  const tagging = useTagMutations(projectId);
  const [view, setView] = useState<View>(storedView);
  const [naming, setNaming] = useState<"folder" | "track" | null>(null);
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<Editing>(null);
  const [columnPath, setColumnPath] = useState<Item[]>([]);
  const manage = can("organise");
  /** What is selected, by `kind:id`, and where a shift-click or shift-arrow range starts. */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  /** Checkboxes shown without a hover, for phones (from the toolbar menu). */
  const [selectMode, setSelectMode] = useState(false);
  const [bulk, setBulk] = useState<"move" | "tags" | "delete" | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  /** The folder (or "top") something is being dragged over. */
  const [dropOn, setDropOn] = useState<string | null>(null);
  const selecting = selectMode || selected.size > 0;
  // A new place or new filters start a new selection.
  const filterKey = `${filters.show.join()}|${filters.tags.join()}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the folder and filters are the trigger.
  useEffect(() => {
    setSelected(new Set());
    setAnchor(null);
    setBulk(null);
    setSelectMode(false);
  }, [folderId, filterKey]);

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
  const marks = indexMarks(markList ?? []);
  const tags = tagList ?? [];
  const tagById = new Map(tags.map((t) => [t.id, t]));
  const myId = me?.user.id;
  const filtered = filtering(filters);
  const path = filtered ? [] : folderPath(all, folderId);
  const items = filtered
    ? filterProject(all, allTracks, allFiles, filters, myId, marks)
    : pinnedFirst(itemsIn(all, allTracks, allFiles, folderId), marks);
  const order = items.map(markKey);
  const itemByKey = new Map(items.map((i) => [markKey(i), i]));
  const chosen = items.filter((i) => selected.has(markKey(i)));
  const clearSelection = () => {
    setSelected(new Set());
    setAnchor(null);
    setBulk(null);
    setSelectMode(false);
    setBulkError(null);
  };
  /** A click on a checkbox: one more or one fewer, or with Shift everything from the last. */
  const select = (item: Item, range: boolean) => {
    const key = markKey(item);
    setSelected((was) => {
      const next = new Set(was);
      if (range) for (const k of rangeBetween(order, anchor, key)) next.add(k);
      else if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setAnchor(key);
  };

  /**
   * The list's keys, as Linear and the Finder have them: arrows move between rows, Shift with
   * an arrow selects as it goes, x selects the row, Cmd or Ctrl and A selects everything,
   * Escape lets go. Enter opens, as links do.
   */
  const onListKey = (event: KeyboardEvent<HTMLUListElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("input, select, textarea, form, [role=menu], [role=dialog]")) return;
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-key]"));
    const current = target.closest<HTMLElement>("[data-key]")?.dataset.key ?? null;
    const at = current ? order.indexOf(current) : -1;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = Math.min(
        order.length - 1,
        Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)),
      );
      const key = order[next];
      if (!key) return;
      rows
        .find((r) => r.dataset.key === key)
        ?.querySelector<HTMLElement>("[data-name]")
        ?.focus();
      if (event.shiftKey) {
        const from = anchor ?? current ?? key;
        setSelected(new Set(rangeBetween(order, from, key)));
        setAnchor(from);
      }
    } else if (event.key === "x" && current && !event.metaKey && !event.ctrlKey) {
      const item = itemByKey.get(current);
      if (item) select(item, event.shiftKey);
    } else if (event.key === "a" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      setSelected(new Set(order));
    } else if (event.key === "Escape" && selected.size > 0) {
      clearSelection();
    }
  };

  /** Run one change per thing; say how many could not be made, and keep those selected. */
  const runAll = async (work: [Item, () => Promise<unknown>][]) => {
    setBulkBusy(true);
    setBulkError(null);
    const results = await Promise.allSettled(work.map(([, run]) => run()));
    setBulkBusy(false);
    const failed = work.filter((_, i) => results[i]?.status === "rejected");
    const first = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed.length) {
      const why = first?.reason instanceof Error ? first.reason.message : "It was refused";
      setBulkError(`${failed.length} of ${work.length} could not be changed. ${why}`);
      setSelected(new Set(failed.map(([item]) => markKey(item))));
      return false;
    }
    clearSelection();
    return true;
  };
  const moveOne = (item: Item, to: string | null): Promise<unknown> =>
    item.kind === "folder"
      ? organise.updateFolder.mutateAsync({ id: item.folder.id, parentId: to })
      : item.kind === "track"
        ? trackMutations.updateTrack.mutateAsync({ id: item.track.id, folderId: to })
        : item.kind === "file"
          ? organise.updateFile.mutateAsync({ id: item.file.id, folderId: to })
          : Promise.resolve();
  const parentIdOf = (item: Item) =>
    item.kind === "folder"
      ? item.folder.parentId
      : item.kind === "track"
        ? item.track.folderId
        : item.kind === "file"
          ? item.file.folderId
          : null;
  /** Move things into a folder (null, the top), leaving out what is there already or would loop. */
  const moveAll = (moving: Item[], to: string | null) => {
    const allowed = new Set(movableTo(all, moving).map((f) => f.id));
    const work = moving
      .filter((i) => parentIdOf(i) !== to && (to === null || allowed.has(to)))
      .map((i): [Item, () => Promise<unknown>] => [i, () => moveOne(i, to)]);
    if (work.length) void runAll(work);
  };

  /** Dragging rows onto a folder or the path moves them; only for those who organise. */
  const dragStart = (item: Item, event: DragEvent<HTMLElement>) => {
    const key = markKey(item);
    const keys = selected.has(key) ? [...selected] : [key];
    event.dataTransfer.setData(dragType, JSON.stringify(keys));
    event.dataTransfer.effectAllowed = "move";
  };
  const dropTarget = (folder: string | null) =>
    manage
      ? {
          onDragOver: (event: DragEvent<HTMLElement>) => {
            if (!Array.from(event.dataTransfer.types).includes(dragType)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDropOn(folder ?? "top");
          },
          onDragLeave: () => setDropOn(null),
          onDrop: (event: DragEvent<HTMLElement>) => {
            const data = event.dataTransfer.getData(dragType);
            if (!data) return;
            event.preventDefault();
            setDropOn(null);
            const keys = JSON.parse(data) as string[];
            moveAll(
              keys.flatMap((k) => itemByKey.get(k) ?? []),
              folder,
            );
          },
        }
      : {};

  const fileById = new Map(allFiles.map((f) => [f.id, f]));
  /** The file that stands for an item when it comes to being seen: a track's latest. */
  const seenFile = (item: Item) =>
    item.kind === "file"
      ? item.file
      : item.kind === "track"
        ? fileById.get(latestFile(item.track) ?? "")
        : undefined;
  const isNew = (item: Item) => {
    const f = seenFile(item);
    return f !== undefined && unviewed(f, myId, marks);
  };
  /** Where something lives, for results gathered from across the project. */
  const where = (item: Item) => {
    const at =
      item.kind === "folder"
        ? item.folder.parentId
        : item.kind === "track"
          ? item.track.folderId
          : item.kind === "file"
            ? item.file.folderId
            : null;
    const names = folderPath(all, at).map((f) => f.name);
    return names.length ? `In ${names.join(" / ")}` : "At the top of the project";
  };
  const trackComments = (t: Track) =>
    (t.versions.at(-1)?.variations ?? []).reduce(
      (n, v) => n + (fileById.get(v.fileId)?.openComments ?? 0),
      0,
    );
  const parentOf = (folder: Folder) =>
    folderPath(all, folder.parentId).at(-1)?.name ?? "the top of the project";
  const failure =
    setMarks.error ??
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
    if (item.kind === "version") return null;
    const key = markKey(item);
    const self = [{ kind: item.kind, id: item.id }];
    const seen = seenFile(item);
    const personal: (MenuAction | "divider")[] = [
      {
        label: marks.pinned.has(key) ? "Unpin" : "Pin to the top",
        onSelect: () => setMarks.mutate({ items: self, pinned: !marks.pinned.has(key) }),
      },
      {
        label: marks.favourite.has(key) ? "Remove from favourites" : "Add to favourites",
        onSelect: () => setMarks.mutate({ items: self, favourite: !marks.favourite.has(key) }),
      },
      // What someone uploaded they have seen: only others' files can be unseen again.
      ...(seen && (isNew(item) || seen.uploadedById !== myId)
        ? [
            {
              label: isNew(item) ? "Mark as viewed" : "Mark as not viewed",
              onSelect: () =>
                setMarks.mutate({
                  items: [{ kind: "file" as const, id: seen.id }],
                  viewed: isNew(item),
                }),
            },
          ]
        : []),
    ];
    const organising: (MenuAction | "divider")[] = manage
      ? [
          "divider",
          { label: "Rename", onSelect: () => setEditing({ id: item.id, mode: "rename" }) },
          { label: "Move to…", onSelect: () => setEditing({ id: item.id, mode: "move" }) },
          ...(item.kind === "file"
            ? [{ label: "Tags…", onSelect: () => setEditing({ id: item.id, mode: "tags" }) }]
            : []),
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
        ]
      : [];
    return (
      <ActionMenu label={itemName(item)} actions={[...personal, ...organising]} always={always} />
    );
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
    if (editing.mode === "tags" && item.kind === "file") {
      return (
        <TagEditor
          tags={tags}
          initial={item.file.tagIds ?? []}
          pending={tagging.setOnFile.isPending}
          error={(tagging.setOnFile.error ?? tagging.create.error)?.message}
          onCreate={(name) => tagging.create.mutateAsync(name)}
          onSave={(tagIds) =>
            tagging.setOnFile.mutate(
              { fileId: item.file.id, tagIds },
              { onSuccess: () => setEditing(null) },
            )
          }
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
          current={
            item.kind === "folder"
              ? item.folder.parentId
              : item.kind === "track"
                ? item.track.folderId
                : item.kind === "file"
                  ? item.file.folderId
                  : folderId
          }
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
            ? `Delete ${item.folder.name}? What is in it moves to ${parentOf(item.folder)}.`
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
    const key = markKey(item);
    const inner = (
      <>
        <span className="flex min-w-0 items-center gap-1.5">
          {isNew(item) && (
            <span className="size-1.5 shrink-0 rounded-full bg-signal" title="Not yet viewed">
              <span className="sr-only">Not yet viewed: </span>
            </span>
          )}
          <span
            className={cn(
              "min-w-0 truncate text-[14px] text-ink",
              item.kind !== "file" && "font-medium",
            )}
          >
            {itemName(item)}
          </span>
          {marks.pinned.has(key) && (
            <span title="Pinned" className="flex shrink-0 text-ink-3">
              <Icon name="pin" size={12} aria-hidden="true" />
              <span className="sr-only">, pinned</span>
            </span>
          )}
          {marks.favourite.has(key) && (
            <span title="Favourite" className="flex shrink-0 text-ink-3">
              <Icon name="star" size={12} aria-hidden="true" />
              <span className="sr-only">, a favourite</span>
            </span>
          )}
          {!compact && item.kind === "file" && !columns.some((c) => c.id === "tags") && (
            <TagPills ids={item.file.tagIds ?? []} tags={tagById} />
          )}
        </span>
        {filtered && !compact ? (
          <span className="block truncate text-[12px] text-ink-3">{where(item)}</span>
        ) : (
          sub && (
            <span className="block truncate text-[12px] text-ink-3 @3xl/app:hidden">{sub}</span>
          )
        )}
      </>
    );
    if (item.kind === "folder")
      return (
        <button
          type="button"
          data-name
          onClick={() => onOpenFolder(item.folder.id)}
          className={pad}
        >
          {inner}
        </button>
      );
    if (item.kind === "track") {
      const file = latestFile(item.track);
      return file ? (
        <Link to="/files/$fileId" params={{ fileId: file }} className={pad} data-name>
          {inner}
        </Link>
      ) : (
        <Link to="/tracks/$trackId" params={{ trackId: item.track.id }} className={pad} data-name>
          {inner}
        </Link>
      );
    }
    if (item.kind === "file")
      return (
        <Link to="/files/$fileId" params={{ fileId: item.file.id }} className={pad} data-name>
          {inner}
        </Link>
      );
    return null;
  };

  /** What one column says about one item. */
  const cell = (item: Item, id: FileColumn): ReactNode => {
    if (item.kind === "folder") {
      if (id === "status") return "—";
      if (id === "versions") return folderCount(all, allTracks, allFiles, item.folder.id);
      return null;
    }
    if (item.kind === "track") {
      const t = item.track;
      const latest = t.versions.at(-1);
      const file = fileById.get(latestFile(t) ?? "");
      switch (id) {
        case "status": {
          // While its latest file is prepared, or after that failed, that is what it says.
          if (file && processing(file)) return <FileStatus file={file} />;
          const copy =
            trackStateCopy[t.state ?? (t.versions.length ? "not_reviewed" : "no_version")];
          return (
            <>
              {copy.dot && <StatusDot state={copy.dot} />}
              <span className="truncate text-ink-2">{copy.label}</span>
            </>
          );
        }
        case "versions":
          return <span className="tabular truncate">{versionSummary(t)}</span>;
        case "people":
          return t.waitingOn?.length ? <AvatarRow people={t.waitingOn} size={22} max={3} /> : "—";
        case "updated":
          return (
            <span className="tabular flex items-center gap-1.5">
              {latest ? ago(latest.createdAt) : ""}
              <Comments n={trackComments(t)} />
            </span>
          );
        default:
          return file ? fileCell(file, id) : null;
      }
    }
    if (item.kind === "file") {
      const f = item.file;
      switch (id) {
        case "status":
          return <FileStatus file={f} />;
        case "versions":
          return (
            <span className="tabular truncate">
              {details(f)} · {formatBytes(f.byteSize)}
            </span>
          );
        case "people":
          return f.uploadedBy && f.uploadedById ? (
            <span title={f.uploadedBy}>
              <Avatar id={f.uploadedById} name={f.uploadedBy} size={22} />
            </span>
          ) : (
            "—"
          );
        case "updated":
          return (
            <span className="tabular flex items-center gap-1.5">
              {ago(f.createdAt)}
              <Comments n={f.openComments ?? 0} />
            </span>
          );
        default:
          return fileCell(f, id);
      }
    }
    return null;
  };
  /** The columns that describe a file itself, for a file or a track's latest. */
  const fileCell = (f: ProjectFile, id: FileColumn): ReactNode => {
    if (id === "size") return <span className="tabular">{formatBytes(f.byteSize)}</span>;
    if (id === "format") return <span className="truncate">{details(f)}</span>;
    if (id === "duration")
      return f.mediaInfo?.duration !== undefined ? (
        <span className="tabular">{formatDuration(f.mediaInfo.duration)}</span>
      ) : (
        "—"
      );
    if (id === "tags") return <TagPills ids={f.tagIds ?? []} tags={tagById} />;
    return null;
  };
  /** What shows under the name on a phone, where the columns do not. */
  const subOf = (item: Item) => {
    if (item.kind === "folder") return folderCount(all, allTracks, allFiles, item.folder.id);
    if (item.kind === "track") {
      const copy =
        trackStateCopy[
          item.track.state ?? (item.track.versions.length ? "not_reviewed" : "no_version")
        ];
      const latest = item.track.versions.at(-1);
      return `${copy.label}${latest ? ` · V${latest.number}` : ""}`;
    }
    return item.kind === "file" ? details(item.file) : undefined;
  };

  const row = (item: Item) => {
    const open = editing?.id === item.id;
    const cells = (
      <>
        <Pick
          item={item}
          checked={selected.has(markKey(item))}
          showing={selecting}
          onPick={(range) => select(item, range)}
        />
        {open && editing?.mode === "rename" ? editor(item) : nameOf(item, subOf(item))}
        {columns.map((c) => (
          <span
            key={c.id}
            className="hidden min-w-0 items-center gap-2 text-[13px] text-ink-3 @3xl/app:flex"
          >
            {cell(item, c.id)}
          </span>
        ))}
      </>
    );
    const quickFile =
      item.kind === "track" ? latestFile(item.track) : item.kind === "file" ? item.file.id : null;
    return (
      <li
        key={item.id}
        data-key={markKey(item)}
        draggable={manage && !open}
        onDragStart={(event) => dragStart(item, event)}
        onDragEnd={() => setDropOn(null)}
        {...(item.kind === "folder" ? dropTarget(item.folder.id) : {})}
        className={cn(
          "group border-b border-line last:border-b-0 hover:bg-raised/40",
          selected.has(markKey(item)) && "bg-raised/60",
          item.kind === "folder" &&
            dropOn === item.folder.id &&
            "bg-raised shadow-[inset_0_0_0_1px_var(--hk-edge)]",
        )}
      >
        <div className={rowGrid} style={gridVars}>
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
      ? pinnedFirst(itemsIn(all, allTracks, allFiles, item.folder.id), marks)
      : item.kind === "track" && item.track.versions.length
        ? versionsOf(item.track)
        : null;

  return (
    <section aria-label="Files" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <nav aria-label="Folder path" className="flex min-w-0 items-center gap-1 text-[14px]">
          {filtered ? (
            <>
              <button
                type="button"
                className="text-ink-3 hover:text-ink"
                onClick={() => onOpenFolder(null)}
              >
                All files
              </button>
              <span className="text-edge">/</span>
              <span className="font-medium text-ink">Filtered</span>
            </>
          ) : path.length === 0 ? (
            <span className="font-medium text-ink">All files</span>
          ) : (
            <button
              type="button"
              className={cn(
                "rounded-control text-ink-3 hover:text-ink",
                dropOn === "top" && "bg-raised text-ink",
              )}
              onClick={() => onOpenFolder(null)}
              {...dropTarget(null)}
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
                  className={cn(
                    "truncate rounded-control text-ink-3 hover:text-ink",
                    dropOn === f.id && "bg-raised text-ink",
                  )}
                  onClick={() => onOpenFolder(f.id)}
                  {...dropTarget(f.id)}
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
          <FilterMenu filters={filters} tags={tags} onChange={onFilter} />
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
          <ActionMenu
            always
            label="this folder"
            actions={[
              ...(manage
                ? [
                    { label: "New folder", onSelect: () => setNaming("folder") },
                    ...(withTracks
                      ? [{ label: "New track", onSelect: () => setNaming("track") }]
                      : []),
                    "divider" as const,
                  ]
                : []),
              ...(selecting
                ? [{ label: "Stop selecting", onSelect: clearSelection }]
                : [{ label: "Select", hint: "x", onSelect: () => setSelectMode(true) }]),
              { label: "Select all", hint: "⌘A", onSelect: () => setSelected(new Set(order)) },
            ]}
          />
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
      {filtered && <FilterChips filters={filters} tags={tags} onChange={onFilter} />}
      {failure && <p className="m-0 text-[13px] text-signal">{failure.message}</p>}

      <UploadList />

      {items.length === 0 && filtered ? (
        <Empty
          title="Nothing matches these filters"
          text="They look across the whole project. Try fewer, or clear them."
          action={
            <Button size="sm" variant="ghost" onClick={() => onFilter({ show: [], tags: [] })}>
              Clear filters
            </Button>
          }
        />
      ) : items.length === 0 ? (
        <Empty
          title={folderId ? "This folder is empty" : "Nothing here yet"}
          text={
            can("upload")
              ? `Drop files anywhere on this page to upload them here, or use Upload.${withTracks ? " A track groups a piece's versions." : ""}`
              : "Files appear here once someone uploads them."
          }
        />
      ) : view === "columns" && !filtered ? (
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
      ) : view !== "grid" ? (
        <Card>
          <div
            className={cn(
              rowGrid,
              "eyebrow hidden h-9 border-b border-line text-ink-3 @3xl/app:grid",
            )}
            style={gridVars}
          >
            <span />
            <span>Name</span>
            {columns.map((c) => (
              <ColumnHeading
                key={c.id}
                id={c.id}
                name={names[c.id]}
                columns={columns}
                onResize={setDragging}
                onResized={(next) => {
                  setDragging(null);
                  saveColumns.mutate(next);
                }}
              />
            ))}
            <ColumnsMenu columns={columns} names={names} onChange={saveColumns.mutate} />
          </div>
          <ul className="m-0 list-none p-0" aria-label="Contents" onKeyDown={onListKey}>
            {items.map(row)}
          </ul>
        </Card>
      ) : (
        <ul
          className="m-0 grid list-none grid-cols-2 gap-4 p-0 @3xl/app:grid-cols-4 @6xl/app:grid-cols-5"
          aria-label="Contents"
          onKeyDown={onListKey}
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
                data-key={markKey(item)}
                draggable={manage && !open}
                onDragStart={(event) => dragStart(item, event)}
                onDragEnd={() => setDropOn(null)}
                {...(item.kind === "folder" ? dropTarget(item.folder.id) : {})}
                className={cn(
                  "group relative flex min-w-0 flex-col gap-2.5 rounded-panel-lg border border-line bg-raised/30 p-3 shadow-1 transition-colors hover:border-edge",
                  open && "col-span-2 @3xl/app:col-span-4 @6xl/app:col-span-5",
                  (selected.has(markKey(item)) ||
                    (item.kind === "folder" && dropOn === item.folder.id)) &&
                    "border-edge-strong bg-raised/60",
                )}
              >
                <span className="relative flex aspect-[2/1] items-center justify-center rounded-[6px] bg-sunken text-ink-3">
                  <Icon name={itemIcon(item)} size={24} />
                  <input
                    type="checkbox"
                    aria-label={`Select ${itemName(item)}`}
                    checked={selected.has(markKey(item))}
                    onChange={() => {}}
                    onClick={(event) => select(item, event.shiftKey)}
                    className={cn(
                      "absolute top-2 left-2 size-3.5 cursor-pointer accent-[var(--hk-ink)]",
                      selecting
                        ? "opacity-100"
                        : "opacity-0 focus:opacity-100 group-focus-within:opacity-100 @3xl/app:group-hover:opacity-100",
                    )}
                  />
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
      {(chosen.length > 0 || bulkError) && (
        <SelectionBar
          count={chosen.length}
          busy={bulkBusy}
          error={bulkError}
          mode={bulk}
          onMode={setBulk}
          onClear={clearSelection}
          actions={[
            {
              label: allHave(chosen.map(markKey), marks.pinned) ? "Unpin" : "Pin",
              run: () => {
                const items = chosen.map((i) => ({ kind: i.kind as MarkKind, id: i.id }));
                setMarks.mutate({ items, pinned: !allHave(chosen.map(markKey), marks.pinned) });
              },
            },
            {
              label: allHave(chosen.map(markKey), marks.favourite) ? "Unfavourite" : "Favourite",
              run: () => {
                const items = chosen.map((i) => ({ kind: i.kind as MarkKind, id: i.id }));
                setMarks.mutate({
                  items,
                  favourite: !allHave(chosen.map(markKey), marks.favourite),
                });
              },
            },
            // Seen if any is new; otherwise unseen again, but only others' files.
            ...(chosen.some(isNew) ||
            chosen.some((i) => {
              const f = seenFile(i);
              return f !== undefined && f.uploadedById !== myId;
            })
              ? [
                  {
                    label: chosen.some(isNew) ? "Mark as viewed" : "Mark as not viewed",
                    run: () => {
                      const anyNew = chosen.some(isNew);
                      const ids = chosen.flatMap((i) => {
                        const f = seenFile(i);
                        return f && (anyNew || f.uploadedById !== myId) ? [f.id] : [];
                      });
                      setMarks.mutate({
                        items: ids.map((id) => ({ kind: "file" as const, id })),
                        viewed: anyNew,
                      });
                    },
                  },
                ]
              : []),
          ]}
          move={
            manage ? (
              <MoveForm
                options={destinations(movableTo(all, chosen), new Set())}
                current={null}
                pending={bulkBusy}
                onMove={(to) => moveAll(chosen, to)}
                onCancel={() => setBulk(null)}
                any
              />
            ) : null
          }
          tags={
            manage && chosen.some((i) => i.kind === "file") ? (
              <BulkTags
                files={chosen.flatMap((i) => (i.kind === "file" ? [i.file] : []))}
                tags={tags}
                pending={bulkBusy}
                onCreate={(name) => tagging.create.mutateAsync(name)}
                onSave={(files, common, chosenTags) =>
                  void runAll(
                    files.map((f): [Item, () => Promise<unknown>] => [
                      { kind: "file", id: f.id, file: f },
                      () =>
                        tagging.setOnFile.mutateAsync({
                          fileId: f.id,
                          tagIds: bulkTags(f.tagIds ?? [], common, chosenTags),
                        }),
                    ]),
                  )
                }
                onCancel={() => setBulk(null)}
              />
            ) : null
          }
          remove={
            manage && chosen.every((i) => i.kind === "folder" || i.kind === "file")
              ? () =>
                  void runAll(
                    chosen.map((i): [Item, () => Promise<unknown>] => [
                      i,
                      () =>
                        i.kind === "folder"
                          ? organise.deleteFolder.mutateAsync(i.folder.id)
                          : i.kind === "file"
                            ? organise.deleteFile.mutateAsync(i.file.id)
                            : Promise.resolve(),
                    ]),
                  )
              : null
          }
        />
      )}
    </section>
  );
}

/** Tags for many files at once: those on every one start chosen. */
function BulkTags({
  files,
  tags,
  pending,
  onCreate,
  onSave,
  onCancel,
}: {
  files: ProjectFile[];
  tags: Tag[];
  pending: boolean;
  onCreate: (name: string) => Promise<Tag>;
  onSave: (files: ProjectFile[], common: string[], chosen: string[]) => void;
  onCancel: () => void;
}) {
  const common = tags.map((t) => t.id).filter((id) => files.every((f) => f.tagIds?.includes(id)));
  return (
    <TagEditor
      tags={tags}
      initial={common}
      pending={pending}
      onCreate={onCreate}
      onSave={(chosen) => onSave(files, common, chosen)}
      onCancel={onCancel}
    />
  );
}

/**
 * What can be done to everything selected, floating at the foot of the list as Linear and
 * Dropbox have it: personal marks for everyone; moving, tagging and deleting for those who
 * organise. Each change is checked on the server, one thing at a time.
 */
function SelectionBar({
  count,
  busy,
  error,
  mode,
  onMode,
  onClear,
  actions,
  move,
  tags,
  remove,
}: {
  count: number;
  busy: boolean;
  error: string | null;
  mode: "move" | "tags" | "delete" | null;
  onMode: (mode: "move" | "tags" | "delete" | null) => void;
  onClear: () => void;
  actions: { label: string; run: () => void }[];
  move: ReactNode;
  tags: ReactNode;
  remove: (() => void) | null;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Selection"
      className="rise-in sticky bottom-4 z-20 mx-auto flex w-full max-w-3xl flex-col gap-2 rounded-panel-lg bg-overlay p-2 shadow-4"
    >
      {mode === "move" && move && <div className="px-1.5 pt-1">{move}</div>}
      {mode === "tags" && tags && <div className="px-1.5 pt-1">{tags}</div>}
      {mode === "delete" && remove && (
        <div className="flex flex-wrap items-center gap-2 px-1.5 pt-1" role="alert">
          <span className="text-[13px] text-ink-2">
            Delete {count === 1 ? "this" : `these ${count}`}? What is in a folder moves up; files
            cannot be brought back.
          </span>
          <Button size="sm" variant="primary" disabled={busy} onClick={remove}>
            Delete
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onMode(null)}>
            Keep
          </Button>
        </div>
      )}
      {error && <p className="m-0 px-1.5 text-[12px] text-signal">{error}</p>}
      <div className="flex flex-wrap items-center gap-1">
        <span className="tabular px-2 text-[13px] text-ink">{count} selected</span>
        {actions.map((a) => (
          <Button key={a.label} size="sm" variant="ghost" disabled={busy} onClick={a.run}>
            {a.label}
          </Button>
        ))}
        {move && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onMode("move")}>
            Move…
          </Button>
        )}
        {tags && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onMode("tags")}>
            Tags…
          </Button>
        )}
        {remove && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onMode("delete")}>
            Delete…
          </Button>
        )}
        <button
          type="button"
          aria-label="Clear the selection"
          title="Clear the selection (Escape)"
          onClick={onClear}
          className="ml-auto flex size-7 items-center justify-center rounded-control text-ink-3 hover:bg-raised hover:text-ink"
        >
          <Icon name="close" size={14} />
        </button>
      </div>
    </div>
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

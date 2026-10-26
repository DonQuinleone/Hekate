import {
  capital,
  defaultFileColumns,
  descendantsOf,
  downloadLevelOf,
  type FileColumn,
  type FileColumnLayout,
  fileChains,
  folderPath,
  formatBytes,
  formatDuration,
  isPdf,
  type MarkKind,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type CSSProperties,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  allHave,
  type BrowserFilters,
  bulkTags,
  columnsFor,
  filtering,
  filterProject,
  fitColumns,
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
  processingStage,
  rangeBetween,
  trackNext,
  unviewed,
  versionSummary,
  versionsOf,
} from "~/lib/browser";
import { cn } from "~/lib/cn";
import { ago } from "~/lib/comments";
import { trackStateCopy, trackStateLabel } from "~/lib/overview";
import {
  type Folder,
  fileColumnsQuery,
  meQuery,
  type ProjectFile,
  projectFilesQuery,
  projectFoldersQuery,
  projectMarksQuery,
  projectQuery,
  projectTracksQuery,
  type Tag,
  type Track,
  tagsQuery,
  useFileColumns,
  useItemWords,
  useMarks,
  useOrganise,
  useProjectCan,
  useProjectTool,
  useRetryFile,
  useTagMutations,
  useTrackMutations,
  type Version,
} from "~/lib/queries";
import { swappedSummary } from "~/lib/score-swap";
import { useShortcuts } from "~/lib/shortcuts";
import { Avatar, AvatarRow } from "./avatar";
import { DownloadDialog } from "./downloads";
import { Empty } from "./empty";
import { ColumnHeading, ColumnsMenu, columnNames } from "./file-columns";
import { FilterChips, FilterMenu, TagEditor } from "./file-filters";
import { AttachForm, destinations, MoveForm, RenameForm, ScoreForm } from "./file-forms";
import { fileSummary, kindIcon, UploadButton, UploadList } from "./files";
import { Icon, type IconName } from "./icons";
import { Card } from "./page";
import { ShareDialog } from "./share";
import { VariationDialog } from "./track-versions";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/choice";
import { Input } from "./ui/input";
import { ActionMenu, type MenuAction } from "./ui/menu";
import { Segmented } from "./ui/segmented";
import { StatusDot } from "./ui/status";
import { UploadRequestDialog } from "./upload-requests";

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

const itemName = (item: Item, version: (n: number) => string = (n) => `V${n}`) =>
  item.kind === "folder"
    ? item.folder.name
    : item.kind === "track"
      ? item.track.name
      : item.kind === "file"
        ? item.file.name
        : `${item.track.name} · ${version(item.version.number)}`;
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
type Editing = {
  id: string;
  mode: "rename" | "move" | "tags" | "attach" | "score" | "delete";
} | null;

/** A row's quick ways in and actions, shown when it is hovered or focused. */
const quickClass =
  "flex size-7 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-raised hover:text-ink";

/** A quick action on a row that stays on the page: a dialog, a download. */
function Quick({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={quickClass}>
      <Icon name={icon} size={14} />
    </button>
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

/**
 * A file's state while it is prepared (measuring, preparing playback, analysing, drawing
 * pages), or failed with a way to try again for those who may; a dash once it is ready.
 */
function FileStatus({
  file,
  onRetry,
  retrying = false,
}: {
  file: ProjectFile;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const stage = processingStage(file);
  if (stage === "Failed")
    return (
      <>
        <Icon name="warning" size={14} className="shrink-0 text-signal" />
        <span className="text-ink-2">Failed</span>
        {onRetry && (
          <button
            type="button"
            disabled={retrying}
            onClick={onRetry}
            className="rounded-control px-1.5 text-[12px] text-ink-2 hover:bg-raised hover:text-ink disabled:opacity-50"
          >
            Retry
          </button>
        )}
      </>
    );
  if (stage)
    return (
      <>
        <StatusDot state="in_review" />
        <span className="truncate text-ink-2">{stage}</span>
      </>
    );
  return <span className="text-ink-3">—</span>;
}

const details = (file: ProjectFile) => fileSummary(file);

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
      <Checkbox
        aria-label={`Select ${itemName(item)}`}
        checked={checked}
        onChange={() => {}}
        onClick={(event) => onPick(event.shiftKey)}
        className={cn(
          "absolute inset-0 m-auto",
          showing
            ? "opacity-100"
            : "opacity-0 focus-within:opacity-100 group-focus-within:opacity-100 @3xl/app:group-hover:opacity-100",
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
  /** Music projects hold tracks, and video projects deliverables (#16). */
  tracks: boolean;
}) {
  const { words, versionLabel, video } = useItemWords(projectId);
  const profile = video ? "video" : undefined;
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
  const tool = useProjectTool(projectId);
  const { data: project } = useQuery(projectQuery(projectId));
  // An archived project is looked at, not worked on: comparing goes with the rest (#131).
  const live = Boolean(project && !project.archivedAt);
  /** Members download as their role allows (#136); the dialog says what is on offer. */
  const mayDownload = downloadLevelOf(project?.permissions ?? []) !== "none";
  const organise = useOrganise(projectId);
  const trackMutations = useTrackMutations(projectId);
  const setMarks = useMarks(projectId);
  const retry = useRetryFile(projectId);
  const navigate = useNavigate();
  const { data: savedColumns } = useQuery(fileColumnsQuery);
  const saveColumns = useFileColumns();
  /** Widths while a column edge is dragged; kept once it is let go. */
  const [dragging, setDragging] = useState<FileColumnLayout | null>(null);
  const chosenColumns = dragging ?? savedColumns ?? defaultFileColumns;
  /** How wide the list is, to leave off the columns that do not fit (as Linear does). */
  const [listWidth, setListWidth] = useState<number | null>(null);
  const watching = useRef<ResizeObserver | null>(null);
  const listBox = useCallback((marker: HTMLDivElement | null) => {
    watching.current?.disconnect();
    const box = marker?.parentElement;
    if (!box) return;
    watching.current = new ResizeObserver(([entry]) =>
      setListWidth(entry?.contentRect.width ?? null),
    );
    watching.current.observe(box);
  }, []);
  const columns = listWidth === null ? chosenColumns : fitColumns(chosenColumns, listWidth);
  const gridVars = { "--cols": gridTemplate(columns) } as CSSProperties;
  const names = {
    ...columnNames,
    versions: withTracks ? capital(words.versions) : "Details",
  };
  const tagging = useTagMutations(projectId);
  const [view, setView] = useState<View>(storedView);
  const [naming, setNaming] = useState<"folder" | "track" | null>(null);
  const [requesting, setRequesting] = useState(false);
  /** What is being shared from its row (`track:<id>` or `file:<id>`), downloaded, or replaced. */
  const [sharing, setSharing] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<{ fileId: string; name: string } | null>(null);
  const [replacing, setReplacing] = useState<{ track: Track; version: Version } | null>(null);
  /** What linking another score did to the marks on the old one. */
  const [scoreNote, setScoreNote] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<Editing>(null);
  const [columnPath, setColumnPath] = useState<Item[]>([]);
  const manage = can("organise");
  /** Deleting is its own level above organising (#142). */
  const mayDelete = can("delete_files");
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
  /** Scrolls a long list to a row it has not drawn yet; set by the list itself. */
  const reveal = useRef<((index: number) => void) | null>(null);
  /** The row the keys have reached while it is still being brought into view. */
  const cursor = useRef<number | null>(null);
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
  // The list takes these itself, once it has focus; the map shows them while it is here.
  useShortcuts("files", "Files", [
    { keys: ["j", "ArrowDown"], label: "Next item", where: "In the list" },
    { keys: ["k", "ArrowUp"], label: "Previous item", where: "In the list" },
    { keys: ["Enter"], label: "Open", where: "In the list" },
    { keys: ["x"], label: "Select, or with Shift a range", where: "In the list" },
    { keys: ["Mod+A"], label: "Select everything", where: "In the list" },
    { keys: ["Escape"], label: "Clear the selection", where: "In the list" },
  ]);

  const onListKey = (event: KeyboardEvent<HTMLUListElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("input, select, textarea, form, [role=menu], [role=dialog]")) return;
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-key]"));
    const current = target.closest<HTMLElement>("[data-key]")?.dataset.key ?? null;
    // While a row is being brought into view, keys count on from it, not from the old focus.
    const at = cursor.current ?? (current ? order.indexOf(current) : -1);
    // j and k move as the arrows do, as in Gmail and Linear.
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
    const pressed =
      plain && event.key === "j" ? "ArrowDown" : plain && event.key === "k" ? "ArrowUp" : event.key;
    if (pressed === "ArrowDown" || pressed === "ArrowUp") {
      event.preventDefault();
      const next = Math.min(order.length - 1, Math.max(0, at + (pressed === "ArrowDown" ? 1 : -1)));
      const key = order[next];
      if (!key) return;
      const list = event.currentTarget;
      const focus = () => {
        const name = list.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"] [data-name]`);
        if (!name) return false;
        name.focus();
        if (cursor.current === next) cursor.current = null;
        return true;
      };
      if (rows.some((r) => r.dataset.key === key)) {
        cursor.current = null;
        focus();
      } else {
        // A long list draws only what is near the view: bring the row in, then focus it.
        cursor.current = next;
        reveal.current?.(next);
        // Until it is drawn (a second at most), unless a later key has moved on: focus never
        // lands on a row behind the one asked for.
        const settle = (tries: number) =>
          requestAnimationFrame(() => {
            if (cursor.current !== next) return;
            if (!focus() && tries > 0) settle(tries - 1);
          });
        settle(60);
      }
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
  /** Where each file sits in its version chain (#149), for the latest to say which it is. */
  const chains = fileChains(
    allFiles.map((f) => ({ id: f.id, previousFileId: f.previousFileId ?? null })),
  );
  /** A file's details, led by its version where a chain has it. */
  const fileSummary = (f: ProjectFile) => {
    const place = chains.get(f.id);
    return `${place ? `V${place.number} · ` : ""}${details(f)}`;
  };
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
    retry.error ??
    trackMutations.createTrack.error ??
    trackMutations.updateTrack.error ??
    trackMutations.chooseScore.error ??
    trackMutations.createVersion.error ??
    trackMutations.addVariation.error;

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
    const failedFile = seen && processingStage(seen) === "Failed" && can("upload") ? seen : null;
    const organising: (MenuAction | "divider")[] = manage
      ? [
          "divider",
          { label: "Rename", onSelect: () => setEditing({ id: item.id, mode: "rename" }) },
          { label: "Move to…", onSelect: () => setEditing({ id: item.id, mode: "move" }) },
          // The score beside its recordings, as its versions page links one (#52).
          ...(item.kind === "track" && !video
            ? [
                {
                  label: "Link a score…",
                  onSelect: () => setEditing({ id: item.id, mode: "score" }),
                },
              ]
            : []),
          ...(item.kind === "file"
            ? [{ label: "Tags…", onSelect: () => setEditing({ id: item.id, mode: "tags" }) }]
            : []),
          // Downloads come with #136 (watermarked, logged); takes once sessions exist.
          ...(item.kind === "file" && withTracks && allTracks.length > 0 && can("upload")
            ? [
                {
                  label: `Attach to a ${words.track}…`,
                  onSelect: () => setEditing({ id: item.id, mode: "attach" }),
                },
              ]
            : []),
          ...(item.kind === "track" || !mayDelete
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
    // Comparing as the track's page offers it; sharing as the project's reviews page does.
    const aboutItem: MenuAction[] = [
      ...(item.kind === "track" && live && item.track.versions.length > 1 && tool("compare")
        ? [
            {
              label: `Compare ${words.versions}`,
              onSelect: () =>
                void navigate({
                  to: "/tracks/$trackId/compare",
                  params: { trackId: item.track.id },
                }),
            },
          ]
        : []),
      ...(item.kind !== "folder" && can("request_reviews")
        ? [{ label: "Share…", onSelect: () => setSharing(key) }]
        : []),
      ...(item.kind === "file"
        ? [
            {
              label: "Details",
              onSelect: () =>
                void navigate({
                  to: "/files/$fileId",
                  params: { fileId: item.file.id },
                  search: { sheet: "details" },
                }),
            },
          ]
        : []),
    ];
    const about: (MenuAction | "divider")[] = aboutItem.length ? ["divider", ...aboutItem] : [];
    const recovering: (MenuAction | "divider")[] = failedFile
      ? ["divider", { label: "Try preparing again", onSelect: () => retry.mutate(failedFile.id) }]
      : [];
    return (
      <ActionMenu
        label={itemName(item, versionLabel)}
        actions={[...personal, ...about, ...recovering, ...organising]}
        always={always}
      />
    );
  };

  /** The open editor for an item, in place of its menu. */
  const editor = (item: Item) => {
    if (!editing || editing.id !== item.id) return null;
    if (editing.mode === "rename") {
      return (
        <RenameForm
          initial={itemName(item, versionLabel)}
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
    if (editing.mode === "score" && item.kind === "track") {
      return (
        <ScoreForm
          scores={allFiles.filter((f) => isPdf(f.name, f.contentType))}
          current={item.track.scoreFileId}
          pending={trackMutations.chooseScore.isPending}
          onChoose={(scoreFileId) =>
            trackMutations.chooseScore.mutate(
              { id: item.track.id, scoreFileId },
              {
                onSuccess: ({ rehomed }) => {
                  setEditing(null);
                  setScoreNote(rehomed ? swappedSummary(rehomed) : null);
                },
              },
            )
          }
          onCancel={() => setEditing(null)}
        />
      );
    }
    if (editing.mode === "attach" && item.kind === "file") {
      return (
        <AttachForm
          file={item.file}
          tracks={allTracks}
          pending={trackMutations.createVersion.isPending || trackMutations.addVariation.isPending}
          onAttach={(track, as, name) => {
            const latest = track.versions.at(-1);
            if (as === "variation" && latest)
              trackMutations.addVariation.mutate(
                { versionId: latest.id, fileId: item.file.id, name },
                done,
              );
            else
              trackMutations.createVersion.mutate(
                { trackId: track.id, variations: [{ fileId: item.file.id, name }] },
                done,
              );
          }}
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
            : `Delete ${itemName(item, versionLabel)}? This cannot be undone.`}
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
    const pad = compact ? "min-w-0 text-left" : "min-w-0 py-row text-left";
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
            {itemName(item, versionLabel)}
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

  const statusOf = (f: ProjectFile) => (
    <FileStatus
      file={f}
      onRetry={can("upload") ? () => retry.mutate(f.id) : undefined}
      retrying={retry.isPending}
    />
  );
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
          if (file && processing(file)) return statusOf(file);
          const state = t.state ?? (t.versions.length ? "not_reviewed" : "no_version");
          const copy = trackStateCopy[state];
          return (
            <>
              {copy.dot && <StatusDot state={copy.dot} />}
              <span className="truncate text-ink-2">{trackStateLabel(state, profile)}</span>
            </>
          );
        }
        case "versions":
          return <span className="tabular truncate">{versionSummary(t, profile)}</span>;
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
          return statusOf(f);
        case "versions":
          return (
            <span className="tabular truncate">
              {fileSummary(f)} · {formatBytes(f.byteSize)}
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
      const state =
        item.track.state ?? (item.track.versions.length ? "not_reviewed" : "no_version");
      const latest = item.track.versions.at(-1);
      return `${trackStateLabel(state, profile)}${latest ? ` · ${versionLabel(latest.number)}` : ""}`;
    }
    return item.kind === "file" ? fileSummary(item.file) : undefined;
  };

  /**
   * A row's quick ways in, as the prototype has them: a track opens in the player, its
   * versions and notes, and its takes; then the one thing it most wants next (its first
   * version, a file to replace, delivering it once approved, or a review). A file opens, or
   * downloads. Each for those who may, as the page it leads to decides.
   */
  const quickActions = (item: Item): ReactNode[] => {
    const icon = (name: IconName) => <Icon name={name} size={14} />;
    if (item.kind === "file") {
      const f = item.file;
      return [
        <Link
          key="open"
          to="/files/$fileId"
          params={{ fileId: f.id }}
          aria-label="Open"
          title="Open"
          className={quickClass}
        >
          {icon("eye")}
        </Link>,
        ...(mayDownload
          ? [
              <Quick
                key="download"
                icon="download"
                label="Download"
                onClick={() => setDownloading({ fileId: f.id, name: f.name })}
              />,
            ]
          : []),
      ];
    }
    if (item.kind !== "track") return [];
    const t = item.track;
    const latest = t.versions.at(-1);
    const fileId = latestFile(t);
    const out: ReactNode[] = [];
    if (fileId)
      out.push(
        <Link
          key="play"
          to="/files/$fileId"
          params={{ fileId }}
          aria-label="Open in the player"
          title="Open in the player"
          className={quickClass}
        >
          {icon("play")}
        </Link>,
      );
    const notes = `${capital(words.versions)} and notes`;
    out.push(
      <Link
        key="versions"
        to="/tracks/$trackId"
        params={{ trackId: t.id }}
        search={{ view: "versions" }}
        aria-label={notes}
        title={notes}
        className={quickClass}
      >
        {icon("list")}
      </Link>,
    );
    if ((t.takes ?? 0) > 0 && can("view_takes") && !video)
      out.push(
        <Link
          key="takes"
          to="/tracks/$trackId"
          params={{ trackId: t.id }}
          search={{ view: "takes" }}
          aria-label="Takes"
          title="Takes"
          className={quickClass}
        >
          {icon("take")}
        </Link>,
      );
    const next = trackNext(t, {
      upload: can("upload"),
      organise: manage,
      download: mayDownload,
      requestReviews: can("request_reviews"),
    });
    if (next === "add") {
      const first = `Add the first ${words.version}`;
      out.push(
        <Link
          key="add"
          to="/tracks/$trackId"
          params={{ trackId: t.id }}
          search={{ view: "versions" }}
          aria-label={first}
          title={first}
          className={quickClass}
        >
          {icon("upload")}
        </Link>,
      );
    } else if (next === "replace" && latest) {
      out.push(
        <Quick
          key="replace"
          icon="refresh"
          label="Replace the file"
          onClick={() => setReplacing({ track: t, version: latest })}
        />,
      );
    } else if (next === "deliver" && fileId) {
      out.push(
        <Quick
          key="deliver"
          icon="download"
          label="Deliver"
          onClick={() => setDownloading({ fileId, name: fileById.get(fileId)?.name ?? t.name })}
        />,
      );
    } else if (next === "review") {
      out.push(
        <Link
          key="review"
          to="/projects/$projectId/reviews/new"
          params={{ projectId }}
          search={{ item: `track:${t.id}` }}
          aria-label="Request a review"
          title="Request a review"
          className={quickClass}
        >
          {icon("review")}
        </Link>,
      );
    }
    return out;
  };

  const row = (item: Item, place?: Place) => {
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
    const quick = open ? [] : quickActions(item);
    return (
      <li
        key={item.id}
        ref={place?.ref}
        data-index={place?.index}
        style={place?.style}
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
            {quick.length > 0 && (
              <span className="hidden items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 @3xl/app:flex">
                {quick}
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
          <Segmented
            label="View"
            value={view}
            options={views.map(([v, icon, label]) => ({
              value: v,
              label,
              icon: <Icon name={icon} size={14} />,
            }))}
            onChange={chooseView}
          />
          <ActionMenu
            always
            label="this folder"
            actions={[
              ...(manage
                ? [
                    { label: "New folder", onSelect: () => setNaming("folder") },
                    ...(withTracks
                      ? [
                          {
                            label: `New ${words.track}`,
                            onSelect: () => setNaming("track"),
                          },
                        ]
                      : []),
                    { label: "Upload request…", onSelect: () => setRequesting(true) },
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

      {sharing && (
        <ShareDialog projectId={projectId} item={sharing} onClose={() => setSharing(null)} />
      )}
      {downloading && (
        <DownloadDialog
          fileId={downloading.fileId}
          name={downloading.name}
          onClose={() => setDownloading(null)}
        />
      )}
      {replacing && (
        <VariationDialog
          track={replacing.track}
          version={replacing.version}
          mode="replace"
          onClose={() => setReplacing(null)}
        />
      )}
      {requesting && (
        <UploadRequestDialog
          projectId={projectId}
          folders={folders ?? []}
          tracks={withTracks ? (trackList ?? []) : []}
          folderId={folderId}
          onClose={() => setRequesting(false)}
        />
      )}

      {naming && (
        <form
          onSubmit={create}
          className="flex flex-wrap items-center gap-2"
          aria-label={naming === "track" ? `New ${words.track}` : "New folder"}
        >
          <Input
            autoFocus
            aria-label={naming === "track" ? `${capital(words.track)} name` : "Folder name"}
            placeholder={
              naming === "track"
                ? words.track === "deliverable"
                  ? "Trailer 60s"
                  : "Maple Leaf Rag"
                : "Mixes"
            }
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
      <p role="status" className={cn("m-0 text-[13px] text-ink-3", !scoreNote && "sr-only")}>
        {scoreNote}
      </p>

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
              ? `Drop files anywhere on this page to upload them here, or use Upload.${withTracks ? (words.track === "deliverable" ? " A deliverable groups its cuts." : " A track groups a piece's versions.") : ""}`
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
          <div ref={listBox} />
          <div
            className={cn(
              rowGrid,
              "eyebrow hidden h-9 border-b border-line text-ink-3 @3xl/app:grid",
            )}
            style={gridVars}
          >
            <span />
            <span>Name</span>
            {/* Headings for the columns that fit; widths and choices work on all of them. */}
            {columns.map((c) => (
              <ColumnHeading
                key={c.id}
                id={c.id}
                name={names[c.id]}
                columns={chosenColumns}
                onResize={setDragging}
                onResized={(next) => {
                  setDragging(null);
                  saveColumns.mutate(next);
                }}
              />
            ))}
            <ColumnsMenu
              columns={chosenColumns}
              shown={columns.map((c) => c.id)}
              names={names}
              onChange={saveColumns.mutate}
            />
          </div>
          <Rows items={items} row={row} onKeyDown={onListKey} reveal={reveal} />
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
                  ? trackStateLabel(item.track.state ?? "no_version", profile)
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
                  <Checkbox
                    aria-label={`Select ${itemName(item, versionLabel)}`}
                    checked={selected.has(markKey(item))}
                    onChange={() => {}}
                    onClick={(event) => select(item, event.shiftKey)}
                    className={cn(
                      "absolute top-2 left-2",
                      selecting
                        ? "opacity-100"
                        : "opacity-0 focus-within:opacity-100 group-focus-within:opacity-100 @3xl/app:group-hover:opacity-100",
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
            mayDelete && chosen.every((i) => i.kind === "folder" || i.kind === "file")
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

/** Where a row of a long list sits, drawn only while near the view. */
interface Place {
  index: number;
  ref: (element: Element | null) => void;
  style: CSSProperties;
}

/** From how many rows a list draws only those near the view. */
const VIRTUAL_FROM = 200;

/**
 * The list's rows. A short list draws them all; a long one (thousands of files) draws only
 * those in and near the view, measuring each as it appears, so it scrolls smoothly.
 */
function Rows({
  items,
  row,
  onKeyDown,
  reveal,
}: {
  items: Item[];
  row: (item: Item, place?: Place) => ReactNode;
  onKeyDown: (event: KeyboardEvent<HTMLUListElement>) => void;
  reveal: { current: ((index: number) => void) | null };
}) {
  const list = useRef<HTMLUListElement>(null);
  const many = items.length >= VIRTUAL_FROM;
  /** How far down its scrolling area the list starts. */
  const [margin, setMargin] = useState(0);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const scroller = () => list.current?.closest("main") ?? null;
  // Measured after every render, since what sits above the list (uploads, filter chips) can
  // grow or shrink while it stays; and again when the window changes size.
  useLayoutEffect(() => {
    const area = list.current?.closest("main");
    if (!many || !list.current || !area) return;
    const next =
      list.current.getBoundingClientRect().top - area.getBoundingClientRect().top + area.scrollTop;
    if (Math.abs(next - margin) > 0.5) setMargin(next);
  });
  useEffect(() => {
    if (!many) return;
    const again = () => redraw();
    window.addEventListener("resize", again);
    return () => window.removeEventListener("resize", again);
  }, [many]);
  const virtual = useVirtualizer({
    count: many ? items.length : 0,
    getScrollElement: scroller,
    estimateSize: () => 49,
    overscan: 12,
    scrollMargin: margin,
  });
  useEffect(() => {
    reveal.current = many ? (index) => virtual.scrollToIndex(index, { align: "auto" }) : null;
    return () => {
      reveal.current = null;
    };
  }, [many, virtual, reveal]);
  if (!many)
    return (
      <ul ref={list} className="m-0 list-none p-0" aria-label="Contents" onKeyDown={onKeyDown}>
        {items.map((item) => row(item))}
      </ul>
    );
  return (
    <ul
      ref={list}
      className="relative m-0 list-none p-0"
      aria-label="Contents"
      onKeyDown={onKeyDown}
      style={{ height: virtual.getTotalSize() }}
    >
      {virtual.getVirtualItems().map((v) => {
        const item = items[v.index];
        return item
          ? row(item, {
              index: v.index,
              ref: virtual.measureElement,
              style: {
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${v.start - margin}px)`,
              },
            })
          : null;
      })}
    </ul>
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
  const { words, versionLabel, video } = useItemWords(tracks[0]?.projectId);
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
              const state = item.track.state ?? "no_version";
              const latest = item.track.versions.at(-1);
              return (
                <ColumnRow
                  key={item.id}
                  {...common}
                  name={item.track.name}
                  hint={`${trackStateLabel(state, video ? "video" : undefined)}${latest ? ` · ${versionLabel(latest.number)}` : ""}`}
                  container={item.track.versions.length > 0}
                />
              );
            }
            if (item.kind === "version")
              return (
                <ColumnRow
                  key={item.id}
                  {...common}
                  name={versionLabel(item.version.number)}
                  hint={`${item.version.variations.length} ${item.version.variations.length === 1 ? words.variation : words.variations} · ${ago(item.version.createdAt)}`}
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
  const { words, versionLabel, video } = useItemWords(tracks[0]?.projectId);
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
    rows.push([
      "Status",
      trackStateLabel(item.track.state ?? "no_version", video ? "video" : undefined),
    ]);
    rows.push([capital(words.versions), String(item.track.versions.length)]);
  }
  if (item.kind === "version") {
    rows.push(["Added", ago(item.version.createdAt)]);
    rows.push([capital(words.variations), item.version.variations.map((v) => v.name).join(", ")]);
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
          {itemName(item, versionLabel)}
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

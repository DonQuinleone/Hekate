import {
  capital,
  defaultFileColumns,
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
  type MouseEvent,
  type ReactNode,
  type RefObject,
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
  droppableOnTrack,
  favouritesFirst,
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
  movesInto,
  parentIdOf,
  processingStage,
  rangeBetween,
  trackNext,
  unviewed,
  variationNameFor,
  versionSummary,
  versionsOf,
} from "~/lib/browser";
import { cn } from "~/lib/cn";
import { ago } from "~/lib/comments";
import { isMac } from "~/lib/keys";
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
import { FilterChips, FilterMenu } from "./file-filters";
import { AttachForm, MovePicker, RenameInput, ScoreForm } from "./file-forms";
import { fileSummary, kindIcon, UploadButton, UploadList, useUploads } from "./files";
import { Icon, type IconName } from "./icons";
import { Card } from "./page";
import { ShareDialog } from "./share";
import { TagInput } from "./tag-input";
import { VariationDialog } from "./track-versions";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/choice";
import { Floating, type Point, withinOrFloatingFrom } from "./ui/floating";
import { FileInput, Input } from "./ui/input";
import { ActionMenu, ContextMenu, type MenuAction } from "./ui/menu";
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
 * What is being done to one item in its row: renaming it, tagging it (from the cell or the
 * name the editor floats from), attaching it, linking its score, or confirming its removal.
 * Moving has a dialog of its own.
 */
type Editing = {
  id: string;
  mode: "rename" | "tags" | "attach" | "score" | "delete";
  at?: RefObject<HTMLElement | null>;
} | null;

/** Where a context menu opened, and on what: a row, the selection, or the empty space. */
interface OpenMenu {
  at: Point | RefObject<HTMLElement | null>;
  target: Item | "selection" | "space";
}

/** How long after a click on a selected name a second click still opens rather than renames. */
const SLOW_CLICK_MS = 400;

/** A shortcut's hint in a menu: the command key on a Mac, Ctrl elsewhere. */
const mod = (key: string) => (isMac() ? `⌘${key}` : `Ctrl+${key}`);

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
 * A row's tags edited over the row, floating from its tag cell (or its name, when the list
 * shows no Tags column): the row stays as it is underneath, as Notion's cells do.
 */
function TagPopover({
  anchor,
  label,
  onClose,
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const away = (event: PointerEvent) => {
      if (!withinOrFloatingFrom(event, anchor.current)) close.current();
    };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [anchor]);
  return (
    <Floating
      anchor={anchor}
      align="start"
      gap={-2}
      role="dialog"
      aria-label={label}
      data-e2e-overlap
      className="rise-in w-80 rounded-panel-lg bg-overlay p-2 shadow-4"
    >
      {children}
    </Floating>
  );
}

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
 * here; files dropped anywhere on the page land in the open folder. Everyone keeps favourites
 * (which sit at the top of their folder) and sees what they have not opened, for themselves;
 * filters look across the whole project.
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
  /** One personal mark (decision 269), written as both while the pin is still stored. */
  const favour = (marked: { kind: MarkKind; id: string }[], on: boolean) =>
    setMarks.mutate({ items: marked, favourite: on, pinned: on });
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
  /** What is chosen in the columns below the open folder; the folder's own path is the address's. */
  const [columnPath, setColumnPath] = useState<Item[]>([]);
  const manage = can("organise");
  /** Deleting is its own level above organising (#142). */
  const mayDelete = can("delete_files");
  /** What is selected, by `kind:id`, and where a shift-click or shift-arrow range starts. */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  /** Checkboxes shown without a hover, for phones (from the toolbar menu). */
  const [selectMode, setSelectMode] = useState(false);
  const [bulk, setBulk] = useState<"tags" | "delete" | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  /** The folder ("top" for the top of the project) or track (`track:<id>`) being dragged over. */
  const [dropOn, setDropOn] = useState<string | null>(null);
  /** The keys of the rows being dragged, readable while they are over a target. */
  const dragged = useRef<string[]>([]);
  /** The context menu, while it is open. */
  const [contextMenu, setContextMenu] = useState<OpenMenu | null>(null);
  /** What is being moved through the folder picker. */
  const [moving, setMoving] = useState<Item[] | null>(null);
  /** What was cut (Cmd or Ctrl and X), by key, waiting to be pasted into a folder. */
  const [cut, setCut] = useState<Set<string>>(new Set());
  /** A click on a selected row's name, waiting to see whether a second one follows. */
  const slowClick = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uploads = useUploads();
  const chooser = useRef<HTMLInputElement>(null);
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
    : favouritesFirst(itemsIn(all, allTracks, allFiles, folderId), marks);
  const order = items.map(markKey);
  /**
   * The columns always start at the top of the project (as the Finder's do), with the open
   * folder's ancestors opened and the folder chosen; choosing another folder in them opens it.
   */
  const rootItems =
    folderId === null ? items : favouritesFirst(itemsIn(all, allTracks, allFiles, null), marks);
  const folderItems: Item[] = path.map((f) => ({ kind: "folder", id: f.id, folder: f }));
  const chooseInColumns = (next: Item[]) => {
    let deepest = -1;
    next.forEach((i, at) => {
      if (i.kind === "folder") deepest = at;
    });
    const folder = next[deepest];
    const into = folder?.kind === "folder" ? folder.folder.id : null;
    setColumnPath(next.slice(deepest + 1));
    if (into !== folderId) onOpenFolder(into);
  };
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
    { keys: ["Shift+F10"], label: "Open the menu", where: "In the list" },
    { keys: ["F2"], label: "Rename", where: "In the list" },
    { keys: ["Mod+X"], label: "Cut, to paste into a folder", where: "In the list" },
    { keys: ["Mod+V"], label: "Paste into this folder", where: "In the list" },
    { keys: ["Escape"], label: "Clear the selection", where: "In the list" },
  ]);

  /** The context menu from the keyboard: on the row that has focus, or on the list. */
  const menuFromKeys = (target: HTMLElement, list: HTMLElement) => {
    const row = target.closest<HTMLElement>("[data-key]");
    const item = row?.dataset.key ? itemByKey.get(row.dataset.key) : undefined;
    const on =
      row && item
        ? selected.has(markKey(item)) && selected.size > 1
          ? "selection"
          : item
        : "space";
    setContextMenu({ at: { current: row ?? list }, target: on });
  };

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
    } else if (event.key === "x" && current && plain) {
      const item = itemByKey.get(current);
      if (item) select(item, event.shiftKey);
    } else if (event.key === "a" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      setSelected(new Set(order));
    } else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      menuFromKeys(target, event.currentTarget);
    } else if (event.key === "F2" && current && manage) {
      event.preventDefault();
      const item = itemByKey.get(current);
      if (item) startRename(item);
    } else if (event.key === "x" && (event.metaKey || event.ctrlKey) && manage) {
      event.preventDefault();
      cutRows(current && !selected.has(current) ? [current] : [...selected]);
    } else if (event.key === "v" && (event.metaKey || event.ctrlKey) && manage && cut.size > 0) {
      event.preventDefault();
      paste(folderId);
    } else if (event.key === "Escape" && (selected.size > 0 || cut.size > 0)) {
      clearSelection();
      setCut(new Set());
    }
  };

  /**
   * Run one change per thing; say how many could not be made, and keep those selected. Done,
   * the selection is let go, unless the work is one of several changes to it (tags added one
   * after another).
   */
  const runAll = async (work: [Item, () => Promise<unknown>][], keep = false) => {
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
    if (!keep) clearSelection();
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
  /** Move things into a folder (null, the top), leaving out what is there already or would loop. */
  const moveAll = (items: Item[], to: string | null) => {
    const work = movesInto(all, items, to).map((i): [Item, () => Promise<unknown>] => [
      i,
      () => moveOne(i, to),
    ]);
    if (work.length) void runAll(work);
  };
  /** Loose files dropped on a track go in as its next version, one variation each. */
  const attachAll = (dropped: ProjectFile[], track: Track) =>
    trackMutations.createVersion.mutate({
      trackId: track.id,
      variations: dropped.map((f, i) => ({
        fileId: f.id,
        name: variationNameFor(f.name, track.name),
        primary: i === 0,
      })),
    });
  /** Anything in the project by its key, wherever it is: what was cut may be in another folder. */
  const anyByKey = (key: string): Item | undefined => {
    const [kind, id] = key.split(":");
    if (kind === "folder") {
      const folder = all.find((f) => f.id === id);
      return folder && { kind, id: folder.id, folder };
    }
    if (kind === "track") {
      const track = allTracks.find((t) => t.id === id);
      return track && { kind, id: track.id, track };
    }
    if (kind === "file") {
      const file = allFiles.find((f) => f.id === id);
      return file && { kind, id: file.id, file };
    }
    return undefined;
  };
  /** Cut rows wait, drawn faded, until they are pasted into a folder; a new cut replaces them. */
  const cutRows = (keys: string[]) => setCut(new Set(keys));
  const paste = (to: string | null) => {
    moveAll(
      [...cut].flatMap((k) => anyByKey(k) ?? []),
      to,
    );
    setCut(new Set());
  };

  /** Dragging rows onto a folder, a track or the path moves them; only for those who organise. */
  const dragStart = (item: Item, event: DragEvent<HTMLElement>) => {
    const key = markKey(item);
    const keys = selected.has(key) ? [...selected] : [key];
    dragged.current = keys;
    event.dataTransfer.setData(dragType, JSON.stringify(keys));
    event.dataTransfer.effectAllowed = "move";
  };
  const draggedItems = () => dragged.current.flatMap((k) => itemByKey.get(k) ?? []);
  /**
   * A folder (null, the top of the project) takes anything; a track takes loose files, as its
   * next version. Escape while dragging cancels, as the browser has it: nothing is dropped and
   * the target is let go.
   */
  const dropTarget = (target: { folder: string | null } | { track: Track }) => {
    const track = "track" in target ? target.track : null;
    const may = track ? can("upload") : manage;
    if (!may) return {};
    const accepts = () => (track ? droppableOnTrack(draggedItems()) !== null : true);
    const mark = track
      ? `track:${track.id}`
      : "folder" in target
        ? (target.folder ?? "top")
        : "top";
    return {
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!Array.from(event.dataTransfer.types).includes(dragType) || !accepts()) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropOn(mark);
      },
      onDragLeave: () => setDropOn(null),
      onDrop: (event: DragEvent<HTMLElement>) => {
        const data = event.dataTransfer.getData(dragType);
        if (!data) return;
        event.preventDefault();
        setDropOn(null);
        const keys = JSON.parse(data) as string[];
        const items = keys.flatMap((k) => itemByKey.get(k) ?? []);
        if (track) {
          const files = droppableOnTrack(items);
          if (files) attachAll(files, track);
        } else moveAll(items, "folder" in target ? target.folder : null);
      },
    };
  };

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
  /** The field closes as the name is kept; a refusal (a slash, a name taken) shows above the list. */
  const rename = (item: Item, name: string) => {
    setEditing(null);
    if (item.kind === "folder") organise.updateFolder.mutate({ id: item.folder.id, name });
    else if (item.kind === "track") trackMutations.updateTrack.mutate({ id: item.track.id, name });
    else if (item.kind === "file") organise.updateFile.mutate({ id: item.file.id, name });
  };
  const startRename = (item: Item) => {
    if (item.kind !== "version") setEditing({ id: item.id, mode: "rename" });
  };
  /** The tag editor floats from the row's tag cell, or its name where the list has no Tags column. */
  const openTags = (item: Item) => {
    if (item.kind !== "file") return;
    const row = document.querySelector(`[data-key="${CSS.escape(markKey(item))}"]`);
    const at =
      row?.querySelector<HTMLElement>("[data-tags]") ??
      row?.querySelector<HTMLElement>("[data-name]");
    setEditing({ id: item.id, mode: "tags", ...(at ? { at: { current: at } } : {}) });
  };
  /** A file's tags, kept as each is added or taken off. */
  const setTags = (file: ProjectFile, tagIds: string[]) =>
    tagging.setOnFile.mutate({ fileId: file.id, tagIds });
  /** Opens what a row's name opens: a folder here, a track or a file on its page. */
  const go = (item: Item) => {
    if (item.kind === "folder") onOpenFolder(item.folder.id);
    else if (item.kind === "file")
      void navigate({ to: "/files/$fileId", params: { fileId: item.file.id } });
    else if (item.kind === "track") {
      const file = latestFile(item.track);
      if (file) void navigate({ to: "/files/$fileId", params: { fileId: file } });
      else void navigate({ to: "/tracks/$trackId", params: { trackId: item.track.id } });
    }
  };
  /**
   * A click on the name of a row that is selected renames it, unless a second click follows
   * within the double-click interval, which opens it, as the Finder has it. A plain click on
   * an unselected row opens as a link does.
   */
  const slowClickOn = (item: Item) => (event: MouseEvent<HTMLElement>) => {
    const key = markKey(item);
    // A click the keyboard made (Enter on the name) opens, as a link does; only a pointer's renames.
    if (!manage || !selected.has(key) || event.button !== 0 || event.detail === 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (slowClick.current) {
      clearTimeout(slowClick.current);
      slowClick.current = null;
      go(item);
      return;
    }
    slowClick.current = setTimeout(() => {
      slowClick.current = null;
      startRename(item);
    }, SLOW_CLICK_MS);
  };
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

  /**
   * Everything that can be done to one item, in one list: the row's "…" menu and the context
   * menu on the row both show it, so neither falls behind the other.
   */
  const actionsFor = (item: Item): (MenuAction | "divider")[] | null => {
    if (item.kind === "version") return null;
    const key = markKey(item);
    const self = [{ kind: item.kind, id: item.id }];
    const seen = seenFile(item);
    const personal: (MenuAction | "divider")[] = [
      {
        label: marks.favourite.has(key) ? "Remove from favourites" : "Add to favourites",
        onSelect: () => favour(self, !marks.favourite.has(key)),
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
          { label: "Rename", hint: "F2", onSelect: () => startRename(item) },
          { label: "Move to…", onSelect: () => setMoving([item]) },
          { label: "Cut", hint: mod("X"), onSelect: () => cutRows([key]) },
          ...(item.kind === "folder" && cut.size > 0 && !cut.has(key)
            ? [{ label: "Paste here", hint: mod("V"), onSelect: () => paste(item.folder.id) }]
            : []),
          // The score beside its recordings, as its versions page links one (#52).
          ...(item.kind === "track" && !video
            ? [
                {
                  label: "Link a score…",
                  onSelect: () => setEditing({ id: item.id, mode: "score" }),
                },
              ]
            : []),
          ...(item.kind === "file" ? [{ label: "Tags…", onSelect: () => openTags(item) }] : []),
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
    return [...personal, ...about, ...recovering, ...organising];
  };
  const menu = (item: Item, always = false) => {
    const actions = actionsFor(item);
    return actions ? (
      <ActionMenu label={itemName(item, versionLabel)} actions={actions} always={always} />
    ) : null;
  };

  /**
   * What can be done to everything selected, in one list for the selection bar and the
   * context menu on a selected row: personal marks for everyone; moving, tagging, cutting and
   * deleting for those who may. Each change is checked on the server, one thing at a time.
   */
  const chosenKeys = chosen.map(markKey);
  const chosenFiles = chosen.flatMap((i) => (i.kind === "file" ? [i.file] : []));
  const selectionActions: (MenuAction | "divider")[] = [
    {
      label: allHave(chosenKeys, marks.favourite) ? "Unfavourite" : "Favourite",
      onSelect: () =>
        favour(
          chosen.map((i) => ({ kind: i.kind as MarkKind, id: i.id })),
          !allHave(chosenKeys, marks.favourite),
        ),
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
            onSelect: () => {
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
    ...(manage
      ? [
          "divider" as const,
          { label: "Move to…", onSelect: () => setMoving(chosen) },
          ...(chosenFiles.length > 0 ? [{ label: "Tags…", onSelect: () => setBulk("tags") }] : []),
          { label: "Cut", hint: mod("X"), onSelect: () => cutRows(chosenKeys) },
        ]
      : []),
    ...(mayDelete &&
    chosen.length > 0 &&
    chosen.every((i) => i.kind === "folder" || i.kind === "file")
      ? ["divider" as const, { label: "Delete…", danger: true, onSelect: () => setBulk("delete") }]
      : []),
  ];
  /** Deleting everything selected, once confirmed in the bar. */
  const removeChosen = () =>
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
    );

  /** What the empty space offers: making and uploading here, pasting what was cut, selecting. */
  const spaceActions: (MenuAction | "divider")[] = [
    ...(manage
      ? [
          { label: "New folder", onSelect: () => setNaming("folder") },
          ...(withTracks
            ? [{ label: `New ${words.track}`, onSelect: () => setNaming("track") }]
            : []),
        ]
      : []),
    ...(uploads ? [{ label: "Upload…", onSelect: () => chooser.current?.click() }] : []),
    ...(manage && cut.size > 0
      ? ["divider" as const, { label: "Paste", hint: mod("V"), onSelect: () => paste(folderId) }]
      : []),
    ...(items.length > 0
      ? [
          "divider" as const,
          { label: "Select all", hint: mod("A"), onSelect: () => setSelected(new Set(order)) },
        ]
      : []),
  ];
  /** The context menu's list: the row's, the selection's or the space's. */
  const menuActions = (open: OpenMenu) =>
    open.target === "selection"
      ? selectionActions
      : open.target === "space"
        ? spaceActions
        : (actionsFor(open.target) ?? []);
  const menuLabel = (open: OpenMenu) =>
    open.target === "selection"
      ? `Actions for the ${chosen.length} selected`
      : open.target === "space"
        ? "Actions for this folder"
        : `Actions for ${itemName(open.target, versionLabel)}`;
  /** A right click (or a long press) on a row: its menu, or the selection's when it is in one. */
  const rowMenu = (item: Item) => (event: MouseEvent<HTMLElement>) => {
    if (item.kind === "version") return;
    event.preventDefault();
    event.stopPropagation();
    const key = markKey(item);
    setContextMenu({
      at: { x: event.clientX, y: event.clientY },
      target: selected.has(key) && selected.size > 1 ? "selection" : item,
    });
  };
  /** A right click on the space around the rows; fields and open menus keep the browser's own. */
  const spaceMenu = (event: MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    const own =
      "[data-key], button, a[href], input, textarea, [role=menu], [role=dialog], [role=listbox]";
    if (target.closest(own)) return;
    event.preventDefault();
    setContextMenu({ at: { x: event.clientX, y: event.clientY }, target: "space" });
  };

  /** A file's tags, edited in place: in a row's popover, a card, or the column view's preview. */
  const tagEditor = (file: ProjectFile) => (
    <TagInput
      tags={tags}
      value={file.tagIds ?? []}
      label={`Tags on ${file.name}`}
      autoFocus
      onChange={(tagIds) => setTags(file, tagIds)}
      onCreate={(name) => tagging.create.mutateAsync(name)}
      onDone={() => setEditing(null)}
    />
  );
  /** The open editor for an item, in place of its name (a rename) or under it. */
  const editor = (item: Item) => {
    if (!editing || editing.id !== item.id) return null;
    if (editing.mode === "rename") {
      return (
        <RenameInput
          initial={itemName(item, versionLabel)}
          file={item.kind === "file"}
          label={`Rename ${itemName(item, versionLabel)}`}
          onSave={(name) => rename(item, name)}
          onCancel={() => setEditing(null)}
          className="my-2.5 max-w-96"
        />
      );
    }
    if (editing.mode === "tags") return item.kind === "file" ? tagEditor(item.file) : null;
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
    const slow = slowClickOn(item);
    if (item.kind === "folder")
      return (
        <button
          type="button"
          data-name
          onClick={(event) => {
            slow(event);
            if (!event.defaultPrevented) onOpenFolder(item.folder.id);
          }}
          className={pad}
        >
          {inner}
        </button>
      );
    if (item.kind === "track") {
      const file = latestFile(item.track);
      return file ? (
        <Link
          to="/files/$fileId"
          params={{ fileId: file }}
          className={pad}
          data-name
          onClick={slow}
        >
          {inner}
        </Link>
      ) : (
        <Link
          to="/tracks/$trackId"
          params={{ trackId: item.track.id }}
          className={pad}
          data-name
          onClick={slow}
        >
          {inner}
        </Link>
      );
    }
    if (item.kind === "file")
      return (
        <Link
          to="/files/$fileId"
          params={{ fileId: item.file.id }}
          className={pad}
          data-name
          onClick={slow}
        >
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
        case "versions": {
          // Among tracks the column counts versions, which a loose file has only in a chain
          // (#149); without tracks it holds the file's details.
          if (!withTracks)
            return (
              <span className="tabular truncate">
                {fileSummary(f)} · {formatBytes(f.byteSize)}
              </span>
            );
          const place = chains.get(f.id);
          return place ? (
            <span className="tabular truncate">{`V${place.number} of ${place.count}`}</span>
          ) : (
            "—"
          );
        }
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
    if (id === "tags") {
      const pills = <TagPills ids={f.tagIds ?? []} tags={tagById} />;
      if (!manage) return pills;
      const names = (f.tagIds ?? []).flatMap((id) => tagById.get(id)?.name ?? []);
      return (
        <button
          type="button"
          data-tags
          aria-label={names.length ? `Tags: ${names.join(", ")}. Edit` : "Add a tag"}
          onClick={(event) =>
            setEditing({ id: f.id, mode: "tags", at: { current: event.currentTarget } })
          }
          className="-mx-1.5 flex h-7 min-w-0 max-w-full items-center rounded-control px-1.5 text-left transition-colors hover:bg-raised"
        >
          {names.length ? (
            pills
          ) : (
            <span className="text-[12px] text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              Add a tag
            </span>
          )}
        </button>
      );
    }
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

  /** Whether a row is the target of the drag over it. */
  const droppedOn = (item: Item) =>
    (item.kind === "folder" && dropOn === item.folder.id) ||
    (item.kind === "track" && dropOn === `track:${item.track.id}`);
  /** The drop handlers a row takes: a folder's, a track's, or none. */
  const rowDrop = (item: Item) =>
    item.kind === "folder"
      ? dropTarget({ folder: item.folder.id })
      : item.kind === "track"
        ? dropTarget({ track: item.track })
        : {};
  /** A row's tags floating over it, from the cell or the name the editor was opened on. */
  const tagPopover = (item: Item) =>
    editing?.id === item.id && editing.mode === "tags" && editing.at && item.kind === "file" ? (
      <TagPopover
        anchor={editing.at}
        label={`Tags on ${item.file.name}`}
        onClose={() => setEditing(null)}
      >
        {tagEditor(item.file)}
      </TagPopover>
    ) : null;

  const row = (item: Item, place?: Place) => {
    const key = markKey(item);
    const open = editing?.id === item.id;
    const renaming = open && editing?.mode === "rename";
    const floated = open && editing?.mode === "tags" && Boolean(editing?.at);
    const cells = (
      <>
        <Pick
          item={item}
          checked={selected.has(key)}
          showing={selecting}
          onPick={(range) => select(item, range)}
        />
        {renaming ? editor(item) : nameOf(item, subOf(item))}
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
        data-key={key}
        draggable={manage && !open}
        onDragStart={(event) => dragStart(item, event)}
        onDragEnd={() => setDropOn(null)}
        onContextMenu={rowMenu(item)}
        {...rowDrop(item)}
        className={cn(
          "group border-b border-line last:border-b-0 hover:bg-raised/40",
          selected.has(key) && "bg-raised/60",
          droppedOn(item) && "bg-raised shadow-[inset_0_0_0_1px_var(--hk-edge)]",
        )}
      >
        <div className={cn(rowGrid, cut.has(key) && "opacity-50")} style={gridVars}>
          {cells}
          {/* A cell of their own, so the quick actions never run into the column before them. */}
          <span className="hidden items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 @3xl/app:flex">
            {quick}
          </span>
          <span className="flex items-center justify-end">{(!open || floated) && menu(item)}</span>
        </div>
        {open && !renaming && !floated && <div className="px-3 pb-3 pl-11">{editor(item)}</div>}
        {tagPopover(item)}
      </li>
    );
  };

  const loadError = error ?? foldersError ?? tracksError;
  if (loadError) return <p className="m-0 text-signal">{loadError.message}</p>;

  const openItem = (item: Item): Item[] | null =>
    item.kind === "folder"
      ? favouritesFirst(itemsIn(all, allTracks, allFiles, item.folder.id), marks)
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
              {...dropTarget({ folder: null })}
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
                  {...dropTarget({ folder: f.id })}
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
              { label: "Select all", hint: mod("A"), onSelect: () => setSelected(new Set(order)) },
            ]}
          />
          <UploadButton />
          {uploads && (
            <FileInput
              ref={chooser}
              multiple
              aria-label="Files to upload here"
              onChange={(event) => {
                if (event.target.files) uploads.start(event.target.files);
                event.target.value = "";
              }}
            />
          )}
        </div>
      </div>

      {contextMenu && (
        <ContextMenu
          at={contextMenu.at}
          actions={menuActions(contextMenu)}
          label={menuLabel(contextMenu)}
          onClose={() => setContextMenu(null)}
        />
      )}
      {moving && (
        <MovePicker
          title={
            moving.length === 1 && moving[0]
              ? `Move ${itemName(moving[0], versionLabel)}`
              : `Move ${moving.length} items`
          }
          folders={all}
          exclude={
            new Set(
              all
                .filter((f) => !movableTo(all, moving).some((m) => m.id === f.id))
                .map((f) => f.id),
            )
          }
          current={
            moving.every((i) => parentIdOf(i) === parentIdOf(moving[0] as Item))
              ? parentIdOf(moving[0] as Item)
              : undefined
          }
          pending={bulkBusy || pending}
          onMove={(to) => {
            setMoving(null);
            moveAll(moving, to);
          }}
          onClose={() => setMoving(null)}
        />
      )}

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

      {/* biome-ignore lint/a11y/noStaticElementInteractions: a right click on the space around the rows; the keyboard opens the same menu from the list. */}
      <div onContextMenu={spaceMenu} className="flex flex-col gap-4">
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
        ) : items.length === 0 && (view !== "columns" || rootItems.length === 0) ? (
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
            root={rootItems}
            path={[...folderItems, ...columnPath]}
            onPath={chooseInColumns}
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
              <span />
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
                  onContextMenu={rowMenu(item)}
                  {...rowDrop(item)}
                  className={cn(
                    "group relative flex min-w-0 flex-col gap-2.5 rounded-panel-lg border border-line bg-raised/30 p-3 shadow-1 transition-colors hover:border-edge",
                    open &&
                      editing?.mode !== "rename" &&
                      "col-span-2 @3xl/app:col-span-4 @6xl/app:col-span-5",
                    (selected.has(markKey(item)) || droppedOn(item)) &&
                      "border-edge-strong bg-raised/60",
                    cut.has(markKey(item)) && "opacity-50",
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
      </div>
      {(chosen.length > 0 || bulkError) && (
        <SelectionBar
          count={chosen.length}
          busy={bulkBusy}
          error={bulkError}
          mode={bulk}
          onMode={setBulk}
          onClear={clearSelection}
          actions={selectionActions}
          tags={
            manage && chosenFiles.length > 0 ? (
              <BulkTags
                files={chosenFiles}
                tags={tags}
                onCreate={(name) => tagging.create.mutateAsync(name)}
                onChange={(common, next) =>
                  void runAll(
                    chosenFiles.map((f): [Item, () => Promise<unknown>] => [
                      { kind: "file", id: f.id, file: f },
                      () =>
                        tagging.setOnFile.mutateAsync({
                          fileId: f.id,
                          tagIds: bulkTags(f.tagIds ?? [], common, next),
                        }),
                    ]),
                    true,
                  )
                }
                onDone={() => setBulk(null)}
              />
            ) : null
          }
          remove={removeChosen}
        />
      )}
    </section>
  );
}

/**
 * Tags for many files at once, kept as each is added or taken off: those on every one are
 * pills, those on some of them dashed pills that a click puts on all.
 */
function BulkTags({
  files,
  tags,
  onCreate,
  onChange,
  onDone,
}: {
  files: ProjectFile[];
  tags: Tag[];
  onCreate: (name: string) => Promise<Tag>;
  /** The tags on every file before, and what they should be now. */
  onChange: (common: string[], next: string[]) => void;
  onDone: () => void;
}) {
  const ids = tags.map((t) => t.id);
  const common = ids.filter((id) => files.every((f) => f.tagIds?.includes(id)));
  const some = ids.filter(
    (id) => !common.includes(id) && files.some((f) => f.tagIds?.includes(id)),
  );
  return (
    <TagInput
      tags={tags}
      value={common}
      mixed={some}
      label={`Tags on ${files.length} ${files.length === 1 ? "file" : "files"}`}
      autoFocus
      onCreate={onCreate}
      onChange={(next) => onChange(common, next)}
      onDone={onDone}
    />
  );
}

/**
 * What can be done to everything selected, floating at the foot of the list as Linear and
 * Dropbox have it: the same actions the context menu on a selected row offers, each a button.
 * Tagging and deleting open in the bar; moving opens the folder picker.
 */
function SelectionBar({
  count,
  busy,
  error,
  mode,
  onMode,
  onClear,
  actions,
  tags,
  remove,
}: {
  count: number;
  busy: boolean;
  error: string | null;
  mode: "tags" | "delete" | null;
  onMode: (mode: "tags" | "delete" | null) => void;
  onClear: () => void;
  actions: (MenuAction | "divider")[];
  tags: ReactNode;
  remove: () => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Selection"
      className="rise-in sticky bottom-4 z-20 mx-auto flex w-full max-w-3xl flex-col gap-2 rounded-panel-lg bg-overlay p-2 shadow-4"
    >
      {mode === "tags" && tags && <div className="px-1.5 pt-1">{tags}</div>}
      {mode === "delete" && (
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
        {actions.map((a) =>
          a === "divider" ? null : (
            <Button
              key={a.label}
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={a.onSelect}
              className={cn(a.danger && "text-signal hover:text-signal")}
            >
              {a.label}
            </Button>
          ),
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
            <Link
              to="/tracks/$trackId"
              params={{ trackId: item.track.id }}
              search={{ view: "versions" }}
            >
              Versions
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}

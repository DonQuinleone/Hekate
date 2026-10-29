import { Link, useNavigate } from "@tanstack/react-router";
import {
  createContext,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useContext,
  useState,
} from "react";
import { Avatar, AvatarRow } from "~/components/avatar";
import { Icon, type IconName } from "~/components/icons";
import { Label } from "~/components/label";
import { Card } from "~/components/page";
import { Dot } from "~/components/status";
import { Thumb } from "~/components/thumb";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Floating, type Point } from "~/components/ui/floating";
import { Input, Select, Textarea } from "~/components/ui/input";
import { ActionMenu, ContextMenu, type MenuAction, usePopover } from "~/components/ui/menu";
import {
  files as allFiles,
  tracks as allTracks,
  type File,
  type Folder,
  folders,
  latestVersion,
  type Project,
  personById,
  primaryFile,
  sessions,
  type Track,
  takes,
  type Version,
} from "~/data";
import { cn } from "~/lib/cn";
import {
  chainLabel,
  chainOf,
  fileDetails,
  folderPath,
  kindIcon,
  looseFiles,
  openCommentCount,
  tracksIn,
} from "~/lib/files";
import { ago, formatBytes, formatDateTime, plural } from "~/lib/format";
import { trackState } from "~/lib/tracks";
import { useViewer } from "~/viewer/context";
import { Empty, useScreenState } from "~/viewer/state-gate";

export type Item =
  | { kind: "folder"; id: string; folder: Folder }
  | { kind: "track"; id: string; track: Track }
  | { kind: "file"; id: string; file: File }
  | { kind: "version"; id: string; track: Track; version: Version };

export function itemsIn(project: Project, folderId: string | null): Item[] {
  return [
    ...folders
      .filter((f) => f.projectId === project.id && f.parentId === folderId)
      .map((folder): Item => ({ kind: "folder", id: folder.id, folder })),
    ...tracksIn(project.id, folderId).map(
      (track): Item => ({ kind: "track", id: track.id, track }),
    ),
    ...looseFiles(
      allFiles.filter((f) => f.projectId === project.id && f.folderId === folderId),
    ).map((file): Item => ({ kind: "file", id: file.id, file })),
  ];
}

const folderCount = (projectId: string, folderId: string) =>
  folderId === "f-sessions"
    ? `${sessions.filter((s) => s.projectId === projectId).length} sessions · 26 takes`
    : plural(
        folders.filter((x) => x.parentId === folderId).length +
          allFiles.filter((x) => x.folderId === folderId).length,
        "item",
      );

/** A small round button that appears when its row is hovered. */
function Quick({
  icon,
  label,
  onClick,
  to,
  params,
  search,
}: {
  icon: IconName;
  label: string;
  onClick?: () => void;
  to?: string;
  params?: Record<string, string>;
  search?: Record<string, string>;
}) {
  const cls =
    "flex size-7 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-raised hover:text-ink";
  return to ? (
    <Link to={to} params={params} search={search} aria-label={label} title={label} className={cls}>
      <Icon name={icon} size={14} />
    </Link>
  ) : (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={cls}>
      <Icon name={icon} size={14} />
    </button>
  );
}

/* ---------- Selection (#114) ---------- */

/** What is selected in the list, shared by its rows. */
const Picked = createContext<{
  has: (id: string) => boolean;
  toggle: (id: string) => void;
  any: boolean;
  count: number;
} | null>(null);

/* ---------- Organising in place (#487) ---------- */

/** Where a context menu opened, and what it offers. */
interface OpenMenu {
  at: Point | RefObject<HTMLElement | null>;
  actions: (MenuAction | "divider")[];
  label: string;
}

/**
 * What the browser is doing to its rows, shared by them: the context menu (a right click, a
 * long press, the Menu key or Shift+F10), a name being edited in its row, the row a drag is
 * over, rows cut and waiting to be pasted, and the folder picker. One list of actions serves
 * a row's "…" menu and its context menu.
 */
const Browser = createContext<{
  organise: boolean;
  menu: (at: OpenMenu["at"], actions: (MenuAction | "divider")[], label: string) => void;
  selection: (MenuAction | "divider")[];
  renaming: string | null;
  rename: (id: string | null) => void;
  dropOn: string | null;
  setDropOn: (id: string | null) => void;
  cut: Set<string>;
  setCut: (ids: Set<string>) => void;
  move: (title: string) => void;
} | null>(null);

const dragType = "application/x-hekate-items";

/**
 * What every row does for the browser: it is dragged (and a folder or a track takes the
 * drop, lit while it is over), it opens its menu on a right click or from the keyboard, F2
 * renames it, and cut it fades until it is pasted.
 */
function useRow(
  id: string,
  label: string,
  actions: (MenuAction | "divider")[],
  takesDrops: boolean,
) {
  const b = useContext(Browser);
  const picked = useContext(Picked);
  const onSelection = (picked?.has(id) ?? false) && (picked?.count ?? 0) > 1;
  const open = (at: OpenMenu["at"]) =>
    onSelection && b
      ? b.menu(at, b.selection, "Actions for the selection")
      : b?.menu(at, actions, `Actions for ${label}`);
  const target = b?.organise && takesDrops;
  return {
    props: {
      "data-row": id,
      draggable: b?.organise && b.renaming !== id,
      onDragStart: (event: DragEvent<HTMLElement>) => {
        event.dataTransfer.setData(dragType, JSON.stringify([id]));
        event.dataTransfer.effectAllowed = "move";
      },
      onDragEnd: () => b?.setDropOn(null),
      ...(target
        ? {
            onDragOver: (event: DragEvent<HTMLElement>) => {
              if (!Array.from(event.dataTransfer.types).includes(dragType)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              b?.setDropOn(id);
            },
            onDragLeave: () => b?.setDropOn(null),
            onDrop: (event: DragEvent<HTMLElement>) => {
              event.preventDefault();
              b?.setDropOn(null);
            },
          }
        : {}),
      onContextMenu: (event: MouseEvent<HTMLElement>) => {
        event.preventDefault();
        event.stopPropagation();
        open({ x: event.clientX, y: event.clientY });
      },
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if ((event.target as HTMLElement).closest("input")) return;
        if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
          event.preventDefault();
          open({ current: event.currentTarget });
        } else if (event.key === "F2" && b?.organise) {
          event.preventDefault();
          b.rename(id);
        } else if (event.key === "x" && (event.metaKey || event.ctrlKey) && b?.organise) {
          event.preventDefault();
          b.setCut(new Set([id]));
        }
      },
    },
    className: cn(
      b?.dropOn === id && "bg-raised shadow-[inset_0_0_0_1px_var(--hk-edge)]",
      b?.cut.has(id) && "opacity-50",
    ),
    renaming: b?.renaming === id,
    rename: () => b?.rename(id),
    done: () => b?.rename(null),
    move: () => b?.move(`Move ${label}`),
    cut: () => b?.setCut(new Set([id])),
  };
}

/**
 * A name edited in its row: the field takes the name's place with the name selected (a
 * file's without its extension); Enter keeps it, Escape keeps the old one, leaving keeps it.
 */
function RenameInput({
  initial,
  file,
  onDone,
}: {
  initial: string;
  file: boolean;
  onDone: () => void;
}) {
  const [name, setName] = useState(initial);
  const dot = file ? initial.lastIndexOf(".") : -1;
  return (
    <Input
      autoFocus
      aria-label={`Rename ${initial}`}
      value={name}
      spellCheck={false}
      onFocus={(e) => e.currentTarget.setSelectionRange(0, dot > 0 ? dot : initial.length)}
      onChange={(e) => setName(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onDone();
        }
      }}
      onBlur={onDone}
      className="my-2.5 h-7 max-w-96 min-w-0 px-1.5 text-[14px]"
    />
  );
}

/**
 * Where something goes, chosen from the project's folders as a tree, for whoever would rather
 * not drag: the top first, then every folder under its parent; where it is now is marked.
 */
function MovePicker({
  title,
  project,
  current,
  onClose,
}: {
  title: string;
  project: Project;
  current: string | null;
  onClose: () => void;
}) {
  const [to, setTo] = useState<string | null>(current);
  const rows: { id: string | null; name: string; depth: number }[] = [
    { id: null, name: "Top of the project", depth: 0 },
  ];
  const walk = (parentId: string | null, depth: number) => {
    for (const f of folders.filter((x) => x.projectId === project.id && x.parentId === parentId)) {
      rows.push({ id: f.id, name: f.name, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 1);
  return (
    <Dialog
      title={title}
      description="Choose the folder it goes to."
      width="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={to === current} onClick={onClose}>
            Move
          </Button>
        </>
      }
    >
      <div role="tree" aria-label="Move to" className="-mx-2 flex flex-col">
        {rows.map((row) => {
          const chosen = row.id === to;
          const here = row.id === current;
          return (
            <button
              key={row.id ?? "top"}
              type="button"
              role="treeitem"
              aria-selected={chosen}
              aria-level={row.depth + 1}
              tabIndex={chosen ? 0 : -1}
              onClick={() => setTo(row.id)}
              style={{ paddingLeft: 8 + row.depth * 18 }}
              className={cn(
                "flex h-8 w-full items-center gap-2 rounded-control pr-2 text-left text-[13px] transition-colors",
                chosen ? "bg-raised text-ink" : "text-ink-2 hover:bg-raised/50 hover:text-ink",
              )}
            >
              <Icon
                name={row.id === null ? "home" : "folder"}
                size={14}
                className="shrink-0 text-ink-3"
              />
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
              {here && <span className="shrink-0 text-[11px] text-ink-3">Current</span>}
              {chosen && !here && <Icon name="check" size={13} className="shrink-0 text-ink-2" />}
            </button>
          );
        })}
      </div>
    </Dialog>
  );
}

/**
 * A row's icon, which becomes its checkbox on hover or focus, and stays one while anything is
 * selected. Shift-click selects a range; in the real list x selects the focused row, arrows
 * move, Shift with an arrow extends, Cmd or Ctrl and A selects everything, Escape lets go.
 */
function RowPick({ id, icon, className }: { id: string; icon: IconName; className: string }) {
  const picked = useContext(Picked);
  const showing = picked?.any ?? false;
  return (
    <span className="relative flex size-5 items-center justify-center">
      <Icon
        name={icon}
        className={cn(className, showing ? "invisible" : "@3xl/app:group-hover:invisible")}
      />
      <input
        type="checkbox"
        aria-label="Select"
        checked={picked?.has(id) ?? false}
        onChange={() => picked?.toggle(id)}
        className={cn(
          "absolute inset-0 m-auto size-3.5 cursor-pointer accent-[var(--hk-ink)]",
          showing ? "opacity-100" : "opacity-0 focus:opacity-100 @3xl/app:group-hover:opacity-100",
        )}
      />
    </span>
  );
}

/**
 * What can be done to everything selected, floating at the foot of the list (Linear,
 * Dropbox): the same actions the context menu on a selected row offers, each a button. Rows
 * also drag onto a folder, a track or the path to move, and cut and paste.
 */
function SelectionBar({
  count,
  actions,
  onClear,
}: {
  count: number;
  actions: (MenuAction | "divider")[];
  onClear: () => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Selection"
      className="rise-in sticky bottom-4 z-20 mx-auto mt-4 flex w-full max-w-3xl flex-wrap items-center gap-1 rounded-panel-lg bg-overlay p-2 shadow-4"
    >
      <span className="tabular px-2 text-[13px] text-ink">{count} selected</span>
      {actions.map((a) =>
        a === "divider" ? null : (
          <Button
            key={a.label}
            size="sm"
            variant="ghost"
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
        onClick={onClear}
        className="ml-auto flex size-7 items-center justify-center rounded-control text-ink-3 hover:bg-raised hover:text-ink"
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

const columnChoices = [
  "Status",
  "Versions",
  "People",
  "Updated",
  "Size",
  "Format",
  "Duration",
  "Tags",
];

/**
 * The list's columns, chosen and ordered per person and kept for them; a header's edge drags
 * for its width.
 */
function ColumnsChooser() {
  const [open, setOpen, box] = usePopover();
  const [on, setOn] = useState(columnChoices.slice(0, 4));
  return (
    <div ref={box} className="relative flex justify-end">
      <button
        type="button"
        aria-label="Choose columns"
        onClick={() => setOpen(!open)}
        className="flex size-7 items-center justify-center rounded-control text-ink-3 hover:bg-raised hover:text-ink"
      >
        <Icon name="sliders" size={14} />
      </button>
      {open && (
        <Floating
          anchor={box}
          align="end"
          side="bottom"
          onClose={() => setOpen(false)}
          className="rise-in w-56 rounded-panel-lg bg-overlay p-2 shadow-4"
        >
          <Label>Columns, in order</Label>
          {columnChoices.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={on.includes(c)}
              onClick={() => setOn(on.includes(c) ? on.filter((x) => x !== c) : [...on, c])}
              className="flex h-8 w-full items-center gap-2 rounded-control px-2 text-left text-[13px] text-ink hover:bg-raised"
            >
              <span className="flex-1">{c}</span>
              {on.includes(c) && <Icon name="check" size={13} />}
            </button>
          ))}
        </Floating>
      )}
    </div>
  );
}

/** On a phone: icon, name, menu. Wider, the columns, then a cell for the quick actions and one for the menu. */
const rowGrid =
  "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 @3xl/app:grid-cols-[20px_minmax(0,1fr)_150px_160px_110px_90px_120px_28px]";

/** The quick actions' cell: shown on hover or focus, and never running into the column before. */
const quickCell =
  "hidden items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 @3xl/app:flex";

function TrackRow({ track, project }: { track: Track; project: Project }) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const s = trackState(track, project);
  const file = s.version ? primaryFile(s.version) : undefined;
  const comments = s.version
    ? s.version.variations.reduce((n, x) => n + openCommentCount(x.fileId), 0)
    : 0;
  const canRequest = viewer.can(project.id, "request_reviews");
  const canUpload = viewer.can(project.id, "upload");
  const quick: ReactNode[] = [];
  if (file)
    quick.push(
      <Quick
        key="play"
        icon="play"
        label="Open in the player"
        to="/files/$fileId"
        params={{ fileId: file.id }}
      />,
    );
  quick.push(
    <Quick
      key="versions"
      icon="list"
      label="Versions and notes"
      to="/tracks/$trackId"
      params={{ trackId: track.id }}
      search={{ view: "versions" }}
    />,
  );
  if (
    takes.some((t) => t.trackId === track.id && t.coverage) &&
    viewer.tools(project.id).has("takes")
  )
    quick.push(
      <Quick
        key="takes"
        icon="take"
        label="Takes"
        to="/tracks/$trackId"
        params={{ trackId: track.id }}
        search={{ view: "takes" }}
      />,
    );
  if (!s.version && canUpload)
    quick.push(
      <Quick
        key="add"
        icon="upload"
        label="Add the first version"
        to="/tracks/$trackId"
        params={{ trackId: track.id }}
        search={{ view: "versions" }}
      />,
    );
  else if (s.version?.state === "failed" && canUpload)
    quick.push(<Quick key="replace" icon="refresh" label="Replace the file" onClick={() => {}} />);
  else if (s.version?.status === "Approved" && viewer.tools(project.id).has("download"))
    quick.push(<Quick key="deliver" icon="download" label="Deliver" onClick={() => {}} />);
  else if (file && canRequest && !s.review)
    quick.push(
      <Quick
        key="review"
        icon="review"
        label="Request a review"
        onClick={() =>
          navigate({ to: "/reviews/new", search: { project: project.id, item: track.id } })
        }
      />,
    );
  const organising: (MenuAction | "divider")[] = [
    ...(file
      ? [
          {
            label: "Compare versions",
            onSelect: () =>
              navigate({ to: "/tracks/$trackId/compare", params: { trackId: track.id } }),
          },
        ]
      : []),
    { label: "Share…", onSelect: () => {} },
    "divider",
    { label: "Rename", hint: "F2", onSelect: () => row.rename() },
    { label: "Move to…", onSelect: () => row.move() },
    { label: "Cut", hint: "⌘X", onSelect: () => row.cut() },
    { label: "Link a score…", onSelect: () => {} },
    ...(viewer.can(project.id, "delete")
      ? ["divider" as const, { label: "Delete…", danger: true, onSelect: () => {} }]
      : []),
  ];
  const actions: (MenuAction | "divider")[] = [
    ...personalActions(false),
    ...(viewer.can(project.id, "organise") ? ["divider" as const, ...organising] : []),
  ];
  const row = useRow(track.id, track.name, actions, true);
  return (
    <li
      {...row.props}
      className={cn(
        rowGrid,
        "group border-b border-line last:border-b-0 hover:bg-raised/50",
        row.className,
      )}
    >
      <RowPick id={track.id} icon="track" className="text-ink-2" />
      {row.renaming ? (
        <RenameInput initial={track.name} file={false} onDone={row.done} />
      ) : (
        <Link
          to={file ? "/files/$fileId" : "/tracks/$trackId"}
          params={file ? { fileId: file.id } : { trackId: track.id }}
          search={file ? {} : { view: "versions" }}
          className="min-w-0 py-3"
        >
          <span className="block truncate text-[14px] font-medium text-ink">{track.name}</span>
          <span className="block truncate text-[12px] text-ink-3">
            {track.composer}
            <span className="@3xl/app:hidden">
              {track.composer ? " · " : ""}
              {s.label}
              {s.version ? ` · V${s.version.number}` : ""}
            </span>
          </span>
        </Link>
      )}
      <span className="hidden items-center gap-2 text-[13px] text-ink-2 @3xl/app:flex">
        <Dot state={s.dot} />
        <span className="truncate">{s.label}</span>
      </span>
      <span className="tabular hidden truncate text-[13px] text-ink-3 @3xl/app:block">
        {s.version
          ? `V${s.version.number}${track.versions.length > 1 ? ` of ${track.versions.length}` : ""}${
              s.version.variations.length > 1 ? ` · ${s.version.variations.length} variations` : ""
            }`
          : "—"}
      </span>
      <span className="hidden items-center @3xl/app:flex">
        {s.waitingOn.length > 0 ? (
          <AvatarRow personIds={s.waitingOn} size={22} max={3} />
        ) : (
          <span className="text-[13px] text-ink-3">—</span>
        )}
      </span>
      <span className="tabular hidden items-center gap-1.5 text-[13px] text-ink-3 @3xl/app:flex">
        {s.version ? ago(s.version.uploadedAt) : ""}
        {comments > 0 && (
          <span className="flex items-center gap-0.5">
            <Icon name="comment" size={11} /> {comments}
          </span>
        )}
      </span>
      <span className={quickCell}>{quick}</span>
      <span className="flex items-center justify-end">
        <ActionMenu label={track.name} actions={actions} />
      </span>
    </li>
  );
}

function FileRow({ file, project }: { file: File; project: Project }) {
  const viewer = useViewer();
  const comments = openCommentCount(file.id);
  const long = useScreenState() === "long";
  const actions: (MenuAction | "divider")[] = [
    ...personalActions(false),
    ...(viewer.can(project.id, "organise")
      ? [
          "divider" as const,
          { label: "Share…", onSelect: () => {} },
          { label: "Details", onSelect: () => {} },
          "divider" as const,
          { label: "Rename", hint: "F2", onSelect: () => row.rename() },
          { label: "Move to…", onSelect: () => row.move() },
          { label: "Cut", hint: "⌘X", onSelect: () => row.cut() },
          { label: "Attach to a track…", onSelect: () => {} },
          { label: "Tags…", onSelect: () => {} },
          ...(viewer.can(project.id, "delete")
            ? ["divider" as const, { label: "Delete…", danger: true, onSelect: () => {} }]
            : []),
        ]
      : []),
  ];
  const row = useRow(file.id, file.name, actions, false);
  return (
    <li
      {...row.props}
      className={cn(
        rowGrid,
        "group border-b border-line last:border-b-0 hover:bg-raised/50",
        row.className,
      )}
    >
      <RowPick id={file.id} icon={kindIcon[file.kind]} className="text-ink-3" />
      {row.renaming ? (
        <RenameInput initial={file.name} file onDone={row.done} />
      ) : (
        <Link to="/files/$fileId" params={{ fileId: file.id }} className="min-w-0 py-3">
          <span
            className={cn(
              "block text-[14px] text-ink",
              long ? "line-clamp-2 break-all" : "truncate",
            )}
          >
            {file.name}
          </span>
          <span className="block truncate text-[12px] text-ink-3 @3xl/app:hidden">
            {chainLabel(file)}
            {fileDetails(file)}
          </span>
        </Link>
      )}
      <span className="hidden items-center gap-2 text-[13px] @3xl/app:flex">
        {file.state === "pending" && (
          <>
            <Dot state="working" /> <span className="text-ink-2">Processing</span>
          </>
        )}
        {file.state === "failed" && (
          <>
            <Icon name="warning" size={14} className="text-signal" />{" "}
            <span className="text-ink-2">Failed</span>
          </>
        )}
        {file.state === "ready" && <span className="text-ink-3">—</span>}
      </span>
      {/* Among tracks the column counts versions, which a loose file has only in a chain. */}
      <span className="tabular hidden truncate text-[13px] text-ink-3 @3xl/app:block">
        {chainOf(file).length
          ? `V${chainOf(file).findIndex((f) => f.id === file.id) + 1} of ${chainOf(file).length}`
          : "—"}
      </span>
      <span className="hidden items-center @3xl/app:flex">
        <Avatar personId={file.uploadedBy} size={22} />
      </span>
      <span className="tabular hidden items-center gap-1.5 text-[13px] text-ink-3 @3xl/app:flex">
        {ago(file.uploadedAt)}
        {comments > 0 && (
          <span className="flex items-center gap-0.5">
            <Icon name="comment" size={11} /> {comments}
          </span>
        )}
      </span>
      <span className={quickCell}>
        <Quick icon="eye" label="Open" to="/files/$fileId" params={{ fileId: file.id }} />
        {viewer.tools(project.id).has("download") && (
          <Quick icon="download" label="Download" onClick={() => {}} />
        )}
      </span>
      <span className="flex items-center justify-end">
        <ActionMenu label={file.name} actions={actions} />
      </span>
    </li>
  );
}

function FolderRow({ folder, project }: { folder: Folder; project: Project }) {
  const viewer = useViewer();
  const b = useContext(Browser);
  const actions: (MenuAction | "divider")[] = [
    ...personalActions(null),
    ...(viewer.can(project.id, "organise")
      ? [
          "divider" as const,
          { label: "Upload request…", onSelect: () => {} },
          "divider" as const,
          { label: "Rename", hint: "F2", onSelect: () => row.rename() },
          { label: "Move to…", onSelect: () => row.move() },
          { label: "Cut", hint: "⌘X", onSelect: () => row.cut() },
          ...(b && b.cut.size > 0 && !b.cut.has(folder.id)
            ? [{ label: "Paste here", hint: "⌘V", onSelect: () => b.setCut(new Set()) }]
            : []),
          { label: "Delete…", danger: true, onSelect: () => {} },
        ]
      : []),
  ];
  const row = useRow(folder.id, folder.name, actions, true);
  return (
    <li
      {...row.props}
      className={cn(
        rowGrid,
        "group border-b border-line last:border-b-0 hover:bg-raised/50",
        row.className,
      )}
    >
      <RowPick id={folder.id} icon="folder" className="text-ink-2" />
      {row.renaming ? (
        <RenameInput initial={folder.name} file={false} onDone={row.done} />
      ) : (
        <Link
          to="/projects/$projectId/$view"
          params={{ projectId: project.id, view: "files" }}
          search={{ folder: folder.id }}
          className="min-w-0 truncate py-3 text-[14px] font-medium text-ink"
        >
          {folder.name}
        </Link>
      )}
      <span className="hidden text-[13px] text-ink-3 @3xl/app:block">—</span>
      <span className="hidden truncate text-[13px] text-ink-3 @3xl/app:block">
        {folderCount(project.id, folder.id)}
      </span>
      <span className="hidden @3xl/app:block" />
      <span className="hidden @3xl/app:block" />
      <span className="hidden @3xl/app:block" />
      <span className="flex items-center justify-end">
        <ActionMenu label={folder.name} actions={actions} />
      </span>
    </li>
  );
}

/* ---------- Personal marks and filters ---------- */

/**
 * What anyone who can see a thing may do to it for themselves (#114): keep it as a favourite
 * (one mark, decision 269: it sits at the top of its folder and in the Favourites filter), and
 * (files and tracks) mark it seen or not. These open every row's menu; organising follows for
 * those who may.
 */
function personalActions(seen: boolean | null): (MenuAction | "divider")[] {
  return [
    { label: "Add to favourites", onSelect: () => {} },
    ...(seen === null
      ? []
      : [{ label: seen ? "Mark as not viewed" : "Mark as viewed", onSelect: () => {} }]),
  ];
}

const filterChoices: [IconName, string][] = [
  ["eye", "Not yet viewed"],
  ["comment", "With open comments"],
  ["user", "Uploaded by me"],
  ["star", "Favourites"],
];
const sampleTags: [string, number][] = [
  ["For print", 1],
  ["Masters", 2],
  ["Reference", 0],
];

/**
 * The Filter control: ways of looking across the whole project, and the workspace's tags.
 * While any is on, the list gathers matches from every folder, each saying where it lives,
 * and the filters show as removable chips under the toolbar.
 */
function FilterMenu() {
  const [open, setOpen, box] = usePopover();
  const [on, setOn] = useState<string[]>([]);
  const toggle = (v: string) => setOn(on.includes(v) ? on.filter((x) => x !== v) : [...on, v]);
  const row = (icon: IconName, label: string, count?: number) => (
    <button
      key={label}
      type="button"
      aria-pressed={on.includes(label)}
      onClick={() => toggle(label)}
      className="flex h-8 w-full items-center gap-2.5 rounded-control px-2 text-left text-[13px] text-ink hover:bg-raised"
    >
      <Icon name={icon} size={14} className="text-ink-3" />
      <span className="flex-1 truncate">{label}</span>
      {count !== undefined && <span className="tabular text-[12px] text-ink-3">{count}</span>}
      <span className="flex w-4 justify-end">
        {on.includes(label) && <Icon name="check" size={13} />}
      </span>
    </button>
  );
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-control px-2.5 text-[13px] hover:bg-raised hover:text-ink",
          on.length ? "text-ink" : "text-ink-3",
        )}
      >
        <Icon name="filter" size={14} />
        Filter
        {on.length > 0 && (
          <span className="tabular rounded-full bg-raised px-1.5 text-[11px] text-ink-2">
            {on.length}
          </span>
        )}
      </button>
      {open && (
        <Floating
          anchor={box}
          align="start"
          side="bottom"
          onClose={() => setOpen(false)}
          role="dialog"
          aria-label="Filter files"
          className="rise-in w-64 rounded-panel-lg bg-overlay p-1.5 shadow-4"
        >
          <p className="eyebrow m-0 px-2 pt-1 pb-1 text-ink-3">Show only</p>
          {filterChoices.map(([icon, label]) => row(icon, label))}
          <div className="mx-2 my-1.5 h-px bg-line" />
          <p className="eyebrow m-0 px-2 pt-1 pb-1 text-ink-3">Tagged</p>
          {sampleTags.map(([label, n]) => row("tag", label, n))}
        </Floating>
      )}
    </div>
  );
}

/* ---------- Column view ---------- */

function ColumnRow({
  icon,
  name,
  hint,
  selected,
  container,
  onClick,
  lead,
}: {
  icon?: IconName;
  name: string;
  hint?: string;
  selected: boolean;
  container: boolean;
  onClick: () => void;
  lead?: ReactNode;
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
        {lead ?? (icon && <Icon name={icon} size={15} className="shrink-0 text-ink-3" />)}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px]">{name}</span>
          {hint && <span className="block truncate text-[11px] text-ink-3">{hint}</span>}
        </span>
        {container && <Icon name="chevronRight" size={12} className="shrink-0 text-ink-3" />}
      </button>
    </li>
  );
}

function Preview({ item, project }: { item: Item; project: Project }) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const file =
    item.kind === "file"
      ? item.file
      : item.kind === "version"
        ? primaryFile(item.version)
        : item.kind === "track" && latestVersion(item.track)
          ? primaryFile(latestVersion(item.track) as Version)
          : undefined;
  const rows: [string, ReactNode][] = [];
  if (item.kind === "folder") rows.push(["Holds", folderCount(project.id, item.folder.id)]);
  if (item.kind === "track") {
    const s = trackState(item.track, project);
    rows.push(["Status", s.label]);
    rows.push(["Versions", String(item.track.versions.length)]);
    if (s.waitingOn.length)
      rows.push(["Waiting on", <AvatarRow key="w" personIds={s.waitingOn} size={20} />]);
    if (item.track.composer) rows.push(["Composer", item.track.composer]);
  }
  if (item.kind === "version") {
    rows.push(["Status", item.version.status]);
    rows.push([
      "Uploaded",
      `${personById(item.version.uploadedBy).name}, ${formatDateTime(item.version.uploadedAt)}`,
    ]);
    rows.push(["Variations", item.version.variations.map((v) => v.name).join(", ")]);
    if (item.version.note) rows.push(["Note", item.version.note]);
  }
  if (file) {
    rows.push(["Format", fileDetails(file)]);
    rows.push(["Size", formatBytes(file.size)]);
    rows.push(["Comments", String(openCommentCount(file.id))]);
  }
  const title =
    item.kind === "folder"
      ? item.folder.name
      : item.kind === "track"
        ? item.track.name
        : item.kind === "version"
          ? `${item.track.name} · V${item.version.number}`
          : item.file.name;
  return (
    <div className="flex w-[300px] shrink-0 flex-col gap-4 p-4">
      {file ? (
        <Thumb file={file} width={268} height={120} />
      ) : (
        <span className="flex h-[120px] w-[268px] items-center justify-center rounded-[6px] bg-sunken text-ink-3">
          <Icon name={item.kind === "folder" ? "folder" : "track"} size={28} />
        </span>
      )}
      <div>
        <h3 className="text-[14px] font-medium text-ink">{title}</h3>
        <dl className="mt-3 flex flex-col gap-1.5 text-[13px]">
          {rows.map(([k, v]) => (
            <div key={k} className="flex gap-3">
              <dt className="w-20 shrink-0 text-ink-3">{k}</dt>
              <dd className="min-w-0 flex-1 text-ink-2">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {file && (
          <Button variant="primary" size="sm" asChild>
            <Link to="/files/$fileId" params={{ fileId: file.id }}>
              <Icon name="play" size={11} fill="currentColor" strokeWidth={0} />
              Open
            </Link>
          </Button>
        )}
        {item.kind === "folder" && (
          <Button variant="secondary" size="sm" asChild>
            <Link
              to="/projects/$projectId/$view"
              params={{ projectId: project.id, view: "files" }}
              search={{ folder: item.folder.id }}
            >
              Open folder
            </Link>
          </Button>
        )}
        {item.kind === "track" && file && viewer.can(project.id, "request_reviews") && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              navigate({ to: "/reviews/new", search: { project: project.id, item: item.track.id } })
            }
          >
            Request a review
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

/**
 * Columns, as the Finder does it: each choice opens the next column; the last shows a preview.
 * They always start at the top of the project, with the open folder's ancestors opened and the
 * folder chosen; choosing another folder in them opens it, so the list and the columns agree.
 */
function ColumnBrowser({ project, folderId }: { project: Project; folderId: string | null }) {
  const navigate = useNavigate();
  /** What is chosen below the open folder; the folder's own path comes from the address. */
  const [below, setBelow] = useState<Item[]>([]);
  const path: Item[] = [
    ...folderPath(folderId).map((folder): Item => ({ kind: "folder", id: folder.id, folder })),
    ...below,
  ];
  const columns: { items: Item[]; selected: Item | null }[] = [];
  let items = itemsIn(project, null);
  for (let depth = 0; ; depth++) {
    const selected = path[depth] ?? null;
    columns.push({ items, selected });
    if (!selected) break;
    if (selected.kind === "folder") items = itemsIn(project, selected.folder.id);
    else if (selected.kind === "track")
      items = [...selected.track.versions]
        .sort((a, b) => b.number - a.number)
        .map(
          (version): Item => ({ kind: "version", id: version.id, track: selected.track, version }),
        );
    else break;
  }
  const last = path.at(-1);
  const choose = (depth: number, item: Item) => {
    const next = [...path.slice(0, depth), item];
    let deepest = -1;
    next.forEach((i, at) => {
      if (i.kind === "folder") deepest = at;
    });
    const folder = next[deepest];
    const into = folder?.kind === "folder" ? folder.folder.id : null;
    setBelow(next.slice(deepest + 1));
    if (into !== folderId)
      void navigate({
        to: "/projects/$projectId/$view",
        params: { projectId: project.id, view: "files" },
        search: into ? { folder: into } : {},
      });
  };
  return (
    <Card className="scroll-quiet flex min-h-[420px] overflow-x-auto">
      {columns.map((col, depth) => (
        <ul
          key={String(depth)}
          className="flex w-[260px] shrink-0 flex-col overflow-y-auto border-r border-line py-1"
        >
          {col.items.map((item) => {
            const selected = col.selected?.id === item.id;
            if (item.kind === "folder")
              return (
                <ColumnRow
                  key={item.id}
                  icon="folder"
                  name={item.folder.name}
                  selected={selected}
                  container
                  onClick={() => choose(depth, item)}
                />
              );
            if (item.kind === "track") {
              const s = trackState(item.track, project);
              return (
                <ColumnRow
                  key={item.id}
                  icon="track"
                  name={item.track.name}
                  hint={`${s.label}${s.version ? ` · V${s.version.number}` : ""}`}
                  selected={selected}
                  container={item.track.versions.length > 0}
                  onClick={() => choose(depth, item)}
                />
              );
            }
            if (item.kind === "version")
              return (
                <ColumnRow
                  key={item.id}
                  name={`V${item.version.number}`}
                  hint={`${item.version.status} · ${ago(item.version.uploadedAt)}`}
                  selected={selected}
                  container={false}
                  onClick={() => choose(depth, item)}
                  lead={
                    <Dot state={item.version.status === "Approved" ? "approved" : "in_review"} />
                  }
                />
              );
            return (
              <ColumnRow
                key={item.id}
                icon={kindIcon[item.file.kind]}
                name={item.file.name}
                hint={fileDetails(item.file)}
                selected={selected}
                container={false}
                onClick={() => choose(depth, item)}
              />
            );
          })}
          {col.items.length === 0 && <li className="px-3 py-3 text-[12px] text-ink-3">Empty</li>}
        </ul>
      ))}
      {last && (last.kind !== "track" || last.track.versions.length === 0) ? (
        <Preview item={last} project={project} />
      ) : (
        <div className="flex w-[300px] shrink-0 items-center justify-center p-4 text-center text-[12px] text-ink-3">
          {last ? "Choose a version" : "Choose something to see its details"}
        </div>
      )}
    </Card>
  );
}

/* ---------- The tab ---------- */

export function Files({ project, folderId }: { project: Project; folderId: string | null }) {
  const viewer = useViewer();
  const [view, setView] = useState<"list" | "columns" | "grid">(() => {
    try {
      return (
        (localStorage.getItem("hekate.prototype.files") as "list" | "columns" | "grid") || "list"
      );
    } catch {
      return "list";
    }
  });
  const choose = (v: typeof view) => {
    setView(v);
    try {
      localStorage.setItem("hekate.prototype.files", v);
    } catch {
      // Not remembered.
    }
  };
  const state = useScreenState();
  const path = folderPath(folderId);
  const items = itemsIn(project, folderId);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const selection = {
    has: (id: string) => picked.has(id),
    toggle: (id: string) =>
      setPicked((was) => {
        const next = new Set(was);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    any: picked.size > 0,
    count: picked.size,
  };
  const organise = viewer.can(project.id, "organise");
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [cut, setCut] = useState<Set<string>>(new Set());
  const [moving, setMoving] = useState<string | null>(null);
  /** What the selection bar and the context menu on a selected row both offer. */
  const selectionActions: (MenuAction | "divider")[] = [
    { label: "Pin", onSelect: () => {} },
    { label: "Favourite", onSelect: () => {} },
    { label: "Mark as viewed", onSelect: () => {} },
    ...(organise
      ? [
          "divider" as const,
          { label: "Move to…", onSelect: () => setMoving(`Move ${picked.size} items`) },
          { label: "Tags…", onSelect: () => {} },
          { label: "Cut", hint: "⌘X", onSelect: () => setCut(new Set(picked)) },
        ]
      : []),
    ...(viewer.can(project.id, "delete")
      ? ["divider" as const, { label: "Delete…", danger: true, onSelect: () => {} }]
      : []),
  ];
  const browser = {
    organise,
    menu: (at: OpenMenu["at"], actions: (MenuAction | "divider")[], label: string) =>
      setMenu({ at, actions, label }),
    selection: selectionActions,
    renaming,
    rename: setRenaming,
    dropOn,
    setDropOn,
    cut,
    setCut,
    move: setMoving,
  };
  /** The empty space: making and uploading here, pasting what was cut, selecting. */
  const spaceActions: (MenuAction | "divider")[] = [
    ...(organise
      ? [
          { label: "New folder", onSelect: () => {} },
          ...(project.profile === "music" ? [{ label: "New track", onSelect: () => {} }] : []),
        ]
      : []),
    ...(viewer.can(project.id, "upload") ? [{ label: "Upload…", onSelect: () => {} }] : []),
    ...(organise && cut.size > 0
      ? ["divider" as const, { label: "Paste", hint: "⌘V", onSelect: () => setCut(new Set()) }]
      : []),
    "divider" as const,
    { label: "Select all", hint: "⌘A", onSelect: () => setPicked(new Set(items.map((i) => i.id))) },
  ];
  const spaceMenu = (event: MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-row], input, textarea, [role=menu], [role=dialog]")) return;
    event.preventDefault();
    setMenu({
      at: { x: event.clientX, y: event.clientY },
      actions: spaceActions,
      label: "Actions for this folder",
    });
  };
  /** The path takes a drop too: up a level, or to the top. */
  const pathDrop = (id: string | null) =>
    organise
      ? {
          onDragOver: (event: DragEvent<HTMLElement>) => {
            if (!Array.from(event.dataTransfer.types).includes(dragType)) return;
            event.preventDefault();
            setDropOn(id ?? "top");
          },
          onDragLeave: () => setDropOn(null),
          onDrop: (event: DragEvent<HTMLElement>) => {
            event.preventDefault();
            setDropOn(null);
          },
        }
      : {};
  const canUpload = viewer.can(project.id, "upload");
  const uploading = state === "processing";
  const [requesting, setRequesting] = useState(false);
  // Where an upload request's files go: a folder, or a track's next version (#425).
  const [requestInto, setRequestInto] = useState("f-day2");
  const requestTrack = allTracks.find((t) => t.id === requestInto);
  // The columns start at the top of the project, so an empty open folder still shows them.
  const empty =
    state === "empty" ||
    (items.length === 0 && (view !== "columns" || itemsIn(project, null).length === 0));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <nav aria-label="Folder" className="flex min-w-0 items-center gap-1 text-[14px]">
          <Link
            to="/projects/$projectId/$view"
            params={{ projectId: project.id, view: "files" }}
            {...pathDrop(null)}
            className={cn(
              "rounded-control",
              folderId ? "text-ink-3 hover:text-ink" : "font-medium text-ink",
              dropOn === "top" && "bg-raised text-ink",
            )}
          >
            All files
          </Link>
          {path.map((f, i) => (
            <span key={f.id} className="flex items-center gap-1">
              <span className="text-edge">/</span>
              <Link
                to="/projects/$projectId/$view"
                params={{ projectId: project.id, view: "files" }}
                search={{ folder: f.id }}
                {...(i === path.length - 1 ? {} : pathDrop(f.id))}
                className={cn(
                  "truncate rounded-control",
                  i === path.length - 1 ? "font-medium text-ink" : "text-ink-3 hover:text-ink",
                  dropOn === f.id && "bg-raised text-ink",
                )}
              >
                {f.name}
              </Link>
            </span>
          ))}
          <span className="ml-2 text-[13px] text-ink-3">{plural(items.length, "item")}</span>
        </nav>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <FilterMenu />
          <div
            role="radiogroup"
            className="flex rounded-control border border-line bg-raised/40 p-0.5"
          >
            {(
              [
                ["list", "List"],
                ["columns", "Columns"],
                ["grid", "Grid"],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={view === v}
                aria-label={label}
                title={label}
                onClick={() => choose(v)}
                className={cn(
                  "flex size-7 items-center justify-center rounded-[4px]",
                  view === v ? "bg-overlay text-ink shadow-2" : "text-ink-3 hover:text-ink",
                )}
              >
                <Icon name={v} size={14} />
              </button>
            ))}
          </div>
          {viewer.can(project.id, "organise") && (
            <ActionMenu
              always
              label="new"
              actions={[
                { label: "New folder", onSelect: () => {} },
                ...(project.profile === "music"
                  ? [{ label: "New track", onSelect: () => {} }]
                  : []),
                { label: "Upload request…", onSelect: () => setRequesting(true) },
                "divider",
                { label: "Select all", onSelect: () => setPicked(new Set(items.map((i) => i.id))) },
              ]}
            />
          )}
          {canUpload && (
            <Button variant="primary" size="md">
              <Icon name="upload" size={14} />
              Upload
            </Button>
          )}
        </div>
      </div>
      {menu && (
        <ContextMenu
          at={menu.at}
          actions={menu.actions}
          label={menu.label}
          onClose={() => setMenu(null)}
        />
      )}
      {moving && (
        <MovePicker
          title={moving}
          project={project}
          current={folderId}
          onClose={() => setMoving(null)}
        />
      )}
      {requesting && (
        <Dialog
          title="Upload request"
          description="A link for someone outside the project to upload into a folder, or as a track's next version. They need no account."
          onClose={() => setRequesting(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setRequesting(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => setRequesting(false)}>
                Create the link
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
              Name
              <Input defaultValue="String stems" />
            </label>
            <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
              What you want
              <Textarea
                rows={2}
                defaultValue="The string stems of Maple Leaf Rag, 96 kHz, one file per section."
              />
            </label>
            <div className="grid gap-4 @md/app:grid-cols-3">
              <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                Into
                <Select value={requestInto} onChange={(e) => setRequestInto(e.target.value)}>
                  <optgroup label="Folder">
                    <option value="">Top of the project</option>
                    {folders
                      .filter((f) => f.projectId === project.id)
                      .map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                  </optgroup>
                  {project.profile === "music" && (
                    <optgroup label="As the next version of">
                      {allTracks
                        .filter((t) => t.projectId === project.id)
                        .map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                    </optgroup>
                  )}
                </Select>
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                File limit
                <Input defaultValue="5" />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                Expires
                <Input type="date" defaultValue="2026-10-20" />
              </label>
            </div>
            {requestTrack && (
              <p className="text-[12px] text-ink-3">
                Each file sent becomes the next version of {requestTrack.name} once it has been
                processed, and arrives beside the track.
              </p>
            )}
            <div className="grid gap-4 @md/app:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                Password (optional)
                <Input type="password" />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                Email the link to (optional)
                <Input type="email" placeholder="alex@example.com" />
              </label>
            </div>
            <p className="text-[12px] text-ink-3">
              The visitor's page:{" "}
              <Link to="/u/$code" params={{ code: "r-7f3a" }} className="text-ink-2 hover:text-ink">
                open it as they would see it
              </Link>
              . What arrives is listed here with who sent it.
            </p>
          </div>
        </Dialog>
      )}
      {uploading && (
        <Card className="p-3">
          <div className="eyebrow mb-2">Uploading · 2 of 3</div>
          {[
            { name: "The Entertainer - V1 mix.wav", pct: 100, size: "31 MB" },
            { name: "The Entertainer - V1 wet.wav", pct: 62, size: "31 MB" },
            { name: "Pine Apple Rag - V1 mix.wav", pct: 0, size: "28 MB", failed: true },
          ].map((u) => (
            <div key={u.name} className="flex items-center gap-3 py-1.5 text-[14px]">
              <Icon name="music" className="text-ink-3" />
              <span className="min-w-0 flex-1 truncate text-ink">{u.name}</span>
              {u.failed ? (
                <>
                  <span className="text-[13px] text-signal">Connection lost</span>
                  <button type="button" className="text-[13px] text-ink-2 hover:text-ink">
                    Retry
                  </button>
                </>
              ) : (
                <span className="tabular text-[13px] text-ink-3">
                  {u.pct === 100 ? "Checking" : `${u.pct}% · ${u.size}`}
                </span>
              )}
              <div className="h-1 w-24 overflow-hidden rounded-full bg-raised">
                <div
                  className={cn("h-full", u.failed ? "bg-signal" : "bg-ink-2")}
                  style={{ width: `${u.failed ? 30 : u.pct}%` }}
                />
              </div>
            </div>
          ))}
        </Card>
      )}
      {empty ? (
        <Empty
          title={folderId ? "This folder is empty" : "Nothing here yet"}
          text={
            canUpload
              ? "Drop files anywhere on this page to upload them here, or use Upload. A track groups a piece's versions."
              : "Files appear here once someone uploads them."
          }
          action={canUpload ? <Button variant="primary">Upload</Button> : undefined}
        />
      ) : view === "columns" ? (
        <ColumnBrowser project={project} folderId={folderId} />
      ) : view === "list" ? (
        <Picked.Provider value={selection}>
          <Browser.Provider value={browser}>
            {/* A right click on the space around the rows; the keyboard opens the same menu from a row. */}
            <div onContextMenu={spaceMenu}>
              <Card>
                <div className={cn(rowGrid, "hidden h-9 border-b border-line @3xl/app:grid")}>
                  <span />
                  <Label>Name</Label>
                  <Label>Status</Label>
                  <Label>Versions</Label>
                  <Label>People</Label>
                  <Label>Updated</Label>
                  <span />
                  <ColumnsChooser />
                </div>
                <ul className="list-none p-0">
                  {items.map((item) =>
                    item.kind === "folder" ? (
                      <FolderRow key={item.id} folder={item.folder} project={project} />
                    ) : item.kind === "track" ? (
                      <TrackRow key={item.id} track={item.track} project={project} />
                    ) : item.kind === "file" ? (
                      <FileRow key={item.id} file={item.file} project={project} />
                    ) : null,
                  )}
                </ul>
              </Card>
            </div>
            {picked.size > 0 && (
              <SelectionBar
                count={picked.size}
                actions={selectionActions}
                onClear={() => setPicked(new Set())}
              />
            )}
          </Browser.Provider>
        </Picked.Provider>
      ) : (
        <ul className="grid list-none grid-cols-2 gap-4 p-0 @3xl/app:grid-cols-4 @6xl/app:grid-cols-5">
          {items.map((item) => {
            const file =
              item.kind === "file"
                ? item.file
                : item.kind === "track" && latestVersion(item.track)
                  ? primaryFile(latestVersion(item.track) as Version)
                  : undefined;
            const name =
              item.kind === "folder"
                ? item.folder.name
                : item.kind === "track"
                  ? item.track.name
                  : item.kind === "file"
                    ? item.file.name
                    : "";
            const sub =
              item.kind === "folder"
                ? folderCount(project.id, item.folder.id)
                : item.kind === "track"
                  ? trackState(item.track, project).label
                  : item.kind === "file"
                    ? fileDetails(item.file)
                    : "";
            const link =
              item.kind === "folder"
                ? {
                    to: "/projects/$projectId/$view",
                    params: { projectId: project.id, view: "files" },
                    search: { folder: item.folder.id },
                  }
                : file
                  ? { to: "/files/$fileId", params: { fileId: file.id }, search: {} }
                  : {
                      to: "/tracks/$trackId",
                      params: { trackId: item.id },
                      search: { view: "versions" },
                    };
            return (
              <li key={item.id}>
                <Link
                  to={link.to}
                  params={link.params}
                  search={link.search}
                  className="group flex flex-col gap-2.5 rounded-panel-lg border border-line bg-raised/30 p-3 shadow-1 transition-colors hover:border-edge"
                >
                  {file ? (
                    <Thumb file={file} width={220} height={110} className="w-full" />
                  ) : (
                    <span className="flex aspect-[2/1] items-center justify-center rounded-[6px] bg-sunken text-ink-3">
                      <Icon name={item.kind === "folder" ? "folder" : "track"} size={24} />
                    </span>
                  )}
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] text-ink">{name}</span>
                    <span className="block truncate text-[12px] text-ink-3">{sub}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

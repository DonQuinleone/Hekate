import { descendantsOf, folderPath, formatBytes } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { cn } from "~/lib/cn";
import {
  type Folder,
  type ProjectFile,
  projectFilesQuery,
  projectFoldersQuery,
  useOrganise,
  useProjectCan,
} from "~/lib/queries";
import { kindIcon, mediaSummary } from "./files";
import { Icon } from "./icons";
import { Button } from "./ui/button";

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

type Item = { kind: "folder"; folder: Folder } | { kind: "file"; file: ProjectFile };
const itemId = (item: Item) => (item.kind === "folder" ? item.folder.id : item.file.id);
const itemName = (item: Item) => (item.kind === "folder" ? item.folder.name : item.file.name);

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

/**
 * A project's files and folders, one folder at a time, as a list or a grid. Those whose role
 * can organise make folders, and rename, move and delete what is here.
 */
export function FileBrowser({
  projectId,
  folderId,
  onOpenFolder,
  children,
}: {
  projectId: string;
  folderId: string | null;
  onOpenFolder: (folderId: string | null) => void;
  /** Shown above the listing, such as the uploader for this folder. */
  children?: ReactNode;
}) {
  const { data: files, error } = useQuery(projectFilesQuery(projectId));
  const { data: folders, error: foldersError } = useQuery(projectFoldersQuery(projectId));
  const can = useProjectCan(projectId);
  const organise = useOrganise(projectId);
  const [view, setView] = useState<View>(storedView);
  const [naming, setNaming] = useState(false);
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
  const path = folderPath(all, folderId);
  const items: Item[] = [
    ...all
      .filter((f) => f.parentId === folderId)
      .map((folder) => ({ kind: "folder" as const, folder })),
    ...(files ?? [])
      .filter((f) => f.folderId === folderId)
      .map((file) => ({ kind: "file" as const, file })),
  ];
  const parentName = path.at(-2)?.name ?? "the top of the project";
  const failure =
    organise.createFolder.error ??
    organise.updateFolder.error ??
    organise.deleteFolder.error ??
    organise.updateFile.error ??
    organise.deleteFile.error;

  const createFolder = (event: FormEvent) => {
    event.preventDefault();
    organise.createFolder.mutate(
      { name: newName.trim(), parentId: folderId },
      {
        onSuccess: () => {
          setNewName("");
          setNaming(false);
        },
      },
    );
  };
  const done = { onSuccess: () => setEditing(null) };
  const rename = (item: Item, name: string) =>
    item.kind === "folder"
      ? organise.updateFolder.mutate({ id: item.folder.id, name }, done)
      : organise.updateFile.mutate({ id: item.file.id, name }, done);
  const move = (item: Item, to: string | null) =>
    item.kind === "folder"
      ? organise.updateFolder.mutate({ id: item.folder.id, parentId: to }, done)
      : organise.updateFile.mutate({ id: item.file.id, folderId: to }, done);
  const remove = (item: Item) =>
    item.kind === "folder"
      ? organise.deleteFolder.mutate(item.folder.id, done)
      : organise.deleteFile.mutate(item.file.id, done);
  const pending =
    organise.updateFolder.isPending ||
    organise.updateFile.isPending ||
    organise.deleteFolder.isPending ||
    organise.deleteFile.isPending;

  /** The name, as a link into a folder or to a file. */
  const title = (item: Item) =>
    item.kind === "folder" ? (
      <button
        type="button"
        onClick={() => onOpenFolder(item.folder.id)}
        className="cursor-pointer truncate border-0 bg-transparent p-0 text-left text-sm font-medium text-ink hover:text-signal"
      >
        {item.folder.name}
      </button>
    ) : (
      <Link
        to="/files/$fileId"
        params={{ fileId: item.file.id }}
        className="truncate text-sm font-medium text-ink no-underline hover:text-signal"
      >
        {item.file.name}
      </Link>
    );

  const details = (item: Item) => {
    if (item.kind === "folder") {
      const inside =
        all.filter((f) => f.parentId === item.folder.id).length +
        (files ?? []).filter((f) => f.folderId === item.folder.id).length;
      return inside === 0 ? "Empty" : inside === 1 ? "1 item" : `${inside} items`;
    }
    return (
      mediaSummary(item.file.kind, item.file.mediaInfo, item.file.streamStatus) ??
      item.file.contentType
    );
  };

  const actions = (item: Item) =>
    manage && (
      <span className="flex shrink-0 gap-3">
        <button
          type="button"
          className={action}
          onClick={() => setEditing({ id: itemId(item), mode: "rename" })}
        >
          Rename
        </button>
        <button
          type="button"
          className={action}
          onClick={() => setEditing({ id: itemId(item), mode: "move" })}
        >
          Move
        </button>
        <button
          type="button"
          className={cn(action, "hover:text-signal")}
          onClick={() => setEditing({ id: itemId(item), mode: "delete" })}
        >
          Delete
        </button>
      </span>
    );

  /** The open editor for an item, in place of its actions. */
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
            : `Delete ${item.file.name}? This cannot be undone.`}
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

  // Without its folders the tree would look empty, so either failing is shown, never hidden.
  const loadError = error ?? foldersError;
  if (loadError) return <p className="m-0 text-signal">{loadError.message}</p>;

  return (
    <section aria-label="Files" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav
          aria-label="Folder path"
          className="flex min-w-0 flex-wrap items-center gap-2 text-[13px]"
        >
          {path.length === 0 ? (
            <span className="font-medium text-ink">All files</span>
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
                <span className="truncate font-medium text-ink">{f.name}</span>
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
        <div className="flex items-center gap-3">
          <fieldset className="m-0 flex gap-1 border-0 p-0" aria-label="View">
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
          {manage && !naming && (
            <Button size="sm" onClick={() => setNaming(true)}>
              <Icon name="folder" size={14} />
              New folder
            </Button>
          )}
        </div>
      </div>

      {naming && (
        <form
          onSubmit={createFolder}
          className="flex flex-wrap items-center gap-2"
          aria-label="New folder"
        >
          <input
            // biome-ignore lint/a11y/noAutofocus: the field appears because the person asked for a folder
            autoFocus
            aria-label="Folder name"
            placeholder="Mixes"
            className={cn(control, "w-64")}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setNaming(false)}
          />
          <Button
            size="sm"
            type="submit"
            disabled={!newName.trim() || organise.createFolder.isPending}
          >
            Create
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setNaming(false)}>
            Cancel
          </Button>
        </form>
      )}
      {failure && <p className="m-0 text-xs text-signal">{failure.message}</p>}

      {children}

      {items.length === 0 ? (
        folderId && <p className="m-0 text-[13px] text-ink-3">This folder is empty.</p>
      ) : view === "list" ? (
        <ul className="m-0 flex list-none flex-col p-0" aria-label="Contents">
          <li className="label hidden grid-cols-[auto_minmax(0,1fr)_280px_72px_104px] gap-3 border-b border-hairline px-2 pb-2 sm:grid">
            <span className="w-4" />
            <span>Name</span>
            <span>Details</span>
            <span className="text-right">Size</span>
            <span className="text-right">Added</span>
          </li>
          {items.map((item) => {
            const open = editing?.id === itemId(item);
            return (
              <li
                key={itemId(item)}
                className="group flex flex-col gap-2 border-b border-hairline px-2 py-2"
              >
                <div className="grid min-h-8 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 sm:grid-cols-[auto_minmax(0,1fr)_280px_72px_104px]">
                  <Icon
                    name={item.kind === "folder" ? "folder" : kindIcon[item.file.kind]}
                    className="row-span-2 text-ink-2 sm:row-span-1"
                  />
                  <span className="flex min-w-0 items-center gap-3">
                    {open && editing?.mode === "rename" ? editor(item) : title(item)}
                  </span>
                  <span className="tabular text-right text-xs text-ink-3 sm:order-last">
                    {item.kind === "file" ? dateFormat.format(new Date(item.file.createdAt)) : ""}
                  </span>
                  <span className="tabular col-span-2 flex min-w-0 items-center justify-between gap-3 text-xs text-ink-2 sm:col-span-1">
                    <span className="truncate">{details(item)}</span>
                    {!open && actions(item)}
                  </span>
                  <span className="tabular hidden text-right text-xs text-ink-3 sm:block">
                    {item.kind === "file" ? formatBytes(item.file.byteSize) : ""}
                  </span>
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
                  "flex min-w-0 flex-col gap-3 rounded-panel border border-hairline p-3",
                  open && "col-span-2 sm:col-span-3 lg:col-span-4",
                )}
              >
                <Icon
                  name={item.kind === "folder" ? "folder" : kindIcon[item.file.kind]}
                  size={28}
                  className="text-ink-2"
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  {open && editing?.mode === "rename" ? editor(item) : title(item)}
                  <span className="tabular truncate text-xs text-ink-3">{details(item)}</span>
                </span>
                {open ? editing?.mode !== "rename" && editor(item) : actions(item)}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

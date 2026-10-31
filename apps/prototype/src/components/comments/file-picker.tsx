import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Icon } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Input, Select } from "~/components/ui/input";
import { type File, type FileKind, files, folders, variantOf } from "~/data";
import { cn } from "~/lib/cn";
import { folderPath, kindIcon } from "~/lib/files";
import { formatDuration } from "~/lib/format";

/** What a kind is called in the picker's filter. */
export const kindNames: Record<FileKind, string> = {
  audio: "Audio",
  video: "Video",
  document: "Documents",
  image: "Pictures",
  other: "Other",
};

/** Where a file sits: its track, version and variant, or its folder's path. */
export function fileWhere(file: File): string {
  const variant = variantOf(file.id);
  if (variant) return `${variant.track.name} · V${variant.version.number} · ${variant.variantName}`;
  const path = folderPath(file.folderId).map((f) => f.name);
  return path.length > 0 ? path.join(" / ") : "Top of the project";
}

/** A file's length or pages, as the row's end says it. */
const measure = (file: File) =>
  file.kind === "audio" || file.kind === "video"
    ? formatDuration(file.media.duration)
    : file.media.pages
      ? `${file.media.pages} ${file.media.pages === 1 ? "page" : "pages"}`
      : null;

/**
 * Files already in the project to put on a comment (#527), as Linear's pickers work: a search,
 * the project's folders and the files' kinds to narrow it, a box to tick on each, and each
 * opened in its own viewer in a new tab first. Linked, a file opens in the viewer for whoever
 * reads the comment, as their own access allows; never as a download.
 */
export function FilePickerDialog({
  projectId,
  exclude,
  chosen,
  onPick,
  onClose,
}: {
  projectId: string;
  /** The file being commented on: it is the comment's already. */
  exclude: string;
  chosen: string[];
  onPick: (ids: string[]) => void;
  onClose: () => void;
}) {
  const [ticked, setTicked] = useState<Set<string>>(new Set(chosen));
  const [query, setQuery] = useState("");
  const [folderId, setFolderId] = useState("");
  const [kind, setKind] = useState<FileKind | "">("");
  const all = files.filter((f) => f.projectId === projectId && f.id !== exclude);
  const ownFolders = folders.filter((f) => f.projectId === projectId);
  // A folder chosen covers what is beneath it.
  const within = (file: File) => {
    if (!folderId) return true;
    return folderPath(file.folderId).some((f) => f.id === folderId);
  };
  const needle = query.trim().toLowerCase();
  const shown = all.filter(
    (f) =>
      (!needle || f.name.toLowerCase().includes(needle)) && (!kind || f.kind === kind) && within(f),
  );
  const kinds = (Object.keys(kindNames) as FileKind[]).filter((k) => all.some((f) => f.kind === k));
  const toggle = (id: string) => {
    const next = new Set(ticked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setTicked(next);
  };
  return (
    <Dialog
      title="Files from this project"
      description="Each opens in the viewer for whoever reads the comment, as their own access allows. Nothing is downloaded from it."
      onClose={onClose}
      width="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={ticked.size === 0}
            onClick={() => {
              onPick([...ticked]);
              onClose();
            }}
          >
            Attach {ticked.size || ""}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files"
            aria-label="Search files"
            className="min-w-0 basis-full @3xl/app:flex-1 @3xl/app:basis-auto"
          />
          <Select
            aria-label="Folder"
            value={folderId}
            onChange={(e) => setFolderId(e.target.value)}
            className="w-auto min-w-0 flex-1 @3xl/app:flex-none"
          >
            <option value="">All folders</option>
            {ownFolders.map((f) => (
              <option key={f.id} value={f.id}>
                {folderPath(f.id)
                  .map((p) => p.name)
                  .join(" / ")}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as FileKind | "")}
            className="w-auto min-w-0 flex-1 @3xl/app:flex-none"
          >
            <option value="">Every kind</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {kindNames[k]}
              </option>
            ))}
          </Select>
        </div>
        {shown.length === 0 ? (
          <p className="text-[13px] text-ink-3">
            {all.length === 0
              ? "This project has no other files yet."
              : "No file matches. Try another word, folder or kind."}
          </p>
        ) : (
          <ul className="flex list-none flex-col divide-y divide-line rounded-panel border border-line p-0">
            {shown.map((f) => (
              <li
                key={f.id}
                className={cn(
                  "flex items-center gap-3 px-3 py-2",
                  ticked.has(f.id) && "bg-raised/40",
                )}
              >
                <input
                  type="checkbox"
                  checked={ticked.has(f.id)}
                  onChange={() => toggle(f.id)}
                  aria-label={`Attach ${f.name}`}
                />
                <Link
                  to="/files/$fileId"
                  params={{ fileId: f.id }}
                  target="_blank"
                  rel="noopener"
                  aria-label={`Open ${f.name} in a new tab`}
                  title="Open it in a new tab"
                  className="flex size-7 shrink-0 items-center justify-center rounded-full bg-raised text-ink-2 hover:bg-edge hover:text-ink"
                >
                  <Icon name={kindIcon[f.kind]} size={13} />
                </Link>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-ink">{f.name}</span>
                  <span className="block truncate text-[13px] text-ink-3">{fileWhere(f)}</span>
                </span>
                {measure(f) && (
                  <span className="tabular shrink-0 text-[13px] text-ink-3">{measure(f)}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

/**
 * The files linked to a comment, each opening in the viewer (#527): its kind and its name, the
 * same chip wherever a comment shows them.
 */
export function LinkedFiles({ ids }: { ids: string[] }) {
  const list = ids.flatMap((id) => {
    const f = files.find((x) => x.id === id);
    return f ? [f] : [];
  });
  if (list.length === 0) return null;
  return (
    <ul className="mt-1 flex list-none flex-wrap gap-1.5 p-0" aria-label="Linked files">
      {list.map((f) => (
        <li key={f.id} className="min-w-0">
          <Link
            to="/files/$fileId"
            params={{ fileId: f.id }}
            onClick={(e) => e.stopPropagation()}
            title={`${fileWhere(f)}. Opens in the viewer.`}
            className="flex h-7 max-w-full items-center gap-1.5 rounded-chip border border-line bg-raised/40 px-2.5 text-[12px] text-ink-2 transition-colors hover:border-edge hover:text-ink"
          >
            <Icon name={kindIcon[f.kind]} size={12} className="shrink-0 text-ink-3" />
            <span className="truncate">{f.name}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

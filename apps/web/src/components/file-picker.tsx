import { type FileKind, formatDuration, type LinkedFile } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { cn } from "~/lib/cn";
import {
  filesMatching,
  folderChoices,
  kindNames,
  kindsAmong,
  type PickableFile,
  pickableFiles,
} from "~/lib/file-picker";
import {
  type ProjectFile,
  projectFilesQuery,
  projectFoldersQuery,
  projectTracksQuery,
  useItemWords,
} from "~/lib/queries";
import { kindIcon } from "./files";
import { Icon } from "./icons";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/choice";
import { Dialog } from "./ui/dialog";
import { Input, Select } from "./ui/input";

/** A file's length or pages, as a row's end says it. */
export function fileMeasure(file: {
  kind: FileKind;
  duration?: number | null;
  pageCount?: number | null;
}): string | null {
  if ((file.kind === "audio" || file.kind === "video") && file.duration != null)
    return formatDuration(file.duration);
  if (file.kind === "document" && file.pageCount)
    return file.pageCount === 1 ? "1 page" : `${file.pageCount} pages`;
  return null;
}

/**
 * Files already in the project to put on a comment (#527), as Linear's pickers work: a search,
 * the project's folders and the files' kinds to narrow the list, a box to tick on each, and each
 * opened in its own viewer in a new tab first. Linked, a file opens in the viewer for whoever
 * reads the comment, as their own access allows; never as a download.
 */
export function FilePicker({
  projectId,
  exclude,
  chosen,
  onPick,
  onClose,
}: {
  projectId: string;
  /** The file being commented on: it is the comment's already. */
  exclude: string | null;
  /** Those already picked, ticked from the start. */
  chosen: string[];
  onPick: (files: ProjectFile[]) => void;
  onClose: () => void;
}) {
  const { data: files, error } = useQuery(projectFilesQuery(projectId));
  const { data: folders = [] } = useQuery(projectFoldersQuery(projectId));
  const { data: tracks = [] } = useQuery(projectTracksQuery(projectId));
  const { versionLabel } = useItemWords(projectId);
  const [ticked, setTicked] = useState<Set<string>>(new Set(chosen));
  const [query, setQuery] = useState("");
  const [folderId, setFolderId] = useState("");
  const [kind, setKind] = useState<FileKind | "">("");
  const rows = useMemo(
    () => pickableFiles(folders, tracks, files ?? [], exclude, versionLabel),
    [folders, tracks, files, exclude, versionLabel],
  );
  const shown = filesMatching(rows, folders, {
    query,
    folderId: folderId || null,
    kind: kind || null,
  });
  const tick = (id: string) =>
    setTicked((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const filtered = query.trim() !== "" || folderId !== "" || kind !== "";
  const row = ({ file, where }: PickableFile) => {
    const measure = fileMeasure({
      kind: file.kind,
      duration: file.mediaInfo?.duration ?? null,
      pageCount: file.pageCount ?? null,
    });
    return (
      <li
        key={file.id}
        className={cn(
          "flex items-center gap-1 border-b border-line pr-3 last:border-b-0",
          ticked.has(file.id) && "bg-raised/40",
        )}
      >
        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 self-stretch py-2 pl-3">
          <span className="flex size-6 shrink-0 items-center justify-center">
            <Checkbox
              checked={ticked.has(file.id)}
              onChange={() => tick(file.id)}
              aria-label={`Attach ${file.name}`}
            />
          </span>
          <Icon name={kindIcon[file.kind]} size={15} className="shrink-0 text-ink-3" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] text-ink">{file.name}</span>
            <span className="block truncate text-[12px] text-ink-3">{where}</span>
          </span>
          {measure && <span className="tabular shrink-0 text-[12px] text-ink-3">{measure}</span>}
        </label>
        <Link
          to="/files/$fileId"
          params={{ fileId: file.id }}
          target="_blank"
          rel="noopener"
          aria-label={`Open ${file.name} in a new tab`}
          title="Open it in a new tab"
          className="flex size-7 shrink-0 items-center justify-center rounded-control text-ink-3 no-underline hover:bg-raised hover:text-ink"
        >
          <Icon name="external" size={13} />
        </Link>
      </li>
    );
  };
  return (
    <Dialog
      title="Files from this project"
      description="Each opens in the viewer for whoever reads the comment, as their own access allows. Nothing is downloaded from it."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={ticked.size === 0}
            onClick={() => {
              onPick((files ?? []).filter((f) => ticked.has(f.id)));
              onClose();
            }}
          >
            {ticked.size > 0 ? `Attach ${ticked.size}` : "Attach"}
          </Button>
        </>
      }
    >
      {error ? (
        <p className="m-0 text-[13px] text-signal">{error.message}</p>
      ) : !files ? (
        <p className="m-0 text-[13px] text-ink-3">Loading</p>
      ) : rows.length === 0 ? (
        <p className="m-0 text-[13px] text-ink-3">
          This project has no other files yet. They are added from the project's files.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <span className="relative min-w-0 basis-full sm:flex-1 sm:basis-0">
              <Icon
                name="search"
                size={14}
                className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-3"
              />
              <Input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                // Typing here is for the search, not the player behind the dialog.
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="Search files"
                aria-label="Search files"
                className="pl-8"
              />
            </span>
            <Select
              aria-label="Folder"
              value={folderId}
              onChange={(e) => setFolderId(e.target.value)}
              className="w-auto min-w-0 flex-1 sm:max-w-44 sm:flex-none"
            >
              <option value="">All folders</option>
              {folderChoices(folders).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as FileKind | "")}
              className="w-auto min-w-0 flex-1 sm:flex-none"
            >
              <option value="">Every kind</option>
              {kindsAmong(rows).map((k) => (
                <option key={k} value={k}>
                  {kindNames[k]}
                </option>
              ))}
            </Select>
          </div>
          {shown.length === 0 ? (
            <p className="m-0 flex flex-wrap items-center gap-x-2 text-[13px] text-ink-3">
              No file matches.
              {filtered && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setQuery("");
                    setFolderId("");
                    setKind("");
                  }}
                >
                  Show every file
                </Button>
              )}
            </p>
          ) : (
            <ul
              className="scroll-quiet m-0 flex max-h-[360px] list-none flex-col overflow-auto rounded-panel border border-line p-0"
              aria-label="The project's files"
            >
              {shown.map(row)}
            </ul>
          )}
        </div>
      )}
    </Dialog>
  );
}

/**
 * The files linked to a comment (#527), each a chip with its kind and name that opens it in
 * the viewer, through the delivery path; never a download. A guest opens it in their own
 * viewer, through the review that shows them the comment.
 */
export function LinkedFiles({
  files,
  guest,
  onUnlink,
}: {
  files: LinkedFile[];
  guest: boolean;
  /** Taking one off: the comment's author, or whoever triages. */
  onUnlink?: (fileId: string) => void;
}) {
  return (
    <ul className="m-0 flex min-w-0 list-none flex-wrap gap-1.5 p-0" aria-label="Linked files">
      {files.map((f) => {
        const measure = fileMeasure(f);
        return (
          <li key={f.id} className="flex min-w-0 max-w-full items-center">
            <Link
              to={guest ? "/g/files/$fileId" : "/files/$fileId"}
              params={{ fileId: f.id }}
              title={`Open ${f.name} in the viewer`}
              className="flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-chip border border-line bg-raised/40 px-2.5 text-[12px] text-ink-2 no-underline transition-colors hover:border-edge hover:text-ink"
            >
              <Icon name={kindIcon[f.kind]} size={12} className="shrink-0 text-ink-3" />
              <span className="sr-only">Open </span>
              <span className="max-w-48 truncate">{f.name}</span>
              {measure && <span className="tabular shrink-0 text-ink-3">{measure}</span>}
            </Link>
            {onUnlink && (
              <Button
                size="iconSm"
                variant="quiet"
                aria-label={`Unlink ${f.name}`}
                title="Unlink"
                onClick={() => onUnlink(f.id)}
              >
                <Icon name="close" size={12} />
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

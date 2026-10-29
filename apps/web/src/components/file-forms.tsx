import { capital, folderPath } from "@hekate/shared";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { folderTree, nameStem, variantNameFor } from "~/lib/browser";
import { cn } from "~/lib/cn";
import { type Folder, type ProjectFile, type Track, useItemWords } from "~/lib/queries";
import { Icon } from "./icons";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Input, Select } from "./ui/input";

/** Every folder as a path ("Mixes / Stems"), for choosing where something goes. */
export function destinations(folders: Folder[], exclude: Set<string>) {
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

/**
 * A name edited in its row, as the Finder and Linear do it: the field takes the name's place,
 * with the name selected (a file's without its extension). Enter keeps the new name, Escape
 * keeps the old one, and so does leaving the field with nothing changed; leaving it with a
 * change keeps the change.
 */
export function RenameInput({
  initial,
  file,
  label = "New name",
  onSave,
  onCancel,
  className,
}: {
  initial: string;
  /** A file: its extension stays out of the selection. */
  file: boolean;
  label?: string;
  onSave: (name: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const [name, setName] = useState(initial);
  const field = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(0, nameStem(initial, file));
  }, [initial, file]);
  const finish = (commit: boolean) => {
    if (settled.current) return;
    settled.current = true;
    const next = name.trim();
    if (commit && next && next !== initial) onSave(next);
    else onCancel();
  };
  return (
    <Input
      ref={field}
      aria-label={label}
      value={name}
      maxLength={200}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setName(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
      className={cn("h-7 min-w-0 px-1.5 text-[14px]", className)}
    />
  );
}

/**
 * Put a loose file into a track: as its next version, or as another variant of its latest
 * (a wet mix beside the dry one).
 */
export function AttachForm({
  file,
  tracks,
  pending,
  onAttach,
  onCancel,
}: {
  file: ProjectFile;
  tracks: Track[];
  pending: boolean;
  onAttach: (track: Track, as: "version" | "variant", name: string) => void;
  onCancel: () => void;
}) {
  const [trackId, setTrackId] = useState(tracks[0]?.id ?? "");
  const track = tracks.find((t) => t.id === trackId);
  const { words, versionLabel } = useItemWords(tracks[0]?.projectId);
  const latest = track?.versions.at(-1);
  const [as, setAs] = useState<"version" | "variant">("version");
  const [name, setName] = useState("");
  const shown = name || (track ? variantNameFor(file.name, track.name) : "");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (track && shown.trim()) onAttach(track, latest ? as : "version", shown.trim());
      }}
      className="flex flex-wrap items-center gap-2"
      aria-label={`Attach to a ${words.track}`}
    >
      <Select
        aria-label={capital(words.track)}
        className="max-w-60"
        value={trackId}
        onChange={(e) => setTrackId(e.target.value)}
      >
        {tracks.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </Select>
      <Select
        aria-label="As"
        className="max-w-60"
        value={latest ? as : "version"}
        onChange={(e) => setAs(e.target.value as "version" | "variant")}
      >
        <option value="version">
          As {versionLabel((latest?.number ?? 0) + 1)}, a new {words.version}
        </option>
        {latest && (
          <option value="variant">
            As a {words.variant} of {versionLabel(latest.number)}
          </option>
        )}
      </Select>
      <Input
        aria-label={`${capital(words.variant)} name`}
        className="w-40"
        maxLength={80}
        value={shown}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
      />
      <Button size="sm" type="submit" disabled={pending || !track || !shown.trim()}>
        Attach
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}

/**
 * Where something goes, chosen from the project's folders drawn as a tree, for whoever would
 * rather not drag: the top of the project first, then every folder under its parent. Where
 * the things are now is marked; a folder that is moving, or sits inside one that is, cannot
 * be chosen. The arrows move through the tree, Enter moves.
 */
export function MovePicker({
  title,
  folders,
  exclude,
  current,
  pending,
  onMove,
  onClose,
}: {
  title: string;
  folders: Folder[];
  /** Folders that cannot be the destination: those moving, and everything inside them. */
  exclude: Set<string>;
  /** Where it is now: a folder, null at the top, undefined when the things are in several places. */
  current: string | null | undefined;
  pending: boolean;
  onMove: (folderId: string | null) => void;
  onClose: () => void;
}) {
  const [to, setTo] = useState<string | null>(current ?? null);
  const rows: { id: string | null; name: string; depth: number }[] = [
    { id: null, name: "Top of the project", depth: 0 },
    ...folderTree(folders).map(({ folder, depth }) => ({
      id: folder.id,
      name: folder.name,
      depth: depth + 1,
    })),
  ];
  const allowed = rows.filter((r) => r.id === null || !exclude.has(r.id));
  const move = () => {
    if (!pending && to !== current) onMove(to);
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      move();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const at = allowed.findIndex((r) => r.id === to);
    const next =
      allowed[(at + (event.key === "ArrowDown" ? 1 : -1) + allowed.length) % allowed.length];
    if (!next) return;
    setTo(next.id);
    event.currentTarget
      .querySelector<HTMLElement>(`[data-folder="${next.id ?? "top"}"]`)
      ?.focus({ preventScroll: false });
  };
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
          <Button variant="primary" disabled={pending || to === current} onClick={move}>
            Move
          </Button>
        </>
      }
    >
      <div
        role="tree"
        aria-label="Move to"
        onKeyDown={onKey}
        className="scroll-quiet -mx-2 flex max-h-80 flex-col overflow-auto"
      >
        {rows.map((row) => {
          const barred = row.id !== null && exclude.has(row.id);
          const here = row.id === current;
          const chosen = row.id === to;
          return (
            <button
              key={row.id ?? "top"}
              type="button"
              role="treeitem"
              aria-selected={chosen}
              aria-level={row.depth + 1}
              aria-disabled={barred || undefined}
              data-folder={row.id ?? "top"}
              tabIndex={chosen ? 0 : -1}
              onClick={() => !barred && setTo(row.id)}
              onDoubleClick={() => !barred && !here && onMove(row.id)}
              style={{ paddingLeft: 8 + row.depth * 18 }}
              className={cn(
                "flex h-8 w-full items-center gap-2 rounded-control pr-2 text-left text-[13px] transition-colors",
                barred
                  ? "cursor-not-allowed text-ink-3/60"
                  : chosen
                    ? "bg-raised text-ink"
                    : "text-ink-2 hover:bg-raised/50 hover:text-ink",
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
 * The score beside a track's recordings, chosen from the project's PDFs, or none; as its
 * versions page chooses it, for those who organise.
 */
export function ScoreForm({
  scores,
  current,
  pending,
  onChoose,
  onCancel,
}: {
  scores: ProjectFile[];
  current: string | null;
  pending: boolean;
  onChoose: (scoreFileId: string | null) => void;
  onCancel: () => void;
}) {
  const [to, setTo] = useState(current ?? scores[0]?.id ?? "");
  if (scores.length === 0)
    return (
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-ink-2">No score: upload its PDF to link one.</span>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Close
        </Button>
      </span>
    );
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onChoose(to || null);
      }}
      className="flex flex-wrap items-center gap-2"
      aria-label="Link a score"
    >
      <Select
        aria-label="Score"
        className="max-w-72"
        value={to}
        onChange={(e) => setTo(e.target.value)}
      >
        {current && <option value="">No score</option>}
        {scores.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </Select>
      <Button size="sm" type="submit" disabled={pending || to === (current ?? "")}>
        {to ? "Link" : "Unlink"}
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}

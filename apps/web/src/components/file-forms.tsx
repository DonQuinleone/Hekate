import { capital, folderPath } from "@hekate/shared";
import { type FormEvent, useState } from "react";
import { variationNameFor } from "~/lib/browser";
import { type Folder, type ProjectFile, type Track, useItemWords } from "~/lib/queries";
import { Button } from "./ui/button";
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

export function RenameForm({
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

/**
 * Put a loose file into a track: as its next version, or as another variation of its latest
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
  onAttach: (track: Track, as: "version" | "variation", name: string) => void;
  onCancel: () => void;
}) {
  const [trackId, setTrackId] = useState(tracks[0]?.id ?? "");
  const track = tracks.find((t) => t.id === trackId);
  const { words, versionLabel } = useItemWords(tracks[0]?.projectId);
  const latest = track?.versions.at(-1);
  const [as, setAs] = useState<"version" | "variation">("version");
  const [name, setName] = useState("");
  const shown = name || (track ? variationNameFor(file.name, track.name) : "");
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
        onChange={(e) => setAs(e.target.value as "version" | "variation")}
      >
        <option value="version">
          As {versionLabel((latest?.number ?? 0) + 1)}, a new {words.version}
        </option>
        {latest && (
          <option value="variation">
            As a {words.variation} of {versionLabel(latest.number)}
          </option>
        )}
      </Select>
      <Input
        aria-label={`${capital(words.variation)} name`}
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

export function MoveForm({
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

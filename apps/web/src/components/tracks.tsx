import { variationNameFrom } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { cn } from "~/lib/cn";
import {
  type FileDetail,
  projectFilesQuery,
  projectTracksQuery,
  type Track,
  trackQuery,
  useProjectCan,
  useTrackMutations,
  type Version,
} from "~/lib/queries";
import { Icon } from "./icons";
import { Button } from "./ui/button";

const dateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

/** "Version 3 · Dry, Wet" for a track's latest version. */
function latestLabel(track: Track): string {
  const latest = track.versions.at(-1);
  if (!latest) return "No versions yet";
  return `Version ${latest.number} · ${latest.variations.map((v) => v.name).join(", ")}`;
}

/** The file a version opens with: its primary variation. */
const primaryOf = (version: Version) =>
  version.variations.find((v) => v.isPrimary) ?? version.variations[0];

function NewTrack({ projectId }: { projectId: string }) {
  const { createTrack } = useTrackMutations(projectId);
  const [name, setName] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    createTrack.mutate({ name }, { onSuccess: () => setName("") });
  };
  return (
    <form onSubmit={submit} className="flex items-center gap-2">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="New track, for example Maple Leaf Rag"
        aria-label="New track name"
        className="h-8 w-72 max-w-full rounded-control border border-edge bg-ground px-3 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-ink-3"
      />
      <Button type="submit" size="md" disabled={!name.trim() || createTrack.isPending}>
        <Icon name="plus" size={14} />
        Add track
      </Button>
      {createTrack.error && (
        <span className="text-xs text-signal">{createTrack.error.message}</span>
      )}
    </form>
  );
}

/** The tracks of a music project, each with its latest version. */
export function TrackList({ projectId }: { projectId: string }) {
  const { data: tracks, error } = useQuery(projectTracksQuery(projectId));
  const can = useProjectCan(projectId);
  return (
    <section aria-label="Tracks" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="m-0 text-[15px] font-medium">Tracks</h2>
        {can("organise") && <NewTrack projectId={projectId} />}
      </div>
      {error && <p className="m-0 text-xs text-signal">{error.message}</p>}
      {tracks && tracks.length === 0 && (
        <p className="m-0 text-[13px] text-ink-3">
          {can("organise")
            ? "Add a track for each piece, then add its versions from the uploaded files."
            : "No tracks yet."}
        </p>
      )}
      {tracks && tracks.length > 0 && (
        <ul className="m-0 flex list-none flex-col p-0">
          {tracks.map((track, i) => (
            <li
              key={track.id}
              className="grid min-h-12 grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 border-b border-hairline px-2 py-2"
            >
              <span className="tabular font-mono text-xs text-ink-3">
                {String(i + 1).padStart(2, "0")}
              </span>
              <Link
                to="/tracks/$trackId"
                params={{ trackId: track.id }}
                className="truncate text-sm font-medium text-ink no-underline hover:text-signal"
              >
                {track.name}
              </Link>
              <span className="truncate text-xs text-ink-2">{latestLabel(track)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Choose files for a new version: each becomes a variation; one is primary. */
function NewVersion({ track }: { track: Track }) {
  const { data: files } = useQuery(projectFilesQuery(track.projectId));
  const { data: tracks } = useQuery(projectTracksQuery(track.projectId));
  const { createVersion } = useTrackMutations(track.projectId);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [primary, setPrimary] = useState<string | null>(null);
  const [notes, setNotes] = useState("");

  // Audio and video not yet a variation anywhere in the project.
  const used = new Set(
    (tracks ?? []).flatMap((t) => t.versions.flatMap((v) => v.variations.map((x) => x.fileId))),
  );
  const candidates = (files ?? []).filter(
    (f) => (f.kind === "audio" || f.kind === "video") && !used.has(f.id),
  );
  const ids = Object.keys(chosen);
  const next = (track.versions.at(-1)?.number ?? 0) + 1;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ids.length === 0) return;
    createVersion.mutate(
      {
        trackId: track.id,
        notes: notes.trim() || undefined,
        variations: ids.map((fileId) => ({
          fileId,
          name: chosen[fileId] ?? "Main",
          primary: fileId === (primary ?? ids[0]),
        })),
      },
      {
        onSuccess: () => {
          setChosen({});
          setPrimary(null);
          setNotes("");
        },
      },
    );
  };

  return (
    <form
      onSubmit={submit}
      aria-label="New version"
      className="flex flex-col gap-3 rounded-panel border border-hairline bg-surface p-4"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="m-0 text-[15px] font-medium">Version {next}</h2>
        <span className="text-xs text-ink-3">Choose its files; each becomes a variation</span>
      </div>
      {candidates.length === 0 ? (
        <p className="m-0 text-[13px] text-ink-3">
          Every audio and video file in this project is already a variation. Upload the new edit to
          the project first.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {candidates.map((file) => {
            const on = file.id in chosen;
            return (
              <li
                key={file.id}
                className="grid grid-cols-[auto_minmax(0,1fr)_160px_auto] items-center gap-3 border-b border-hairline py-2"
              >
                <input
                  type="checkbox"
                  checked={on}
                  aria-label={`Use ${file.name}`}
                  onChange={() =>
                    setChosen((c) => {
                      const copy = { ...c };
                      if (on) delete copy[file.id];
                      else copy[file.id] = variationNameFrom(file.name, track.name);
                      return copy;
                    })
                  }
                  className="accent-signal"
                />
                <span className="truncate text-[13px] text-ink">{file.name}</span>
                <input
                  value={chosen[file.id] ?? ""}
                  disabled={!on}
                  onChange={(e) => setChosen((c) => ({ ...c, [file.id]: e.target.value }))}
                  aria-label={`Variation name for ${file.name}`}
                  placeholder="Variation"
                  className="h-7 rounded-control border border-edge bg-ground px-2 text-xs text-ink outline-none disabled:opacity-40"
                />
                <label
                  className={cn(
                    "flex items-center gap-1.5 text-xs",
                    on ? "text-ink-2" : "text-ink-3 opacity-40",
                  )}
                >
                  <input
                    type="radio"
                    name="primary"
                    disabled={!on}
                    checked={on && file.id === (primary ?? ids[0])}
                    onChange={() => setPrimary(file.id)}
                    className="accent-signal"
                  />
                  Primary
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <input
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes for this version (optional)"
        aria-label="Version notes"
        className="h-8 rounded-control border border-edge bg-ground px-3 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-ink-3"
      />
      <div className="flex items-center justify-end gap-3">
        {createVersion.error && (
          <span className="text-xs text-signal">{createVersion.error.message}</span>
        )}
        <Button
          type="submit"
          variant="primary"
          disabled={ids.length === 0 || createVersion.isPending}
        >
          Add version {next}
        </Button>
      </div>
    </form>
  );
}

function VersionRow({ version, projectId }: { version: Version; projectId: string }) {
  const { makePrimary } = useTrackMutations(projectId);
  const can = useProjectCan(projectId);
  return (
    <li className="grid grid-cols-1 gap-3 border-b border-hairline py-4 sm:grid-cols-[120px_minmax(0,1fr)]">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-ink">Version {version.number}</span>
        <span className="tabular text-xs text-ink-3">
          {dateFormat.format(new Date(version.createdAt))}
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        {version.notes && <p className="m-0 text-[13px] text-ink-2">{version.notes}</p>}
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
          {version.variations.map((v) => (
            <li
              key={v.id}
              className={cn(
                "flex items-center gap-2 rounded-control border px-2.5 py-1.5",
                v.isPrimary ? "border-edge bg-raised" : "border-hairline",
              )}
            >
              <Link
                to="/files/$fileId"
                params={{ fileId: v.fileId }}
                className="text-[13px] text-ink no-underline hover:text-signal"
                title={v.fileName}
              >
                {v.name}
              </Link>
              {v.isPrimary ? (
                <span className="label text-[10px]">Primary</span>
              ) : (
                can("organise") && (
                  <button
                    type="button"
                    onClick={() => makePrimary.mutate(v.id)}
                    className="cursor-pointer border-0 bg-transparent p-0 text-[11px] text-ink-3 hover:text-ink"
                  >
                    Make primary
                  </button>
                )
              )}
            </li>
          ))}
        </ul>
      </div>
    </li>
  );
}

/** One track: its versions, newest first, and adding the next. */
export function TrackView({ trackId }: { trackId: string }) {
  const { data: track, error } = useQuery(trackQuery(trackId));
  const can = useProjectCan(track?.projectId);
  if (error) return <p className="m-0 text-signal">{error.message}</p>;
  if (!track) return <p className="m-0 text-ink-3">Loading</p>;
  const newest = [...track.versions].reverse();
  return (
    <div className="flex flex-col gap-6">
      {newest.length > 0 ? (
        <ul
          className="m-0 flex list-none flex-col border-t border-hairline p-0"
          aria-label="Versions"
        >
          {newest.map((v) => (
            <VersionRow key={v.id} version={v} projectId={track.projectId} />
          ))}
        </ul>
      ) : (
        <p className="m-0 text-[13px] text-ink-3">No versions yet. Add the first edit below.</p>
      )}
      {can("upload") && <NewVersion track={track} />}
    </div>
  );
}

/**
 * On a file that is a variation: where it sits (track and version), its sibling variations
 * and the track's other versions, each one step away.
 */
export function FileContext({ file }: { file: FileDetail }) {
  const variation = file.variation;
  const { data: track } = useQuery({
    ...trackQuery(variation?.trackId ?? ""),
    enabled: Boolean(variation),
  });
  if (!variation) return null;
  const version = track?.versions.find((v) => v.id === variation.versionId);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px]">
        <Link
          to="/tracks/$trackId"
          params={{ trackId: variation.trackId }}
          className="font-medium text-ink no-underline hover:text-signal"
        >
          {variation.trackName}
        </Link>
        {track && track.versions.length > 0 && (
          <nav aria-label="Versions" className="flex flex-wrap items-center gap-1">
            {track.versions.map((v) => {
              const target = primaryOf(v);
              const current = v.id === variation.versionId;
              return target ? (
                <Link
                  key={v.id}
                  to="/files/$fileId"
                  params={{ fileId: current ? file.id : target.fileId }}
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "tabular h-6 rounded-chip border px-2 font-mono text-[11px] leading-6 no-underline",
                    current
                      ? "border-edge bg-raised text-ink"
                      : "border-transparent text-ink-3 hover:text-ink",
                  )}
                >
                  V{v.number}
                </Link>
              ) : null;
            })}
          </nav>
        )}
      </div>
      {version && version.variations.length > 1 && (
        <nav aria-label="Variations" className="flex flex-wrap items-center gap-1">
          {version.variations.map((v) => (
            <Link
              key={v.id}
              to="/files/$fileId"
              params={{ fileId: v.fileId }}
              aria-current={v.fileId === file.id ? "page" : undefined}
              className={cn(
                "h-7 rounded-chip border px-2.5 text-xs leading-7 no-underline",
                v.fileId === file.id
                  ? "border-edge bg-raised text-ink"
                  : "border-transparent text-ink-3 hover:text-ink",
              )}
            >
              {v.name}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}

import { type AlignmentPoints, mapTime } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, type MouseEvent, useState } from "react";
import { cn } from "~/lib/cn";
import { formatDates } from "~/lib/locale";
import {
  alignmentsQuery,
  type FileDetail,
  projectTracksQuery,
  type Track,
  trackQuery,
  useProjectCan,
  useTrackMutations,
  type Version,
} from "~/lib/queries";
import { Icon } from "./icons";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const _dateFormat = formatDates({ day: "numeric", month: "short" });

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
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="New track, for example Maple Leaf Rag"
        aria-label="New track name"
        className="h-8 w-72 max-w-full text-[13px]"
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

/**
 * Where to start in another file for this moment here: the same music where the two are
 * aligned, otherwise the same time. Rounded to the millisecond for the address.
 */
export function positionIn(
  fileId: string,
  at: number,
  alignments: readonly { fileId: string; points: AlignmentPoints }[],
): number {
  const aligned = alignments.find((a) => a.fileId === fileId);
  const there = aligned ? mapTime(aligned.points, at) : at;
  return Math.max(0, Math.round(there * 1000) / 1000);
}

/**
 * On a file that is a variation: where it sits (track and version), its sibling variations
 * and the track's other versions, each one step away.
 */
export function FileContext({
  file,
  media = null,
}: {
  file: FileDetail;
  /** The player, whose position goes along to the version or variation chosen (#15). */
  media?: HTMLMediaElement | null;
}) {
  const variation = file.variation;
  const navigate = useNavigate();
  const { data: track } = useQuery({
    ...trackQuery(variation?.trackId ?? ""),
    enabled: Boolean(variation),
  });
  // Where the same music sits in the other versions, where the audio has said; refused
  // without the compare tool, when the same time serves.
  const { data: alignments = [] } = useQuery({
    ...alignmentsQuery(file.id),
    enabled: Boolean(variation),
    retry: false,
  });
  if (!variation) return null;
  /** Go to another version or variation, at the same music; a modified click opens it as is. */
  const follow = (fileId: string) => (event: MouseEvent) => {
    if (!media || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    void navigate({
      to: "/files/$fileId",
      params: { fileId },
      search: (prev) => ({
        loop: prev.loop,
        review: prev.review,
        t: positionIn(fileId, media.currentTime, alignments),
      }),
    });
  };
  const version = track?.versions.find((v) => v.id === variation.versionId);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px]">
        {/* The track itself is in the page's breadcrumb; here, only where to go within it. */}
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
                  // A loop and the review it came from hold while switching version or variation.
                  search={(prev) => ({ loop: prev.loop, review: prev.review })}
                  onClick={current ? undefined : follow(target.fileId)}
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
              // A loop and the review it came from hold while switching version or variation.
              search={(prev) => ({ loop: prev.loop, review: prev.review })}
              onClick={v.fileId === file.id ? undefined : follow(v.fileId)}
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

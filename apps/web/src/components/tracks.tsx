import { type AlignmentPoints, capital, mapTime, versionLabel } from "@hekate/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { cn } from "~/lib/cn";
import { formatDates } from "~/lib/locale";
import {
  alignmentsQuery,
  type FileDetail,
  fileQuery,
  projectTracksQuery,
  type Track,
  trackQuery,
  trackTakesQuery,
  useItemWords,
  useProjectCan,
  useTrackMutations,
} from "~/lib/queries";
import { variationChoices, versionChoices } from "~/lib/versions";
import { Avatar } from "./avatar";
import { Icon } from "./icons";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Dropdown } from "./ui/menu";
import { Segmented } from "./ui/segmented";
import { VariationDialog } from "./variation-dialog";

const noteDate = formatDates({
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** "Version 3 · Dry, Wet" for a track's latest version. */
function latestLabel(track: Track): string {
  const latest = track.versions.at(-1);
  if (!latest) return "No versions yet";
  return `Version ${latest.number} · ${latest.variations.map((v) => v.name).join(", ")}`;
}

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
 * The track's score switch, at the end of the strip above the player (#15): offered only
 * where the score opens, since a review may leave it out.
 */
export function ScoreSwitch({
  file,
  shown,
  onToggle,
}: {
  file: FileDetail;
  shown: boolean;
  onToggle: () => void;
}) {
  const scoreFileId = file.variation?.scoreFileId;
  const { data: scoreFile } = useQuery({
    ...fileQuery(scoreFileId ?? ""),
    enabled: Boolean(scoreFileId),
    retry: false,
  });
  if (!scoreFile) return null;
  return (
    <Button
      variant="ghost"
      size="md"
      aria-pressed={shown}
      onClick={onToggle}
      className={cn(shown && "bg-raised text-ink")}
    >
      <Icon name="score" size={14} />
      Score
    </Button>
  );
}

/**
 * On a file that is a variation (#15): what leads the strip above the player, as the
 * prototype draws it. The version menu (the track's versions, newest first, then the way to
 * all of them and their notes, and to its takes) and the variation switch. A version or
 * variation chosen starts at the same music as here, where the audio has said where that is,
 * else at the same time. A guest, who sees only what their review holds, is told which
 * version that is. Whoever may upload adds a variation from the switch itself (#486): it
 * shows the new one as analysing, and opens it once it plays.
 */
export function FileContext({
  file,
  media = null,
  guest = false,
  takes = false,
}: {
  file: FileDetail;
  /** The player, whose position goes along to the version or variation chosen (#15). */
  media?: HTMLMediaElement | null;
  guest?: boolean;
  /** Whether the version menu offers the track's takes: for those who may see them. */
  takes?: boolean;
}) {
  const variation = file.variation;
  const navigate = useNavigate();
  const { data: track } = useQuery({
    ...trackQuery(variation?.trackId ?? ""),
    enabled: Boolean(variation) && !guest,
  });
  // Where the same music sits in the other versions, where the audio has said; refused
  // without the compare tool, when the same time serves.
  const { data: alignments = [] } = useQuery({
    ...alignmentsQuery(file.id),
    enabled: Boolean(variation) && !guest,
    retry: false,
  });
  const { data: takeRows = [] } = useQuery({
    ...trackTakesQuery(variation?.trackId ?? ""),
    enabled: Boolean(variation) && takes && !guest,
  });
  const { words } = useItemWords(guest ? undefined : track?.projectId);
  const can = useProjectCan(guest ? undefined : track?.projectId);
  const client = useQueryClient();
  const [adding, setAdding] = useState(false);
  /** A variation just added, being prepared: the player follows it once it plays. */
  const [pending, setPending] = useState<string | null>(null);
  const { data: awaited } = useQuery({
    ...fileQuery(pending ?? ""),
    enabled: Boolean(pending),
    retry: false,
  });
  const status = awaited && awaited.id === pending ? awaited.streamStatus : null;
  /** Go to another version or variation, at the same music. */
  const go = (fileId: string) =>
    void navigate({
      to: "/files/$fileId",
      params: { fileId },
      // A loop and the review it came from hold while switching version or variation.
      search: (prev) => ({
        loop: prev.loop,
        review: prev.review,
        ...(media ? { t: positionIn(fileId, media.currentTime, alignments) } : {}),
      }),
    });
  const trackId = variation?.trackId;
  useEffect(() => {
    if (!pending || status === null || status === "pending") return;
    // Ready, it is opened at the same moment as here; failed, the switch says so and we stay.
    setPending(null);
    if (trackId) void client.invalidateQueries({ queryKey: ["tracks", trackId] });
    if (status === "ready") go(pending);
  });
  if (!variation) return null;
  const label = (n: number) => versionLabel(n, file.profile);
  const version = track?.versions.find((v) => v.id === variation.versionId);
  const choices = track
    ? versionChoices(track.versions, {
        versionId: variation.versionId,
        variationName: variation.name,
      })
    : [];
  const shown = choices.find((c) => c.current);
  const mayAdd = !guest && Boolean(track) && can("upload");
  if (guest)
    return (
      <span className="text-[13px] text-ink-3">
        {label(variation.versionNumber)} is under review
      </span>
    );
  return (
    <>
      {/* The track itself is in the page's breadcrumb; here, only where to go within it. */}
      {shown && (
        <Dropdown
          // "Cut 3" says what it is already; "V2" is read as "Version V2".
          label={file.profile === "video" ? undefined : capital(words.version)}
          value={
            <span className="tabular flex items-center gap-1.5 font-medium text-ink">
              {label(shown.number)}
              {shown.latest && <span className="font-normal text-ink-3">latest</span>}
            </span>
          }
          actions={[
            ...choices.map((c) => ({
              label: label(c.number),
              hint: c.hint,
              checked: c.current,
              onSelect: () => {
                if (!c.current) go(c.fileId);
              },
            })),
            "divider" as const,
            {
              label: `All ${words.versions} and notes`,
              onSelect: () =>
                void navigate({
                  to: "/tracks/$trackId",
                  params: { trackId: variation.trackId },
                  search: { view: "versions" },
                }),
            },
            ...(takes && takeRows.length > 0
              ? [
                  {
                    label: "Takes",
                    onSelect: () =>
                      void navigate({
                        to: "/tracks/$trackId",
                        params: { trackId: variation.trackId },
                        search: { view: "takes" },
                      }),
                  },
                ]
              : []),
          ]}
        />
      )}
      {version && (version.variations.length > 1 || mayAdd) && (
        <Segmented
          label={capital(words.variation)}
          value={file.id}
          options={variationChoices(version)}
          onChange={(fileId) => {
            if (fileId !== file.id) go(fileId);
          }}
          action={
            mayAdd
              ? {
                  label: `Add a ${words.variation}…`,
                  icon: <Icon name="plus" size={14} />,
                  onSelect: () => setAdding(true),
                }
              : undefined
          }
        />
      )}
      {adding && track && version && (
        <VariationDialog
          track={track}
          version={version}
          mode="add"
          onClose={() => setAdding(false)}
          onAdded={setPending}
        />
      )}
    </>
  );
}

/**
 * The note its uploader left on the version heard, under the player (#15): who, which
 * version and when, and what they said.
 */
export function VersionNote({ file }: { file: FileDetail }) {
  const variation = file.variation;
  const { data: track } = useQuery({
    ...trackQuery(variation?.trackId ?? ""),
    enabled: Boolean(variation),
  });
  const version = track?.versions.find((v) => v.id === variation?.versionId);
  if (!version?.notes) return null;
  const by = version.createdByName ?? version.sentBy ?? null;
  return (
    <div className="flex shrink-0 items-start gap-2.5 border-t border-line px-3 py-2.5 lg:px-4">
      {by && <Avatar id={by} name={by} size={22} />}
      <p className="m-0 min-w-0 text-[13px] text-ink-2">
        {by && <span className="font-medium text-ink">{by}</span>}
        <span className="text-ink-3">
          {by ? " · " : ""}
          {versionLabel(version.number, file.profile)},{" "}
          {noteDate.format(new Date(version.createdAt))}
        </span>
        <span className="block">{version.notes}</span>
      </p>
    </div>
  );
}

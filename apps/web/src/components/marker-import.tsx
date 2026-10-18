import {
  type FrameRateId,
  formatClock,
  frameRates,
  type ListedMarker,
  type MarkerList,
  MarkerListError,
  type MediaInfo,
  markerBody,
  markerListFormats,
  markerProblem,
  nearestFrameRate,
  readMarkerList,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type DragEvent, useRef, useState } from "react";
import { Icon } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { FileInput, Select } from "~/components/ui/input";
import { cn } from "~/lib/cn";
import { categoriesQuery, mentionableQuery, meQuery, useCommentMutations } from "~/lib/queries";

/** A marker list larger than this is no marker list. */
const MAX_LIST_BYTES = 5 * 1024 * 1024;

/**
 * Where a list's timeline starts, on the hour, as its timecode reads: 01:00:00:00. Drop frame
 * and 23.976 put the hour a little either side of 3,600 seconds, so it is rounded.
 */
const hourTimecode = (seconds: number) =>
  `${String(Math.round(seconds / 3600)).padStart(2, "0")}:00:00:00`;

interface Chosen {
  name: string;
  bytes: Uint8Array;
}

/** A row of the preview: what the marker says, and why it cannot come in, if it cannot. */
function Row({ marker, problem }: { marker: ListedMarker; problem: string | null }) {
  const firstLine = markerBody(marker).split("\n")[0] ?? "";
  return (
    <li className={cn("flex items-center gap-3 px-3 py-1.5", problem && "text-signal")}>
      <span className="tabular w-20 shrink-0">
        {marker.start === null ? marker.time || "?" : formatClock(marker.start)}
      </span>
      <span className="min-w-0 flex-1 truncate text-ink-2">{firstLine || "(nothing)"}</span>
      {marker.colour && <span className="shrink-0 text-ink-3">{marker.colour}</span>}
      {problem && <span className="shrink-0">{problem}</span>}
    </li>
  );
}

/**
 * A marker list from a DAW or an NLE, read back as comments (#134): read here, by the same
 * code whatever it came from, and shown before anything is sent; the markers chosen go to
 * the server, which checks them like any comment. Whose they were, where they sit, and which
 * category each colour becomes are the importer's to say.
 */
export function ImportMarkersDialog({
  file,
  onClose,
}: {
  file: { id: string; name: string; projectId: string; mediaInfo: MediaInfo | null };
  onClose: () => void;
}) {
  const { data: me } = useQuery(meQuery);
  const { data: people = [] } = useQuery(mentionableQuery(file.id));
  const { data: categories = [] } = useQuery(categoriesQuery(file.projectId));
  const { importMarkers } = useCommentMutations(file.id);
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [rate, setRate] = useState<FrameRateId | null>(null);
  const [author, setAuthor] = useState("");
  const [whole, setWhole] = useState(false);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const duration = file.mediaInfo?.duration ?? null;
  let list: MarkerList | null = null;
  let unreadable: string | null = error;
  if (chosen) {
    try {
      const ownFps = file.mediaInfo?.video?.fps;
      list = readMarkerList(chosen.bytes, {
        rate: rate ?? (ownFps ? nearestFrameRate(ownFps) : null),
        sampleRate: file.mediaInfo?.audio?.sampleRate ?? null,
      });
    } catch (e) {
      unreadable =
        e instanceof MarkerListError ? e.message : "This is not a marker list Hekate can read";
    }
  }
  const rows = (list?.markers ?? []).map((marker) => ({
    marker,
    problem: markerProblem(marker, duration),
  }));
  const usable = rows.filter((r) => r.problem === null);
  const colours = [...new Set(usable.flatMap((r) => (r.marker.colour ? [r.marker.colour] : [])))];
  const authorId = author || me?.user.id || "";

  const choose = async (files: FileList | null) => {
    const picked = files?.[0];
    if (!picked) return;
    setError(null);
    setRate(null);
    setMapping({});
    if (picked.size > MAX_LIST_BYTES) {
      setChosen(null);
      setError("A marker list can be at most 5 MB");
      return;
    }
    setChosen({ name: picked.name, bytes: new Uint8Array(await picked.arrayBuffer()) });
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    void choose(event.dataTransfer.files);
  };
  const submit = () => {
    if (!chosen || usable.length === 0) return;
    importMarkers.mutate(
      {
        listName: chosen.name,
        ...(authorId && authorId !== me?.user.id ? { authorId } : {}),
        markers: usable.map(({ marker }) => ({
          start: whole ? null : marker.start,
          end: whole ? null : marker.end,
          body: markerBody(marker),
          categoryId: (marker.colour && mapping[marker.colour]) || null,
        })),
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Dialog
      title="Import a marker list"
      description="Pro Tools, Nuendo, Reaper, Final Cut Pro, DaVinci Resolve, Premiere Pro, Avid, CSV or plain text."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={usable.length === 0 || importMarkers.isPending}
            onClick={submit}
          >
            {usable.length === 0
              ? "Import"
              : `Import ${usable.length} ${usable.length === 1 ? "comment" : "comments"}`}
          </Button>
        </>
      }
    >
      <FileInput
        ref={input}
        aria-label="Marker list"
        onChange={(e) => {
          void choose(e.target.files);
          e.target.value = "";
        }}
      />
      {!list ? (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => input.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={drop}
            className={cn(
              "flex w-full cursor-pointer flex-col items-center gap-2 rounded-panel border border-dashed px-6 py-10 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-3",
              over ? "border-ink-3 bg-raised/40" : "border-edge hover:bg-raised/40",
            )}
          >
            <Icon name="upload" size={20} className="text-ink-3" />
            <span className="text-[14px] text-ink">Drop the marker list here, or choose it</span>
            <span className="text-[13px] text-ink-3">The format is read from the file.</span>
          </button>
          {unreadable && (
            <p role="alert" className="text-[13px] text-signal">
              {chosen ? `${chosen.name}: ` : ""}
              {unreadable}
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex min-w-0 items-center gap-2 text-[13px] text-ink-2">
            <Icon name="file" size={14} className="shrink-0 text-ink-3" />
            <span className="min-w-0 flex-1 break-words">
              {chosen?.name} · {markerListFormats[list.format]} · {rows.length}{" "}
              {rows.length === 1 ? "marker" : "markers"}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              onClick={() => input.current?.click()}
            >
              Choose another
            </Button>
          </div>
          <div className="grid gap-4 @md/app:grid-cols-2">
            <Field label="Author">
              <Select value={authorId} onChange={(e) => setAuthor(e.target.value)}>
                {me && !people.some((p) => p.id === me.user.id) && (
                  <option value={me.user.id}>{me.user.name}</option>
                )}
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Anchor">
              <Select
                value={whole ? "whole" : "time"}
                onChange={(e) => setWhole(e.target.value === "whole")}
              >
                <option value="time">At the marker's time</option>
                <option value="whole">Whole file</option>
              </Select>
            </Field>
            {/* Once the rate is chosen here the list no longer guesses it; the choice stays. */}
            {(list.rateGuessed || rate !== null) && list.rate && (
              <Field
                label="Timecode rate"
                hint={`${rate === null ? "Worked out from the list's frames" : "As chosen"}${list.startsAt > 0 ? `; its timeline starts at ${hourTimecode(list.startsAt)}` : ""}.`}
              >
                <Select value={list.rate} onChange={(e) => setRate(e.target.value as FrameRateId)}>
                  {(Object.keys(frameRates) as FrameRateId[]).map((id) => (
                    <option key={id} value={id}>
                      {frameRates[id].label} fps
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
          {colours.length > 0 && categories.length > 0 && (
            <div className="flex flex-col gap-1.5 text-[13px] text-ink-2">
              Colours become categories
              {colours.map((colour) => (
                <span key={colour} className="flex items-center gap-3">
                  <span className="w-24 truncate text-ink">{colour}</span>
                  <Select
                    aria-label={`Category for ${colour}`}
                    value={mapping[colour] ?? ""}
                    onChange={(e) => setMapping((m) => ({ ...m, [colour]: e.target.value }))}
                    className="w-48"
                  >
                    <option value="">No category</option>
                    {categories.map((k) => (
                      <option key={k.id} value={k.id}>
                        {k.name}
                      </option>
                    ))}
                  </Select>
                </span>
              ))}
            </div>
          )}
          <ul
            aria-label="Markers"
            // A long list scrolls, and can be reached to scroll from the keyboard.
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region needs focus.
            tabIndex={0}
            className="m-0 flex max-h-56 list-none flex-col divide-y divide-line overflow-y-auto rounded-panel border border-line bg-sunken p-0 text-[12px]"
          >
            {rows.map(({ marker, problem }) => (
              <Row key={marker.row} marker={marker} problem={problem} />
            ))}
          </ul>
          {importMarkers.error && (
            <p role="alert" className="text-[13px] text-signal">
              {importMarkers.error.message}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

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
import { useState } from "react";
import { Field } from "~/components/ui/field";
import { Select } from "~/components/ui/input";
import { type ChosenFile, UploadDialog } from "~/components/ui/upload-dialog";
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
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [rate, setRate] = useState<FrameRateId | null>(null);
  const [author, setAuthor] = useState("");
  const [whole, setWhole] = useState(false);
  const [mapping, setMapping] = useState<Record<string, string>>({});

  const duration = file.mediaInfo?.duration ?? null;
  let list: MarkerList | null = null;
  let unreadable: string | null = null;
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
  const authorName =
    people.find((p) => p.id === authorId)?.name ?? (authorId === me?.user.id ? me?.user.name : "");

  /** The list is read in the page as soon as it is chosen; taking it off starts over. */
  const choose = async (files: ChosenFile[]) => {
    const picked = files[0]?.file;
    setRate(null);
    setMapping({});
    if (!picked) {
      setChosen(null);
      return;
    }
    setChosen({ name: picked.name, bytes: new Uint8Array(await picked.arrayBuffer()) });
  };
  const submit = async () => {
    if (!chosen || usable.length === 0) return;
    await importMarkers.mutateAsync({
      listName: chosen.name,
      ...(authorId && authorId !== me?.user.id ? { authorId } : {}),
      markers: usable.map(({ marker }) => ({
        start: whole ? null : marker.start,
        end: whole ? null : marker.end,
        body: markerBody(marker),
        categoryId: (marker.colour && mapping[marker.colour]) || null,
      })),
    });
    onClose();
  };

  return (
    <UploadDialog
      title="Import a marker list"
      description="Pro Tools, Nuendo, Reaper, Final Cut Pro, DaVinci Resolve, Premiere Pro, Avid, CSV or plain text."
      onClose={onClose}
      inputLabel="Marker list"
      prompt="Drop the marker list here, or choose it"
      hint="The format is read from the file."
      check={(f) => (f.size > MAX_LIST_BYTES ? "A marker list can be at most 5 MB" : null)}
      onChange={(files) => void choose(files)}
      action={
        usable.length === 0
          ? "Import"
          : `Import ${usable.length} ${usable.length === 1 ? "comment" : "comments"}`
      }
      disabled={usable.length === 0}
      onSubmit={submit}
      error={unreadable && chosen ? `${chosen.name}: ${unreadable}` : null}
      fields={
        list && (
          <>
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
                  <Select
                    value={list.rate}
                    onChange={(e) => setRate(e.target.value as FrameRateId)}
                  >
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
          </>
        )
      }
      what={
        list &&
        `${markerListFormats[list.format]} · ${rows.length} ${rows.length === 1 ? "marker" : "markers"} · ${usable.length} become ${usable.length === 1 ? "a comment" : "comments"}${authorName ? ` by ${authorName}` : ""}${whole ? " on the whole file" : " at their times"}, each saying the list it came from.`
      }
    >
      {list && (
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
      )}
    </UploadDialog>
  );
}

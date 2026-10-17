import {
  barsLabel,
  barsOf,
  clockOf,
  coverageGaps,
  formatDuration,
  gapsLabel,
  parseClock,
  TAKE_RATING_MAX,
  type TakeChange,
  type TakeRow,
  takeProblem,
  takesCovering,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type DragEvent, type FormEvent, useRef, useState } from "react";
import { cn } from "~/lib/cn";
import { type Track, trackTakesQuery, useProjectCan, useTakeMutations } from "~/lib/queries";
import { uploadFile } from "~/lib/upload";
import { Empty } from "./empty";
import { Icon } from "./icons";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/choice";
import { Dialog } from "./ui/dialog";
import { Field } from "./ui/field";
import { FileInput, Input, Select, Textarea } from "./ui/input";
import { ActionMenu } from "./ui/menu";
import { Segmented } from "./ui/segmented";

/** A take's rating as five dots, filled to the mark. */
export function Rating({ value }: { value: number }) {
  return (
    <span
      role="img"
      className="inline-flex gap-[3px]"
      aria-label={value ? `Rated ${value} of ${TAKE_RATING_MAX}` : "Not rated"}
    >
      {Array.from({ length: TAKE_RATING_MAX }, (_, i) => (
        <span
          key={String(i)}
          className={cn(
            "size-[6px] rounded-full",
            i < value ? "bg-ink" : "border border-edge-strong",
          )}
        />
      ))}
    </span>
  );
}

/** Where the bar ruler ends: past the last bar any take reaches, on a ten. */
const rulerEnd = (takes: TakeRow[]) =>
  Math.max(16, Math.ceil(Math.max(0, ...takes.map((t) => barsOf(t)?.[1] ?? 0)) / 10) * 10);

/** A file on its way to becoming a take. */
interface Sending {
  key: string;
  name: string;
  progress: number;
  error: string | null;
}

/**
 * A track's takes (#21, #46): each recording made for it, with the bars it covers when bars
 * matter, its rating, star and notes. Files dropped here or chosen are uploaded into the
 * track's folder and become its next takes.
 */
export function TakeManager({ track }: { track: Track }) {
  const can = useProjectCan(track.projectId);
  const canEdit = can("edit_takes");
  // Adding takes uploads their files first, which needs the project's upload permission too.
  const canAdd = canEdit && can("upload");
  const { data: takes, error } = useQuery(trackTakesQuery(track.id));
  const { add, change, remove } = useTakeMutations(track.id);
  const [filter, setFilter] = useState<"all" | "best">("all");
  const [bar, setBar] = useState("");
  const [editing, setEditing] = useState<TakeRow | null>(null);
  const [sending, setSending] = useState<Sending[]>([]);
  const [dragging, setDragging] = useState(false);
  const chooser = useRef<HTMLInputElement>(null);

  const upload = async (chosen: File[]) => {
    const batch = chosen.map((file) => ({
      file,
      key: `${file.name}:${file.size}:${Math.random()}`,
    }));
    setSending((list) => [
      ...list,
      ...batch.map(({ file, key }) => ({ key, name: file.name, progress: 0, error: null })),
    ]);
    const update = (key: string, next: Partial<Sending>) =>
      setSending((list) => list.map((s) => (s.key === key ? { ...s, ...next } : s)));
    const sent = await Promise.all(
      batch.map(({ file, key }) =>
        uploadFile(file, {
          projectId: track.projectId,
          folderId: track.folderId,
          signal: new AbortController().signal,
          onProgress: (p) => update(key, { progress: p.total ? p.sent / p.total : 0 }),
        }).then(
          (done) => ({ key, id: done.id }),
          (failure: unknown) => {
            update(key, { error: failure instanceof Error ? failure.message : "Upload failed" });
            return null;
          },
        ),
      ),
    );
    const ready = sent.filter((s) => s !== null);
    if (ready.length === 0) return;
    // Numbered in the order chosen, once every file is in the project.
    add.mutate(
      ready.map((s) => s.id),
      {
        onSuccess: () =>
          setSending((list) => list.filter((s) => !ready.some((r) => r.key === s.key))),
        onError: (failure) =>
          ready.forEach((r) => {
            update(r.key, { error: failure.message });
          }),
      },
    );
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (canAdd && event.dataTransfer.files.length) void upload([...event.dataTransfer.files]);
  };

  if (error) return <p className="text-signal">{error.message}</p>;
  if (!takes) return <p className="text-ink-3">Loading</p>;

  const wanted = Number.parseInt(bar, 10);
  const asked = bar.trim() !== "" && Number.isInteger(wanted) && wanted >= 0;
  const ordered = asked
    ? takesCovering(takes, wanted)
    : [...takes].sort(
        (a, b) =>
          (a.barFrom ?? Number.POSITIVE_INFINITY) - (b.barFrom ?? Number.POSITIVE_INFINITY) ||
          a.number - b.number,
      );
  const shown = filter === "best" ? ordered.filter((t) => t.starred || t.rating >= 4) : ordered;
  const withBars = takes.some((t) => t.barFrom !== null);
  const end = rulerEnd(takes);
  const gaps = coverageGaps(takes);
  const addButton = canAdd && (
    <>
      <FileInput
        ref={chooser}
        multiple
        accept="audio/*,video/*"
        aria-label="Choose takes to add"
        onChange={(e) => {
          if (e.target.files?.length) void upload([...e.target.files]);
          e.target.value = "";
        }}
      />
      <Button variant="secondary" size="sm" onClick={() => chooser.current?.click()}>
        <Icon name="upload" size={14} />
        Add takes
      </Button>
    </>
  );

  return (
    <section
      aria-label="Takes"
      onDragOver={(e) => {
        if (!canAdd) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className="flex flex-col gap-3"
    >
      {takes.length === 0 && sending.length === 0 ? (
        <Empty
          title="No takes yet"
          text={
            canAdd
              ? "Drop the session's scratch mixes here, or choose them. Each becomes the next take of this track; give it bars when they matter."
              : "Takes recorded for this track appear here once someone adds them."
          }
          action={addButton || undefined}
        />
      ) : (
        <div
          className={cn(
            "flex flex-col rounded-panel-lg border bg-raised/25 shadow-1 transition-colors",
            dragging ? "border-edge-strong bg-raised/50" : "border-line",
          )}
        >
          <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-1.5 text-[13px]">
            <Icon name="take" size={14} className="text-ink-3" />
            <span className="text-ink-3">
              {takes.length} {takes.length === 1 ? "take" : "takes"}
              {withBars &&
                (gaps.length > 0 ? ` · no take of ${gapsLabel(gaps)}` : " · every bar covered")}
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {withBars && (
                <Input
                  size="sm"
                  inputMode="numeric"
                  value={bar}
                  onChange={(e) => setBar(e.target.value.replace(/\D/g, ""))}
                  placeholder="Bar"
                  aria-label="Only the takes covering a bar"
                  className="w-20"
                />
              )}
              <Segmented
                label="Which takes"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "all", label: "All" },
                  { value: "best", label: "Best" },
                ]}
              />
              {addButton}
            </div>
          </div>
          <div className="scroll-quiet overflow-x-auto">
            <ul
              aria-label="Takes of this track"
              className={cn(
                "grid grid-cols-[minmax(0,1fr)_40px]",
                // On a narrow screen a take's bars are written in its line instead of drawn.
                withBars && "@2xl/app:grid-cols-[minmax(220px,280px)_minmax(0,1fr)_40px]",
              )}
            >
              {withBars && (
                <li
                  aria-hidden="true"
                  className="col-span-3 hidden grid-cols-subgrid border-b border-line @2xl/app:grid"
                >
                  <span className="eyebrow px-4 py-1.5">Take</span>
                  <span className="relative mr-2 h-7">
                    {Array.from({ length: end / 10 + 1 }, (_, i) => (
                      <span
                        key={String(i)}
                        className={cn(
                          "tabular absolute top-1.5 text-[11px] text-ink-3",
                          i > 0 && "-translate-x-full pr-1",
                        )}
                        // Each ten ends on the line after its last bar.
                        style={{ left: `${i * 10 * (100 / end)}%` }}
                      >
                        {i === 0 ? "bar 1" : i * 10}
                      </span>
                    ))}
                    {/* The bars no take covers, marked under the ruler. */}
                    {gaps.map(([from, to]) => (
                      <span
                        key={from}
                        className="absolute bottom-0 h-1 rounded-full bg-signal/60"
                        style={{
                          left: `${(from - 1) * (100 / end)}%`,
                          width: `${(to - from + 1) * (100 / end)}%`,
                        }}
                      />
                    ))}
                  </span>
                  <span />
                </li>
              )}
              {shown.map((t) => (
                <TakeLine
                  key={t.id}
                  take={t}
                  end={withBars ? end : null}
                  canEdit={canEdit}
                  onEdit={() => setEditing(t)}
                  onStar={() => change.mutate({ id: t.id, starred: !t.starred })}
                  onRemove={() => remove.mutate(t.id)}
                />
              ))}
              {shown.length === 0 && (
                <li className="col-span-full px-4 py-6 text-[13px] text-ink-3">
                  {asked
                    ? `No take covers bar ${wanted}${filter === "best" ? " among the best" : ""}.`
                    : "No take is starred or rated four or more yet."}
                </li>
              )}
            </ul>
          </div>
          {sending.length > 0 && (
            <ul aria-label="Takes being added" className="border-t border-line px-4 py-2">
              {sending.map((s) => (
                <li key={s.key} className="flex items-center gap-3 py-1 text-[13px]">
                  <span className="min-w-0 flex-1 truncate text-ink-2">{s.name}</span>
                  {s.error ? (
                    <span role="alert" className="text-signal">
                      {s.error}
                    </span>
                  ) : (
                    <span className="tabular text-ink-3">
                      {s.progress < 1 ? `${Math.round(s.progress * 100)}%` : "Adding"}
                    </span>
                  )}
                  {s.error && (
                    <Button
                      variant="ghost"
                      size="iconSm"
                      aria-label={`Dismiss ${s.name}`}
                      onClick={() => setSending((list) => list.filter((x) => x.key !== s.key))}
                    >
                      <Icon name="close" size={13} />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {change.error && (
        <p role="alert" className="text-[13px] text-signal">
          {change.error.message}
        </p>
      )}
      {remove.error && (
        <p role="alert" className="text-[13px] text-signal">
          {remove.error.message}
        </p>
      )}
      {editing && <EditTake take={editing} trackId={track.id} onClose={() => setEditing(null)} />}
    </section>
  );
}

/** One take: play it in the player, where it lies in the piece, and what can be done with it. */
function TakeLine({
  take,
  end,
  canEdit,
  onEdit,
  onStar,
  onRemove,
}: {
  take: TakeRow;
  /** The ruler's last bar, or null where no take has bars. */
  end: number | null;
  canEdit: boolean;
  onEdit: () => void;
  onStar: () => void;
  onRemove: () => void;
}) {
  const range = barsOf(take);
  // What is known of it, in a line; its bars only where the lane does not draw them.
  const meta = [
    { text: end === null ? null : (barsLabel(take) ?? "no bars"), narrow: true },
    { text: take.label, narrow: false },
    {
      text: take.file?.duration != null ? formatDuration(take.file.duration) : null,
      narrow: false,
    },
    { text: take.notes, narrow: false },
  ].filter((part) => part.text);
  const heading = (
    <>
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full",
          take.file ? "bg-raised text-ink" : "border border-line text-ink-3",
        )}
      >
        <Icon name="play" size={9} fill="currentColor" strokeWidth={0} />
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-[13px] text-ink">
          <span className="tabular font-medium">T{take.number}</span>
          {take.starred && (
            <Icon
              name="star"
              size={11}
              fill="currentColor"
              aria-label="Starred"
              className="text-ink-2"
            />
          )}
          <Rating value={take.rating} />
        </span>
        <span className="block truncate text-[12px] text-ink-3">
          {take.file ? "" : "Its file is gone · "}
          {meta.map((part, i) => (
            <span key={String(i)} className={cn(part.narrow && "@2xl/app:hidden")}>
              {/* The bars come first, carrying their own separator, so hiding them leaves none. */}
              {i > 0 && !meta[i - 1]?.narrow && " · "}
              {part.text}
              {part.narrow && i < meta.length - 1 && " · "}
            </span>
          ))}
        </span>
      </span>
    </>
  );
  return (
    <li
      className={cn(
        "group col-span-2 grid grid-cols-subgrid items-center border-b border-line last:border-b-0 hover:bg-raised/40",
        end !== null && "@2xl/app:col-span-3",
      )}
    >
      {take.file ? (
        <Link
          to="/files/$fileId"
          params={{ fileId: take.file.id }}
          className="flex min-w-0 items-center gap-2.5 px-4 py-1.5 no-underline"
        >
          {heading}
        </Link>
      ) : (
        <span className="flex min-w-0 items-center gap-2.5 px-4 py-1.5">{heading}</span>
      )}
      {end !== null && (
        <span className="relative mr-2 hidden h-9 @2xl/app:block">
          {Array.from({ length: end / 10 }, (_, i) => (
            <span
              key={String(i)}
              className="absolute top-0 bottom-0 w-px bg-line"
              style={{ left: `${i * 10 * (100 / end)}%` }}
            />
          ))}
          {range ? (
            <span
              title={barsLabel(take) ?? undefined}
              className="absolute top-2 h-5 rounded-[4px] border border-ink-3/40 bg-ink-3/40 transition-colors group-hover:bg-ink-3/55"
              style={{
                left: `${(Math.max(range[0], 1) - 1) * (100 / end)}%`,
                width: `${(range[1] - Math.max(range[0], 1) + 1) * (100 / end)}%`,
              }}
            />
          ) : (
            <span className="absolute top-2.5 left-2 text-[12px] text-ink-3">No bars</span>
          )}
        </span>
      )}
      <span className="pr-2">
        {canEdit && (
          <ActionMenu
            label={`take ${take.number}`}
            actions={[
              { label: "Edit…", onSelect: onEdit },
              { label: take.starred ? "Unstar" : "Star", onSelect: onStar },
              "divider",
              { label: "No longer a take", danger: true, onSelect: onRemove },
            ]}
          />
        )}
      </span>
    </li>
  );
}

/** A number field's value, or null when it is left empty. */
const wholeOrNull = (value: string) => (value.trim() === "" ? null : Number.parseInt(value, 10));

/** A take's label, rating, star, notes, and where it lies: page, bars, in and out points. */
function EditTake({
  take,
  trackId,
  onClose,
}: {
  take: TakeRow;
  trackId: string;
  onClose: () => void;
}) {
  const { change } = useTakeMutations(trackId);
  const [label, setLabel] = useState(take.label ?? "");
  const [notes, setNotes] = useState(take.notes ?? "");
  const [rating, setRating] = useState(String(take.rating));
  const [starred, setStarred] = useState(take.starred);
  const [page, setPage] = useState(take.page?.toString() ?? "");
  const [barFrom, setBarFrom] = useState(take.barFrom?.toString() ?? "");
  const [barTo, setBarTo] = useState(take.barTo?.toString() ?? "");
  const [inPoint, setInPoint] = useState(take.inPoint === null ? "" : clockOf(take.inPoint));
  const [outPoint, setOutPoint] = useState(take.outPoint === null ? "" : clockOf(take.outPoint));
  const point = (value: string) => (value.trim() === "" ? null : parseClock(value));
  const unreadable = [inPoint, outPoint].some((v) => v.trim() !== "" && parseClock(v) === null);
  const next: TakeChange = {
    label: label.trim() || null,
    notes: notes.trim() || null,
    rating: Number(rating),
    starred,
    page: wholeOrNull(page),
    barFrom: wholeOrNull(barFrom),
    barTo: wholeOrNull(barTo),
    inPoint: point(inPoint),
    outPoint: point(outPoint),
  };
  const problem = unreadable
    ? "Write a point as seconds or minutes and seconds, such as 1:32.5"
    : takeProblem({
        barFrom: next.barFrom ?? null,
        barTo: next.barTo ?? null,
        inPoint: next.inPoint ?? null,
        outPoint: next.outPoint ?? null,
      });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (problem) return;
    change.mutate({ id: take.id, ...next }, { onSuccess: onClose });
  };
  const digits = (set: (value: string) => void) => (e: { target: { value: string } }) =>
    set(e.target.value.replace(/\D/g, ""));
  return (
    <Dialog
      title={`Take ${take.number}`}
      description={take.file?.name}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="edit-take" disabled={change.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="edit-take" onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-4 @xl/app:grid-cols-[minmax(0,1fr)_160px]">
          <Field label="Label" hint="Optional, such as Insert or Safety">
            <Input value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
          </Field>
          <Field label="Rating">
            <Select value={rating} onChange={(e) => setRating(e.target.value)}>
              <option value="0">Not rated</option>
              {Array.from({ length: TAKE_RATING_MAX }, (_, i) => (
                <option key={String(i + 1)} value={String(i + 1)}>
                  {i + 1} of {TAKE_RATING_MAX}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <label className="flex items-center gap-2 text-[14px] text-ink-2">
          <Checkbox checked={starred} onChange={(e) => setStarred(e.target.checked)} />
          Starred: one of the takes to use
        </label>
        <Field label="Notes">
          <Textarea
            rows={3}
            value={notes}
            maxLength={4000}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
        <fieldset className="m-0 grid min-w-0 grid-cols-3 gap-4 border-0 p-0">
          <legend className="mb-2 text-[13px] text-ink-2">
            Bars, when they matter
            <span className="block text-[12px] text-ink-3">
              A take with bars is found by the bars it covers.
            </span>
          </legend>
          <Field label="Score page">
            <Input inputMode="numeric" value={page} onChange={digits(setPage)} />
          </Field>
          <Field label="First bar">
            <Input inputMode="numeric" value={barFrom} onChange={digits(setBarFrom)} />
          </Field>
          <Field label="Last bar">
            <Input inputMode="numeric" value={barTo} onChange={digits(setBarTo)} />
          </Field>
        </fieldset>
        <div className="grid grid-cols-2 gap-4">
          <Field label="In point" hint="Optional, such as 0:12.5">
            <Input value={inPoint} onChange={(e) => setInPoint(e.target.value)} />
          </Field>
          <Field label="Out point">
            <Input value={outPoint} onChange={(e) => setOutPoint(e.target.value)} />
          </Field>
        </div>
        {(problem || change.error) && (
          <p role="alert" className="text-[13px] text-signal">
            {problem ?? change.error?.message}
          </p>
        )}
      </form>
    </Dialog>
  );
}

/**
 * "Any other options for bar 72?" (#46): from a thread on a bar, every take of the track
 * covering it, starred first and then by rating, each one click from the player.
 */
export function OtherTakes({
  trackId,
  bar,
  onClose,
}: {
  trackId: string;
  bar: number;
  onClose: () => void;
}) {
  const { data: takes, error } = useQuery(trackTakesQuery(trackId));
  const list = takes ? takesCovering(takes, bar) : [];
  return (
    <section
      aria-label={`Other takes for bar ${bar}`}
      className="rounded-panel border border-line bg-ground"
    >
      <div className="flex items-center gap-2 border-b border-line py-1 pr-1 pl-3">
        <Icon name="take" size={14} className="text-ink-3" />
        <span className="text-[13px] font-medium text-ink">Other takes for bar {bar}</span>
        {takes && <span className="text-[12px] text-ink-3">{list.length} cover it</span>}
        <Button
          variant="ghost"
          size="iconSm"
          aria-label="Close the takes"
          onClick={onClose}
          className="ml-auto"
        >
          <Icon name="close" size={13} />
        </Button>
      </div>
      {error ? (
        <p className="m-0 px-3 py-2 text-[13px] text-signal">{error.message}</p>
      ) : !takes ? (
        <p className="m-0 px-3 py-2 text-[13px] text-ink-3">Loading</p>
      ) : list.length === 0 ? (
        <p className="m-0 px-3 py-2 text-[13px] text-ink-3">
          No take covers bar {bar}. A take's bars are set in the track's takes.
        </p>
      ) : (
        <ul className="m-0 list-none p-0">
          {list.map((t) => (
            <li key={t.id} className="border-b border-line last:border-b-0">
              {t.file ? (
                <Link
                  to="/files/$fileId"
                  params={{ fileId: t.file.id }}
                  className="flex items-center gap-2.5 px-3 py-1.5 no-underline hover:bg-raised/40"
                >
                  <OtherTake take={t} />
                </Link>
              ) : (
                <span className="flex items-center gap-2.5 px-3 py-1.5">
                  <OtherTake take={t} />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-line px-3 py-1.5">
        <Link
          to="/tracks/$trackId"
          params={{ trackId }}
          search={{ view: "takes" }}
          className="text-[12px] text-ink-3 hover:text-ink"
        >
          All the track's takes
        </Link>
      </div>
    </section>
  );
}

function OtherTake({ take }: { take: TakeRow }) {
  return (
    <>
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-raised text-ink">
        <Icon name="play" size={9} fill="currentColor" strokeWidth={0} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[13px] text-ink">
          <span className="tabular font-medium">T{take.number}</span>
          {take.starred && (
            <Icon
              name="star"
              size={11}
              fill="currentColor"
              aria-label="Starred"
              className="text-ink-2"
            />
          )}
          <Rating value={take.rating} />
        </span>
        <span className="block truncate text-[12px] text-ink-3">
          {[barsLabel(take), take.label, take.notes].filter(Boolean).join(" · ")}
        </span>
      </span>
      {take.file?.duration != null && (
        <span className="tabular text-[12px] text-ink-3">{formatDuration(take.file.duration)}</span>
      )}
    </>
  );
}

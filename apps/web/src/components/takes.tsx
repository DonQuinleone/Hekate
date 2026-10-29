import {
  barSpan,
  barsLabel,
  barsOf,
  clockOf,
  coverageGaps,
  type EditDecisions,
  type EdlRate,
  edlRates,
  formatDuration,
  gapsLabel,
  marksAtBar,
  parseClock,
  type SharedTake,
  TAKE_RATING_MAX,
  type TakeAtBar,
  type TakeChange,
  type TakeRow,
  takeProblem,
  takesForBar,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type DragEvent, type FormEvent, useRef, useState } from "react";
import { cn } from "~/lib/cn";
import {
  barsUsedOf,
  decisionsSummary,
  editLine,
  rateName,
  takesUsed,
  usedAtBar,
} from "~/lib/edit-decisions";
import { formatLoop } from "~/lib/loop";
import {
  editDecisionsQuery,
  projectSessionsQuery,
  scoreMarksQuery,
  type Track,
  trackTakesQuery,
  useProjectCan,
  useTakeMutations,
} from "~/lib/queries";
import { uploadFile } from "~/lib/upload";
import { Empty } from "./empty";
import { Icon } from "./icons";
import { Button } from "./ui/button";
import { Chip } from "./ui/chip";
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
  // What the score marks say of each take at a bar (#52): which fixed it, which went wrong.
  const { data: marking } = useQuery({
    ...scoreMarksQuery(track.id),
    enabled: can("view_production"),
    retry: false,
  });
  const { add, change, remove } = useTakeMutations(track.id);
  const [filter, setFilter] = useState<"all" | "best" | "used">("all");
  const [bar, setBar] = useState("");
  // The latest version's edit decision list, matched to these takes (#56).
  const [rate, setRate] = useState<EdlRate | undefined>(undefined);
  const { data: decisions } = useQuery(editDecisionsQuery(track.id, rate));
  const [mode, setMode] = useState<"takes" | "edits">("takes");
  const showing = decisions ? mode : "takes";
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
    ? takesForBar(takes, wanted, marksAtBar(marking?.marks ?? [], wanted))
    : [...takes].sort(
        (a, b) =>
          (a.barFrom ?? Number.POSITIVE_INFINITY) - (b.barFrom ?? Number.POSITIVE_INFINITY) ||
          a.number - b.number,
      );
  const used = takesUsed(decisions);
  // "Used" lapses with the list it reads.
  const which = filter === "used" && !decisions ? "all" : filter;
  const shown =
    which === "best"
      ? ordered.filter((t) => t.starred || t.rating >= 4)
      : which === "used"
        ? ordered.filter((t) => used.has(t.id))
        : ordered;
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
              {decisions && (
                <Segmented
                  label="Show"
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: "takes", label: "Coverage" },
                    { value: "edits", label: "Edit decisions" },
                  ]}
                />
              )}
              {withBars && showing === "takes" && (
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
              {showing === "takes" && (
                <Segmented
                  label="Which takes"
                  value={which}
                  onChange={setFilter}
                  options={[
                    { value: "all", label: "All" },
                    { value: "best", label: "Best" },
                    // The takes the latest version's edit decision list uses (#56).
                    ...(decisions
                      ? [{ value: "used" as const, label: `In V${decisions.version.number}` }]
                      : []),
                  ]}
                />
              )}
              {addButton}
            </div>
          </div>
          {showing === "edits" && decisions ? (
            <EditDecisionList
              decisions={decisions}
              numberOf={(id) => takes.find((t) => t.id === id)?.number}
              rate={rate}
              onRate={setRate}
            />
          ) : (
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
                    used={barsUsedOf(decisions, t.id)}
                    usedIn={
                      decisions?.uses.some((u) => u.takeId === t.id)
                        ? `V${decisions.version.number}`
                        : null
                    }
                    canEdit={canEdit}
                    onEdit={() => setEditing(t)}
                    onStar={() => change.mutate({ id: t.id, starred: !t.starred })}
                    onRemove={() => remove.mutate(t.id)}
                  />
                ))}
                {shown.length === 0 && (
                  <li className="col-span-full px-4 py-6 text-[13px] text-ink-3">
                    {asked
                      ? `No take covers bar ${wanted}${
                          which === "best"
                            ? " among the best"
                            : which === "used"
                              ? ` that V${decisions?.version.number} uses`
                              : ""
                        }.`
                      : which === "used"
                        ? `V${decisions?.version.number}'s list uses none of these takes.`
                        : "No take is starred or rated four or more yet."}
                  </li>
                )}
              </ul>
            </div>
          )}
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
      {editing && (
        <EditTake
          take={editing}
          trackId={track.id}
          projectId={track.projectId}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

/** One take: play it in the player, where it lies in the piece, and what can be done with it. */
function TakeLine({
  take,
  end,
  used,
  usedIn,
  canEdit,
  onEdit,
  onStar,
  onRemove,
}: {
  take: TakeRow;
  /** The ruler's last bar, or null where no take has bars. */
  end: number | null;
  /** The bars of it the latest version uses, from its edit decision list (#56). */
  used: [number, number][];
  /** The version whose list uses it ("V3"), or null. */
  usedIn: string | null;
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
          {usedIn && <span className="text-[12px] text-signal">in {usedIn}</span>}
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
      {/* The take's own page, which says so where it was logged without a file. */}
      <Link
        to="/takes/$takeId"
        params={{ takeId: take.id }}
        className="flex min-w-0 items-center gap-2.5 px-4 py-1.5 no-underline"
      >
        {heading}
      </Link>
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
          {/* What the version uses of it, under its bars. */}
          {used.map(([from, to]) => (
            <span
              key={from}
              aria-hidden="true"
              className="absolute top-7 h-1 rounded-full bg-signal"
              style={{
                left: `${(Math.max(from, 1) - 1) * (100 / end)}%`,
                width: `${(to - Math.max(from, 1) + 1) * (100 / end)}%`,
              }}
            />
          ))}
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

/**
 * The latest version's edits in order, as its edit decision list gives them (#56): where in
 * the version each falls, the take it comes from (or the source, where it is no take of this
 * track), where in the take and which of its bars. The timecode rate can be set where the
 * list does not say it.
 */
function EditDecisionList({
  decisions,
  numberOf,
  rate,
  onRate,
}: {
  decisions: EditDecisions;
  numberOf: (takeId: string) => number | undefined;
  rate: EdlRate | undefined;
  onRate: (rate: EdlRate | undefined) => void;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2 text-[13px] text-ink-3">
        <span className="min-w-0 flex-1">{decisionsSummary(decisions)}</span>
        {decisions.dropFrame ? (
          // Drop frame exists only at 29.97: nothing to choose.
          <span>{rateName(decisions.fps, true)}, as the list says</span>
        ) : (
          <Select
            size="sm"
            aria-label="Timecode rate"
            value={rate === undefined ? "" : String(rate)}
            onChange={(e) =>
              onRate(e.target.value === "" ? undefined : (Number(e.target.value) as EdlRate))
            }
            className="w-auto"
          >
            <option value="">
              {rateName(decisions.fps, decisions.dropFrame)}
              {decisions.fpsGuessed ? ", worked out" : ", as the list says"}
            </option>
            {edlRates.map((r) => (
              <option key={r} value={String(r)}>
                {rateName(r, r === 29.97)}
              </option>
            ))}
          </Select>
        )}
      </div>
      {decisions.uses.length === 0 ? (
        <p className="m-0 px-4 py-6 text-[13px] text-ink-3">
          The list has no edits from a recording.
        </p>
      ) : (
        <ol aria-label="Edit decisions" className="m-0 list-none p-0">
          {decisions.uses.map((use, i) => {
            const line = editLine(use, numberOf);
            return (
              <li
                key={`${use.event.number}-${String(i)}`}
                className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-4 border-b border-line px-4 py-2 text-[13px] last:border-b-0 @2xl/app:grid-cols-[8rem_minmax(0,14rem)_minmax(0,1fr)_minmax(0,9rem)]"
              >
                <span className="tabular text-ink-2">{line.when}</span>
                <span className="min-w-0 truncate">
                  {line.take ? (
                    <span className="tabular font-medium text-ink">{line.take}</span>
                  ) : (
                    <span className="text-ink-3">{line.source}</span>
                  )}
                </span>
                <span className="col-start-2 min-w-0 truncate text-ink-3 @2xl/app:col-start-auto">
                  {line.place}
                </span>
                <span className="col-start-2 text-ink-3 @2xl/app:col-start-auto">
                  {line.bars ?? ""}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/** A number field's value, or null when it is left empty. */
const wholeOrNull = (value: string) => (value.trim() === "" ? null : Number.parseInt(value, 10));

/** A take's label, rating, star, notes, and where it lies: page, bars, in and out points. */
function EditTake({
  take,
  trackId,
  projectId,
  onClose,
}: {
  take: TakeRow;
  trackId: string;
  projectId: string;
  onClose: () => void;
}) {
  const { change } = useTakeMutations(trackId);
  // The recording sessions it can be said to come from (#21, #45).
  const { data: sessions = [] } = useQuery(projectSessionsQuery(projectId));
  const [session, setSession] = useState(take.sessionId ?? "");
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
    sessionId: session || null,
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
        {(sessions.length > 0 || session) && (
          <Field
            label="Session"
            hint="The session it was recorded in. Whichever you choose, it stays this track's take"
          >
            <Select value={session} onChange={(e) => setSession(e.target.value)}>
              <option value="">None</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
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
  share,
  onAudition,
}: {
  trackId: string;
  bar: number;
  onClose: () => void;
  /**
   * Hear a take at this bar against the recording (#46), where the thread says when the bar
   * was heard: its file, its number and where the bar lies in it.
   */
  onAudition?: (take: { fileId: string; number: number; span: [number, number] }) => void;
  /** For those who triage (#133): the takes the thread already has, and how to share more. */
  share?: { shared: string[]; onShare: (takeIds: string[]) => Promise<unknown> };
}) {
  const { data: takes, error } = useQuery(trackTakesQuery(trackId));
  // Which of them the latest version's edit decision list uses here (#56).
  const { data: decisions } = useQuery(editDecisionsQuery(trackId));
  // What the producer's score marks say of them at this bar (#52): a role that does not see
  // the production tools is refused them, and sees the takes without. The order waits for
  // them, so rows do not move once they arrive.
  const { data: marking, isPending: marksPending } = useQuery({
    ...scoreMarksQuery(trackId),
    retry: false,
  });
  const notes = marksAtBar(marking?.marks ?? [], bar);
  const list = takes ? takesForBar(takes, bar, notes) : [];
  const [mode, setMode] = useState<"ticked" | "all" | "except">("ticked");
  /** The take being auditioned, to say so and to press its button. */
  const [auditioning, setAuditioning] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const chosen = list
    .filter((t) =>
      mode === "all" ? true : mode === "ticked" ? ticked.has(t.id) : !ticked.has(t.id),
    )
    .map((t) => t.id);
  const tick = (id: string) =>
    setTicked((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const send = async () => {
    if (!share || chosen.length === 0) return;
    setSending(true);
    setFailure(null);
    try {
      await share.onShare(chosen);
      setTicked(new Set());
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "Could not share the takes");
    } finally {
      setSending(false);
    }
  };
  return (
    <section
      aria-label={`Other takes for bar ${bar}`}
      className="rounded-panel border border-line bg-ground"
    >
      <div className="flex items-center gap-2 border-b border-line py-1 pr-1 pl-3">
        <Icon name="take" size={14} className="text-ink-3" />
        <span className="text-[13px] font-medium text-ink">Other takes for bar {bar}</span>
        {takes && !marksPending && (
          <span className="text-[12px] text-ink-3">{list.length} cover it</span>
        )}
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
      ) : !takes || marksPending ? (
        <p className="m-0 px-3 py-2 text-[13px] text-ink-3">Loading</p>
      ) : list.length === 0 ? (
        <p className="m-0 px-3 py-2 text-[13px] text-ink-3">
          No take covers bar {bar}. A take's bars are set in the track's takes.
        </p>
      ) : (
        <ul className="m-0 list-none p-0">
          {list.map((t) => {
            // Heard at the bar, looped, where the take's bars place it (#46).
            const span = t.file ? barSpan({ ...t, duration: t.file.duration }, bar) : null;
            return (
              <li key={t.id} className="flex items-center border-b border-line last:border-b-0">
                {share && mode !== "all" && (
                  // A cell of its own, so the box keeps its distance from the take's link.
                  <span className="flex w-10 shrink-0 items-center justify-center self-stretch">
                    <Checkbox
                      checked={ticked.has(t.id)}
                      onChange={() => tick(t.id)}
                      aria-label={`Tick take ${t.number}`}
                    />
                  </span>
                )}
                {t.file ? (
                  <Link
                    to="/files/$fileId"
                    params={{ fileId: t.file.id }}
                    search={span ? { loop: barLoop(span), t: barLoopStart(span) } : {}}
                    title={span ? `Hear bar ${bar} of take ${t.number}, looped` : undefined}
                    className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-1.5 no-underline hover:bg-raised/40"
                  >
                    <OtherTake
                      take={t}
                      shared={share?.shared.includes(t.id)}
                      usedIn={usedAtBar(decisions, t.id, bar)}
                      note={notes.get(t.number)}
                    />
                  </Link>
                ) : (
                  <span className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-1.5">
                    <OtherTake
                      take={t}
                      shared={share?.shared.includes(t.id)}
                      usedIn={usedAtBar(decisions, t.id, bar)}
                      note={notes.get(t.number)}
                    />
                  </span>
                )}
                {onAudition && span && t.file?.streamStatus === "ready" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Audition take ${t.number} at bar ${bar}`}
                    aria-pressed={auditioning === t.id}
                    className="mr-1.5 shrink-0 aria-pressed:bg-raised aria-pressed:text-ink"
                    title="Heard against this recording at the bar, looped and level-matched; the number keys flip between them"
                    onClick={() => {
                      setAuditioning(t.id);
                      onAudition({ fileId: t.file?.id ?? "", number: t.number, span });
                    }}
                  >
                    Audition
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {auditioning && (
        <p role="status" className="m-0 border-t border-line px-3 py-1.5 text-[12px] text-ink-3">
          Auditioning at bar {bar}, looped and level-matched against this recording. Press 1 and 2
          to flip between them.
        </p>
      )}
      {share && list.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2">
          <Select
            size="sm"
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
            aria-label="Which takes to share with this thread"
            className="w-auto min-w-0 flex-1"
          >
            <option value="ticked">The ticked takes</option>
            <option value="all">Every take of the bar</option>
            <option value="except">All but the ticked</option>
          </Select>
          <Button
            variant="primary"
            size="sm"
            className="ml-auto"
            disabled={sending || chosen.length === 0}
            onClick={() => void send()}
          >
            Share {chosen.length}
          </Button>
          {failure && (
            <p role="alert" className="m-0 w-full text-[12px] text-signal">
              {failure}
            </p>
          )}
        </div>
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

/** A bar's place in a take as a loop in the address, to the hundredth, never narrower. */
const barLoopStart = (span: [number, number]) => Math.floor(span[0] * 100) / 100;
const barLoop = (span: [number, number]) =>
  formatLoop({ start: barLoopStart(span), end: Math.ceil(span[1] * 100) / 100 });

function OtherTake({
  take,
  shared = false,
  usedIn = null,
  note,
}: {
  take: SharedTake;
  shared?: boolean;
  /** The version whose edit decision list uses it at this bar ("V2"), or null (#56). */
  usedIn?: string | null;
  /** What the score marks say of it at this bar (#52). */
  note?: TakeAtBar;
}) {
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
          {usedIn && <span className="text-[12px] text-signal">in {usedIn}</span>}
          {shared && <Chip>shared</Chip>}
        </span>
        <span className="block truncate text-[12px] text-ink-3">
          {[barsLabel(take), take.label, take.notes].filter(Boolean).join(" · ")}
        </span>
        {note && (note.fixed.length > 0 || note.troubled.length > 0) && (
          <span className="block truncate text-[12px]">
            {note.fixed.length > 0 && (
              <span className="text-ink-2">Fixed {note.fixed.join(", ")}</span>
            )}
            {note.fixed.length > 0 && note.troubled.length > 0 && (
              <span className="text-ink-3"> · </span>
            )}
            {note.troubled.length > 0 && (
              <span className="text-signal">{note.troubled.join(", ")} here</span>
            )}
          </span>
        )}
      </span>
      {take.file?.duration != null && (
        <span className="tabular text-[12px] text-ink-3">{formatDuration(take.file.duration)}</span>
      )}
    </>
  );
}

/**
 * Takes shared on a thread (#133): one line in the thread, opening the list of them, each to
 * hear in the player. Those who triage may unshare one.
 */
export function SharedTakes({
  takes,
  bar,
  guest,
  onUnshare,
  onAudition,
}: {
  takes: SharedTake[];
  bar?: number;
  /** A guest reviewer hears them in their own player. */
  guest: boolean;
  onUnshare?: (takeId: string) => void;
  /** Hear one at the thread's bar against the recording (#46), as in Other takes. */
  onAudition?: (take: { fileId: string; number: number; span: [number, number] }) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-7 cursor-pointer items-center gap-2 self-start rounded-chip border border-line bg-raised/40 px-2.5 text-[12px] text-ink-2 transition-colors hover:border-edge hover:text-ink"
      >
        <Icon name="take" size={12} className="text-ink-3" />
        {takes.length} {takes.length === 1 ? "take" : "takes"} attached
      </button>
      {open && (
        <Dialog
          title={bar === undefined ? "Attached takes" : `Takes for bar ${bar}`}
          description={
            bar === undefined
              ? "Shared on this thread. Each opens in the player."
              : onAudition
                ? `Shared on this thread. Audition hears one against this recording at bar ${bar}; each also opens in its own player, looped on the bar.`
                : `Shared on this thread. Each opens in the player, looped on bar ${bar} where the take's bars place it.`
          }
          onClose={() => setOpen(false)}
          footer={
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Close
            </Button>
          }
        >
          <ul className="m-0 flex list-none flex-col rounded-panel border border-line p-0">
            {takes.map((t) => {
              // On a thread about a bar, each is heard at that bar, looped (#46).
              const span =
                t.file && bar !== undefined
                  ? barSpan({ ...t, duration: t.file.duration }, bar)
                  : null;
              return (
                <li key={t.id} className="flex items-center border-b border-line last:border-b-0">
                  {t.file ? (
                    <Link
                      to={guest ? "/g/files/$fileId" : "/files/$fileId"}
                      params={{ fileId: t.file.id }}
                      search={span ? { loop: barLoop(span), t: barLoopStart(span) } : {}}
                      title={span ? `Hear bar ${bar} of take ${t.number}, looped` : undefined}
                      className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 no-underline hover:bg-raised/40"
                    >
                      <OtherTake take={t} />
                    </Link>
                  ) : (
                    <span className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2">
                      <OtherTake take={t} />
                    </span>
                  )}
                  {onAudition && span && t.file?.streamStatus === "ready" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0"
                      aria-label={`Audition take ${t.number} at bar ${bar}`}
                      title="Heard against this recording at the bar, looped and level-matched; the number keys flip between them"
                      onClick={() => {
                        // Closed, so the recording and the comparison are in view to hear it.
                        setOpen(false);
                        onAudition({ fileId: t.file?.id ?? "", number: t.number, span });
                      }}
                    >
                      Audition
                    </Button>
                  )}
                  {onUnshare && (
                    <Button
                      variant="ghost"
                      size="iconSm"
                      aria-label={`Unshare take ${t.number}`}
                      title="Unshare"
                      onClick={() => onUnshare(t.id)}
                      className="mr-2"
                    >
                      <Icon name="close" size={13} />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </Dialog>
      )}
    </>
  );
}

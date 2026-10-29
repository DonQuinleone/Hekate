import {
  type BoardCard,
  type CalendarEntry,
  capital,
  type DayRange,
  daysDragged,
  movedRange,
  resizedRange,
  shiftInstant,
  shiftWeeks,
  timelineBar,
  timelineSpan,
  timelineWeeks,
  trackDeadline,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { entryIcon } from "~/components/calendar";
import { EntryDialog } from "~/components/calendar-entry";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { Card } from "~/components/page";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/cn";
import { dayHere, formatDates } from "~/lib/locale";
import {
  projectBoardQuery,
  projectCalendarQuery,
  useCalendarEntries,
  useItemWords,
  useProjectCan,
  useTrackMutations,
} from "~/lib/queries";

const weekFormat = formatDates({ day: "numeric", month: "short", timeZone: "UTC" });
const dayFormat = formatDates({ day: "numeric", month: "short" });
const rangeFormat = formatDates({
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const WEEKS = 6;
const DAYS = WEEKS * 7;
/** A bar shorter than this many days carries its words beside it, not inside. */
const FITS = 6 / DAYS;

const today = () => dayHere();
const noon = (day: string) => new Date(`${day}T12:00:00Z`);
/** A day's deadline as an instant: five in the afternoon where the member is, as reviews are. */
const dueOn = (day: string) => new Date(`${day}T17:00:00`).toISOString();

/** A bar being dragged: whose, how (moved whole, or its end), and by how many days so far. */
interface Drag {
  kind: "track" | "entry";
  id: string;
  mode: "move" | "resize";
  days: number;
}

/** A change just saved, and the way back from it. */
interface Undoable {
  text: string;
  revert: () => void;
}

/** The handle at a bar's end: dragging it moves the end a day at a time. */
function Handle({ onPointerDown }: { onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void }) {
  return (
    <span
      aria-hidden="true"
      onPointerDown={onPointerDown}
      className="absolute inset-y-0 right-0 flex w-2.5 cursor-ew-resize items-center justify-end pr-1 opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100"
    >
      <span className="h-3 w-0.5 rounded-full bg-current opacity-60" />
    </span>
  );
}

/**
 * A project's tracks across six weeks (#141), approximating a Gantt as the prototype does: each
 * runs from its latest version to its deadline (its own, else when an open review of it is due),
 * labelled with the step it waits at, finished ones solid and late ones marked. Under them, the
 * calendar's entries (#505). Whoever may organise tracks drags a bar's end to set its deadline;
 * whoever edits the schedule drags an entry to move it or its end to change its length. Each
 * change is saved as the pointer lifts, and undone from the line that says what it did.
 * Moved by three weeks at a time.
 */
export function ProjectTimeline({ projectId }: { projectId: string }) {
  const { data, error } = useQuery(projectBoardQuery(projectId));
  const { words } = useItemWords(projectId);
  const can = useProjectCan(projectId);
  const { updateTrack } = useTrackMutations(projectId);
  const { change } = useCalendarEntries(projectId);
  const [day, setDay] = useState(today);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [undo, setUndo] = useState<Undoable | null>(null);
  const [opening, setOpening] = useState<CalendarEntry | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const span = useRef<HTMLDivElement>(null);
  /** Whether the pointer moved during the last drag, so the click that follows opens nothing. */
  const dragged = useRef(false);
  const weeks = timelineWeeks(day, WEEKS);
  const start = weeks[0] ?? day;
  const last = shiftWeeks(start, WEEKS);
  const end = new Date(Date.parse(last) - 86_400_000).toISOString().slice(0, 10);
  const calendar = useQuery(projectCalendarQuery(projectId, { from: start, to: end }));
  const entries = (calendar.data?.events ?? []).flatMap((e) => (e.entry ? [e.entry] : []));
  const now = today();
  const todayAt = (Date.parse(now) - Date.parse(start)) / (DAYS * 86_400_000);
  const canDeadline = can("organise");
  const canEntries = can("edit_production");
  // Where the weeks are wider than the screen, today is brought into view, a little in.
  const ready = data !== undefined;
  useLayoutEffect(() => {
    const el = scroller.current;
    const weeksWide = span.current?.clientWidth ?? 0;
    if (!ready || !el || el.scrollWidth <= el.clientWidth) return;
    const name = el.scrollWidth - weeksWide;
    const at = Math.min(Math.max(todayAt, 0), 1) * weeksWide;
    el.scrollLeft = Math.max(0, at - (el.clientWidth - name) / 3);
  }, [ready, todayAt]);
  // What was done stays offered for a while, then goes quietly.
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), 12_000);
    return () => clearTimeout(timer);
  }, [undo]);

  /**
   * A drag from here: the days covered follow the pointer until it lifts, when they are handed
   * on. The element keeps the pointer, so leaving it mid-drag loses nothing.
   */
  const startDrag = (
    e: ReactPointerEvent<HTMLElement>,
    what: Omit<Drag, "days">,
    onDone: (days: number) => void,
  ) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    const x0 = e.clientX;
    const soFar = (x: number) => daysDragged(x - x0, span.current?.clientWidth ?? 0, DAYS);
    dragged.current = false;
    el.setPointerCapture(e.pointerId);
    setDrag({ ...what, days: 0 });
    const move = (ev: PointerEvent) => {
      const days = soFar(ev.clientX);
      if (days !== 0) dragged.current = true;
      setDrag((d) => (d && d.days === days ? d : { ...what, days }));
    };
    const stop = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", stop);
      el.removeEventListener("pointercancel", cancel);
      setDrag(null);
      const days = soFar(ev.clientX);
      if (days !== 0) onDone(days);
    };
    const cancel = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", stop);
      el.removeEventListener("pointercancel", cancel);
      setDrag(null);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", stop);
    el.addEventListener("pointercancel", cancel);
  };

  /** A track's deadline set to a day, with the way back offered. */
  const setDeadline = (card: BoardCard, next: string) => {
    const previous = card.due ?? null;
    updateTrack.mutate(
      { id: card.id, dueAt: next },
      {
        onSuccess: () =>
          setUndo({
            text: `${card.name} due ${dayFormat.format(new Date(next))}`,
            revert: () => updateTrack.mutate({ id: card.id, dueAt: previous }),
          }),
      },
    );
  };
  /** An entry's days changed, with the way back offered. */
  const setRange = (entry: CalendarEntry, next: DayRange) => {
    const previous: DayRange = { startsOn: entry.startsOn, endsOn: entry.endsOn };
    change.mutate(
      { id: entry.id, ...next },
      {
        onSuccess: () =>
          setUndo({
            text: `${entry.title}: ${
              next.endsOn
                ? dayFormat.formatRange(noon(next.startsOn), noon(next.endsOn))
                : dayFormat.format(noon(next.startsOn))
            }`,
            revert: () => change.mutate({ id: entry.id, ...previous }),
          }),
      },
    );
  };

  if (error) return <p className="m-0 text-signal">{error.message}</p>;
  if (!data) return null;
  if (data.cards.length === 0 && entries.length === 0)
    return (
      <Empty
        title={`No ${words.tracks} yet`}
        text={`The timeline runs each ${words.track} from its latest ${words.version} to its deadline. Add a ${words.track} and upload a ${words.version} to start.`}
      />
    );
  const done = new Set(data.columns.status.filter((c) => c.category === "done").map((c) => c.id));
  const failure = updateTrack.error ?? change.error;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-label="Earlier"
          onClick={() => setDay(shiftWeeks(day, -3))}
          className="flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-raised hover:text-ink"
        >
          <Icon name="chevronLeft" size={14} />
        </button>
        <button
          type="button"
          aria-label="Later"
          onClick={() => setDay(shiftWeeks(day, 3))}
          className="flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-raised hover:text-ink"
        >
          <Icon name="chevronRight" size={14} />
        </button>
        <h2 className="m-0 text-[15px] font-medium text-ink">
          {rangeFormat.formatRange(noon(start), noon(end))}
        </h2>
        {(now < start || now >= last) && (
          <button
            type="button"
            onClick={() => setDay(today())}
            className="h-8 rounded-control px-2 text-[13px] text-ink-3 hover:bg-raised hover:text-ink"
          >
            Today
          </button>
        )}
        {undo && (
          <div
            role="status"
            className="ml-auto flex max-w-full items-center gap-1 rounded-control border border-line bg-overlay py-0.5 pr-0.5 pl-3 text-[13px] text-ink-2 shadow-2"
          >
            <span className="min-w-0 truncate">{undo.text}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                undo.revert();
                setUndo(null);
              }}
            >
              Undo
            </Button>
            <Button
              variant="quiet"
              size="iconSm"
              aria-label="Dismiss"
              onClick={() => setUndo(null)}
            >
              <Icon name="close" size={13} />
            </Button>
          </div>
        )}
      </div>
      {failure && (
        <p role="alert" className="m-0 text-[13px] text-signal">
          {failure.message}
        </p>
      )}
      <Card className="overflow-hidden">
        <div ref={scroller} className="scroll-quiet overflow-x-auto">
          <div
            className={cn(
              "relative min-w-[720px] [--name:128px] @3xl/app:[--name:180px]",
              drag && "select-none",
              drag?.mode === "move" && "cursor-grabbing",
              drag?.mode === "resize" && "cursor-ew-resize",
            )}
          >
            <div className="flex h-9 border-b border-line text-[11px] text-ink-3">
              <span className="sticky left-0 z-10 w-(--name) shrink-0 border-r border-line bg-pane" />
              <div ref={span} className="flex flex-1">
                {weeks.map((w) => (
                  <span key={w} className="flex-1 border-l border-line pl-1.5 leading-9">
                    {weekFormat.format(noon(w))}
                  </span>
                ))}
              </div>
            </div>
            <ol className="m-0 list-none p-0">
              {data.cards.map((card) => {
                // Each end on the day it is where the member is; the deadline follows the drag.
                const own = card.due ?? null;
                const dragging = drag?.kind === "track" && drag.id === card.id ? drag.days : 0;
                const settled = timelineBar(
                  {
                    version: card.version && {
                      ...card.version,
                      createdAt: dayHere(card.version.createdAt),
                    },
                    dueAt: card.dueAt && dayHere(card.dueAt),
                    due: own && dayHere(own),
                  },
                  start,
                  DAYS,
                );
                // Where no deadline is set, the bar's end is where one starts from.
                const base = trackDeadline(card) ?? (settled ? dueOn(settled.to) : null);
                const previewed = base && dragging ? shiftInstant(base, dragging) : null;
                const bar = previewed
                  ? timelineBar(
                      {
                        version: card.version && {
                          ...card.version,
                          createdAt: dayHere(card.version.createdAt),
                        },
                        dueAt: null,
                        due: dayHere(previewed),
                      },
                      start,
                      DAYS,
                    )
                  : settled;
                const finished = card.status !== null && done.has(card.status);
                const deadline = trackDeadline(card);
                const late =
                  !finished && deadline !== null && new Date(deadline).getTime() < Date.now();
                const label =
                  card.stage ??
                  card.status ??
                  (card.version ? `${capital(words.version)} ${card.version.number}` : "");
                const title = `${label}${bar ? `: ${weekFormat.formatRange(noon(bar.from), noon(bar.to))}` : ""}${own ? `, due ${dayFormat.format(new Date(own))}` : ""}${late ? ", late" : ""}`;
                return (
                  <li
                    key={card.id}
                    className="flex h-12 items-center border-b border-line last:border-b-0"
                  >
                    <Link
                      {...(card.version?.fileId
                        ? { to: "/files/$fileId", params: { fileId: card.version.fileId } }
                        : { to: "/tracks/$trackId", params: { trackId: card.id } })}
                      // Pinned: the weeks scroll beneath it.
                      data-e2e-overlap
                      className="sticky left-0 z-10 flex h-full w-(--name) shrink-0 items-center border-r border-line bg-pane px-4 text-[13px] text-ink hover:text-signal"
                    >
                      <span className="truncate">{card.name}</span>
                    </Link>
                    <div className="relative h-full flex-1">
                      {weeks.map((w, i) => (
                        <span
                          key={w}
                          aria-hidden="true"
                          className="absolute top-0 bottom-0 border-l border-line"
                          style={{ left: `${(i / WEEKS) * 100}%` }}
                        />
                      ))}
                      {bar ? (
                        <>
                          <span
                            title={title}
                            className={cn(
                              "group absolute top-3 h-6 rounded-[5px] text-[12px] leading-6",
                              bar.width >= FITS ? "px-2" : "px-1",
                              finished
                                ? "bg-ink text-ground"
                                : late
                                  ? "border border-signal/50 bg-signal/15 text-ink"
                                  : "bg-ink-3 text-ground",
                              dragging !== 0 && "ring-2 ring-signal/50",
                            )}
                            style={{ left: `${bar.left * 100}%`, width: `${bar.width * 100}%` }}
                          >
                            <span className="block truncate">
                              {bar.width >= FITS && label}
                              {own && (
                                <Icon
                                  name="flag"
                                  size={10}
                                  className={cn(
                                    "inline-block align-[-1px] opacity-80",
                                    bar.width >= FITS && "ml-1.5",
                                  )}
                                />
                              )}
                            </span>
                            {canDeadline && base && (
                              <Handle
                                onPointerDown={(e) =>
                                  startDrag(
                                    e,
                                    { kind: "track", id: card.id, mode: "resize" },
                                    (days) => setDeadline(card, shiftInstant(base, days)),
                                  )
                                }
                              />
                            )}
                          </span>
                          {bar.width < FITS && (
                            <span
                              aria-hidden="true"
                              className="absolute top-3 max-w-40 truncate text-[12px] leading-6 text-ink-3"
                              style={{ left: `calc(${(bar.left + bar.width) * 100}% + 6px)` }}
                            >
                              {label}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="absolute top-3.5 left-2 text-[12px] text-ink-3">
                          {card.version ? "Not in these weeks" : `No ${words.version} yet`}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
              {entries.length > 0 && (
                <li
                  aria-hidden="true"
                  className="flex h-8 items-center border-b border-line bg-sunken/40"
                >
                  <span className="eyebrow sticky left-0 z-10 flex h-full w-(--name) shrink-0 items-center border-r border-line bg-pane px-4">
                    Entries
                  </span>
                </li>
              )}
              {entries.map((entry) => {
                const mine = drag?.kind === "entry" && drag.id === entry.id ? drag : null;
                const range: DayRange = { startsOn: entry.startsOn, endsOn: entry.endsOn };
                const shown = mine
                  ? mine.mode === "move"
                    ? movedRange(range, mine.days)
                    : resizedRange(range, mine.days)
                  : range;
                const bar = timelineSpan(shown, start, DAYS);
                const when = shown.endsOn
                  ? dayFormat.formatRange(noon(shown.startsOn), noon(shown.endsOn))
                  : dayFormat.format(noon(shown.startsOn));
                const open = () => {
                  if (dragged.current) {
                    dragged.current = false;
                    return;
                  }
                  setOpening(entry);
                };
                const name = (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Icon name={entryIcon[entry.kind]} size={12} className="shrink-0 text-ink-3" />
                    <span className="truncate">{entry.title}</span>
                  </span>
                );
                return (
                  <li
                    key={entry.id}
                    className="flex h-12 items-center border-b border-line last:border-b-0"
                  >
                    {canEntries ? (
                      <button
                        type="button"
                        onClick={open}
                        data-e2e-overlap
                        className="sticky left-0 z-10 flex h-full w-(--name) shrink-0 items-center border-r border-line bg-pane px-4 text-left text-[13px] text-ink hover:text-signal"
                      >
                        {name}
                      </button>
                    ) : entry.sessionId ? (
                      <Link
                        to="/sessions/$sessionId"
                        params={{ sessionId: entry.sessionId }}
                        data-e2e-overlap
                        className="sticky left-0 z-10 flex h-full w-(--name) shrink-0 items-center border-r border-line bg-pane px-4 text-[13px] text-ink hover:text-signal"
                      >
                        {name}
                      </Link>
                    ) : (
                      <span
                        data-e2e-overlap
                        className="sticky left-0 z-10 flex h-full w-(--name) shrink-0 items-center border-r border-line bg-pane px-4 text-[13px] text-ink"
                      >
                        {name}
                      </span>
                    )}
                    <div className="relative h-full flex-1">
                      {weeks.map((w, i) => (
                        <span
                          key={w}
                          aria-hidden="true"
                          className="absolute top-0 bottom-0 border-l border-line"
                          style={{ left: `${(i / WEEKS) * 100}%` }}
                        />
                      ))}
                      {bar ? (
                        <>
                          {canEntries ? (
                            <button
                              type="button"
                              title={`${entry.title}: ${when}`}
                              aria-label={`${entry.title}, ${when}`}
                              onClick={open}
                              onPointerDown={(e) =>
                                startDrag(
                                  e,
                                  { kind: "entry", id: entry.id, mode: "move" },
                                  (days) => setRange(entry, movedRange(range, days)),
                                )
                              }
                              className={cn(
                                "group absolute top-3 h-6 min-w-6 cursor-grab rounded-[5px] border border-line-strong bg-raised text-left text-[12px] leading-6 text-ink hover:border-edge",
                                bar.width >= FITS && "px-2",
                                mine && "cursor-grabbing ring-2 ring-signal/50",
                              )}
                              style={{ left: `${bar.left * 100}%`, width: `${bar.width * 100}%` }}
                            >
                              <span className="block truncate">{bar.width >= FITS && when}</span>
                              <Handle
                                onPointerDown={(e) =>
                                  startDrag(
                                    e,
                                    { kind: "entry", id: entry.id, mode: "resize" },
                                    (days) => setRange(entry, resizedRange(range, days)),
                                  )
                                }
                              />
                            </button>
                          ) : (
                            <span
                              title={`${entry.title}: ${when}`}
                              className={cn(
                                "absolute top-3 h-6 min-w-6 rounded-[5px] border border-line-strong bg-raised text-[12px] leading-6 text-ink",
                                bar.width >= FITS && "px-2",
                              )}
                              style={{ left: `${bar.left * 100}%`, width: `${bar.width * 100}%` }}
                            >
                              <span className="block truncate">{bar.width >= FITS && when}</span>
                            </span>
                          )}
                          {bar.width < FITS && (
                            <span
                              aria-hidden="true"
                              className="absolute top-3 max-w-40 truncate text-[12px] leading-6 text-ink-3"
                              style={{ left: `calc(${(bar.left + bar.width) * 100}% + 6px)` }}
                            >
                              {when}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="absolute top-3.5 left-2 text-[12px] text-ink-3">
                          Not in these weeks
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
            {todayAt >= 0 && todayAt < 1 && (
              <span
                aria-hidden="true"
                data-e2e-overlap
                className="pointer-events-none absolute top-9 bottom-0 w-px bg-signal"
                style={{ left: `calc(var(--name) + ${todayAt} * (100% - var(--name)))` }}
              />
            )}
          </div>
        </div>
      </Card>
      <p className="m-0 text-[12px] text-ink-3">
        From each {words.track}'s latest {words.version} to its deadline, or to when its review is
        due, or a week on where neither is set
        {canDeadline ? "; drag a bar's end to set the deadline" : ""}
        {canEntries ? "; drag an entry to move it, or its end to change its length" : ""}.
      </p>
      {opening && (
        <EntryDialog projectId={projectId} entry={opening} onClose={() => setOpening(null)} />
      )}
    </div>
  );
}

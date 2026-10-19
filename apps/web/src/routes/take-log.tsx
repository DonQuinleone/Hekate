import { TAKE_RATING_MAX, type TakeChange, takeLifecycleNames, takeLogCsv } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { Kbd } from "~/components/kbd";
import { PageHeader } from "~/components/page-header";
import { openShortcutMap } from "~/components/shortcut-map";
import { Rating } from "~/components/takes";
import { Button } from "~/components/ui/button";
import { Input, Select } from "~/components/ui/input";
import { Segmented } from "~/components/ui/segmented";
import { cn } from "~/lib/cn";
import { formatDates } from "~/lib/locale";
import { projectQuery, sessionQuery, useProjectCan, useTakeLog } from "~/lib/queries";
import { useShortcuts } from "~/lib/shortcuts";
import {
  clock,
  keyTake,
  type LoggedTake,
  liveTake,
  logOrder,
  nextTrack,
  rolled,
  SLOT_WARNING,
  slotLeft,
} from "~/lib/take-log";

type View = "engineer" | "producer" | "logger";

const views: { value: View; label: string }[] = [
  { value: "engineer", label: "Engineer" },
  { value: "producer", label: "Producer" },
  { value: "logger", label: "Logger" },
];

const timeOfDay = formatDates({ hour: "2-digit", minute: "2-digit" });

/** The present, again every quarter second: the clocks read it, never count it. */
function useNow(every = 250) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(id);
  }, [every]);
  return now;
}

/** "p. 4 · bars 65–88", as far as the take says. */
const scoreOf = (t: LoggedTake) =>
  [
    t.page ? `p. ${t.page}${t.pageTo && t.pageTo !== t.page ? `–${t.pageTo}` : ""}` : null,
    t.barFrom !== null ? `bars ${t.barFrom}–${t.barTo ?? t.barFrom}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

/** Words for a take without notes, where its state says something. */
const stateWords = (t: LoggedTake) =>
  t.lifecycle === "recording"
    ? "recording…"
    : t.lifecycle === "armed"
      ? "armed"
      : t.lifecycle === "aborted"
        ? "aborted"
        : "";

/**
 * The take log (#51): the control room's record of a session, keyboard first. Space starts the
 * next take and stops it; the take rolling, or the last, takes a rating, a star, a false start
 * and a note from single keys. Each person in the room picks their view of the same log, read
 * again every two seconds, so what one logs the others see.
 */
export function TakeLogPage({ sessionId }: { sessionId: string }) {
  const {
    data: session,
    error,
    isError,
  } = useQuery({
    ...sessionQuery(sessionId),
    refetchInterval: 2000,
  });
  const { data: project } = useQuery({
    ...projectQuery(session?.projectId ?? ""),
    enabled: Boolean(session),
  });
  const can = useProjectCan(session?.projectId);
  const { start, change } = useTakeLog(sessionId);
  const now = useNow();
  const [view, setView] = useState<View>("producer");
  const [chosen, setChosen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const noteField = useRef<HTMLInputElement>(null);

  const rows = session ? logOrder(session.takeRows) : [];
  const current = liveTake(rows);
  const target = keyTake(rows);
  const canLog = Boolean(session && project && can("edit_takes") && !project.archivedAt);
  const trackId = session ? nextTrack(chosen, rows, session.tracks) : null;
  const next = trackId ? session?.nextNumbers[trackId] : undefined;

  // The note field follows the take the keys act on.
  const noteFor = target?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the take changes.
  useEffect(() => setNote(target?.notes ?? ""), [noteFor]);

  const move = (lifecycle: LoggedTake["lifecycle"]) =>
    current && change.mutate({ id: current.id, lifecycle });
  const toggle = () => {
    if (!canLog || start.isPending) return;
    if (current?.lifecycle === "recording") return move("recorded");
    if (current?.lifecycle === "armed") return move("recording");
    if (trackId) start.mutate({ trackId, lifecycle: "recording" });
  };
  const arm = () => {
    if (!canLog || current || !trackId) return;
    start.mutate({ trackId, lifecycle: "armed" });
  };
  const onTarget = (patch: TakeChange) => target && change.mutate({ id: target.id, ...patch });
  const saveNote = () => {
    if (!target || note.trim() === (target.notes ?? "")) return;
    change.mutate({ id: target.id, notes: note.trim() || null });
  };
  const exportCsv = () => {
    if (!session) return;
    const blob = new Blob([takeLogCsv(rows)], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${session.name} take log.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  useShortcuts(
    "take-log",
    "Take log",
    [
      { keys: ["Space"], label: "Start the next take, or stop the one recording", run: toggle },
      { keys: ["a"], label: "Arm the next take", run: arm },
      {
        keys: ["x"],
        label: "Abort the take recording",
        run: () => current && move("aborted"),
      },
      {
        keys: ["f"],
        label: "Count a false start",
        run: () => target && onTarget({ falseStarts: target.falseStarts + 1 }),
      },
      ...Array.from({ length: TAKE_RATING_MAX }, (_, i) => ({
        keys: [String(i + 1)],
        label: i === 0 ? "Rate the last take, 1 to 5" : `Rate ${i + 1}`,
        run: () => onTarget({ rating: i + 1 }),
      })),
      {
        keys: ["s"],
        label: "Star the last take",
        run: () => target && onTarget({ starred: !target.starred }),
      },
      {
        keys: ["n"],
        label: "Note on the last take",
        run: () => noteField.current?.focus(),
      },
    ],
    canLog,
  );

  if (error && !session) return <p className="p-8 text-signal">{error.message}</p>;
  if (!session || !project) return <p className="p-8 text-ink-3">Loading</p>;

  const recording = current?.lifecycle === "recording";
  const armed = current?.lifecycle === "armed";
  const left = slotLeft(session, now);
  const slot =
    session.slotStart && session.slotEnd
      ? `${timeOfDay.format(new Date(session.slotStart))}–${timeOfDay.format(new Date(session.slotEnd))}`
      : null;
  const trackName = (id: string | null) => session.tracks.find((t) => t.id === id)?.name ?? "";

  return (
    <>
      <PageHeader
        crumbs={[
          { key: "projects", link: <Link to="/projects">Projects</Link> },
          {
            key: "project",
            link: (
              <Link to="/projects/$projectId" params={{ projectId: project.id }}>
                {project.name}
              </Link>
            ),
          },
          {
            key: "session",
            link: (
              <Link to="/sessions/$sessionId" params={{ sessionId: session.id }}>
                {session.name}
              </Link>
            ),
          },
        ]}
        title="Take log"
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={exportCsv} disabled={rows.length === 0}>
              <Icon name="download" size={14} />
              CSV
            </Button>
            <Button
              variant="ghost"
              size="iconSm"
              aria-label="Keys"
              title="Keys"
              onClick={openShortcutMap}
            >
              <Kbd>?</Kbd>
            </Button>
          </>
        }
      />
      <div className="fade-in mx-auto flex w-full max-w-[1360px] flex-col gap-4 px-5 py-6 @3xl/app:px-10">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Segmented label="View" value={view} options={views} onChange={setView} />
          <span className="text-[12px] text-ink-3">
            The same take log, a view per person in the room.
          </span>
          <span
            role="status"
            className={cn(
              "ml-auto flex items-center gap-1.5 text-[12px]",
              isError ? "text-signal" : "text-ink-3",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-[7px] rounded-full",
                isError ? "border-[1.5px] border-signal" : "bg-ink-3",
              )}
            />
            {isError
              ? "Not connected: takes cannot be logged until it returns"
              : "Live for everyone in the room"}
          </span>
        </div>

        {session.tracks.length === 0 ? (
          <Empty
            title="No tracks for this session"
            text="Give the session the tracks it records, then log their takes here."
          />
        ) : (
          <>
            <section
              aria-label="Transport"
              className={cn(
                "flex flex-wrap items-center gap-4 rounded-panel border p-4 transition-colors",
                recording ? "border-signal/50 bg-signal/[0.06]" : "border-hairline bg-surface",
              )}
            >
              <button
                type="button"
                onClick={toggle}
                disabled={!canLog || start.isPending}
                className={cn(
                  "flex h-14 cursor-pointer items-center gap-3 rounded-full border-0 px-6 text-[16px] font-medium shadow-2 transition-colors disabled:cursor-default disabled:opacity-50",
                  recording ? "bg-signal text-ground" : "bg-ink text-ground hover:bg-ink/90",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-3 rounded-full",
                    recording ? "breathe bg-ground" : "bg-signal",
                  )}
                />
                {recording
                  ? `Stop take ${current?.number}`
                  : armed
                    ? `Roll take ${current?.number}`
                    : next
                      ? `Start take ${next}`
                      : "Start the next take"}
                <Kbd>Space</Kbd>
              </button>
              <div className="flex min-w-0 flex-col">
                <span className="tabular text-[28px] leading-8 text-ink">
                  {clock(current ? rolled(current, now) : 0)}
                </span>
                <span className="text-[12px] text-ink-3">
                  {recording ? "recording" : armed ? "armed" : "idle"}
                  {current?.timecodeIn ? ` · timecode in ${current.timecodeIn}` : ""}
                </span>
              </div>
              <label className="flex min-w-0 flex-col gap-1 text-[12px] text-ink-3">
                Track
                <Select
                  size="sm"
                  value={trackId ?? ""}
                  disabled={Boolean(current)}
                  onChange={(e) => setChosen(e.target.value)}
                  className="w-auto min-w-[180px]"
                >
                  {session.tracks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </label>
              <div className="ml-auto flex flex-col items-end">
                {left !== null && (
                  <span
                    className={cn(
                      "tabular text-[22px] leading-7",
                      left < SLOT_WARNING ? "text-signal" : "text-ink",
                    )}
                  >
                    {clock(left)}
                    <span className="text-[13px] text-ink-3"> to slot end</span>
                  </span>
                )}
                <span className="text-[12px] text-ink-3">
                  {[session.venue, slot, `wall clock ${timeOfDay.format(new Date(now))}`]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
            </section>

            {target && canLog && (
              <div className="flex flex-wrap items-center gap-3">
                <label htmlFor="take-note" className="text-[13px] text-ink-2">
                  Note on T{target.number}
                </label>
                <Input
                  id="take-note"
                  ref={noteField}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  onBlur={saveNote}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      saveNote();
                      e.currentTarget.blur();
                    }
                    if (e.key === "Escape") {
                      setNote(target.notes ?? "");
                      e.currentTarget.blur();
                    }
                  }}
                  maxLength={4000}
                  placeholder="Good opening; pick up bar 17"
                  className="min-w-0 flex-1"
                />
              </div>
            )}

            {rows.length === 0 ? (
              <Empty
                title="No takes logged yet"
                text={
                  canLog
                    ? "Press Space to start the first take, or A to arm it."
                    : "Takes appear here as they are logged."
                }
              />
            ) : view === "logger" ? (
              // A wide table scrolls on its own on a phone; the page does not.
              <section
                aria-label="Takes"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region needs focus.
                tabIndex={0}
                className="overflow-x-auto rounded-panel border border-hairline bg-surface focus-visible:border-edge focus-visible:outline-none"
              >
                <table className="w-full min-w-[760px] border-collapse text-[13px]">
                  <thead>
                    <tr className="text-left text-[12px] text-ink-3">
                      {[
                        "Take",
                        "Track",
                        "In",
                        "Out",
                        "Wall clock",
                        "Rating",
                        "False starts",
                        "Notes",
                        "Score",
                      ].map((h) => (
                        <th key={h} className="px-3 py-2 font-normal">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((t) => (
                      <tr
                        key={t.id}
                        className={cn(
                          "border-t border-hairline",
                          t.lifecycle === "recording" && "bg-signal/[0.06]",
                          t.lifecycle === "aborted" && "opacity-50",
                        )}
                      >
                        <td className="tabular px-3 py-1.5 font-medium text-ink">T{t.number}</td>
                        <td className="px-3 py-1.5 text-ink-2">{t.track.name}</td>
                        <td className="tabular px-3 py-1.5 text-ink-3">{t.timecodeIn}</td>
                        <td className="tabular px-3 py-1.5 text-ink-3">
                          {t.timecodeOut ?? (t.lifecycle === "recording" ? "…" : "")}
                        </td>
                        <td className="tabular px-3 py-1.5 text-ink-3">
                          {t.wallIn ? timeOfDay.format(new Date(t.wallIn)) : ""}
                        </td>
                        <td className="px-3 py-1.5">
                          <Rating value={t.rating} />
                        </td>
                        <td className="tabular px-3 py-1.5 text-ink-3">{t.falseStarts || ""}</td>
                        <td className="max-w-[320px] truncate px-3 py-1.5 text-ink-2">
                          {t.notes || stateWords(t)}
                        </td>
                        <td className="tabular px-3 py-1.5 text-ink-3">{scoreOf(t)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            ) : (
              <ul
                aria-label="Takes"
                className="m-0 flex list-none flex-col divide-y divide-hairline rounded-panel border border-hairline bg-surface p-0"
              >
                {rows.map((t) => (
                  <li
                    key={t.id}
                    className={cn(
                      "flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[14px]",
                      t.lifecycle === "recording" && "bg-signal/[0.06]",
                      t.lifecycle === "aborted" && "opacity-50",
                    )}
                  >
                    <span
                      className={cn(
                        "tabular inline-flex w-12 items-center gap-1 font-medium",
                        t.lifecycle === "recording" ? "text-signal" : "text-ink",
                      )}
                    >
                      T{t.number}
                      {t.starred && (
                        <Icon
                          name="star"
                          size={11}
                          fill="currentColor"
                          aria-label="Starred"
                          className="text-ink-2"
                        />
                      )}
                    </span>
                    <Rating value={t.rating} />
                    <span className="min-w-0 flex-1 truncate text-ink-2">
                      {t.notes || stateWords(t)}
                    </span>
                    {session.tracks.length > 1 && (
                      <span className="text-[12px] text-ink-3">{trackName(t.track.id)}</span>
                    )}
                    {t.falseStarts > 0 && (
                      <span className="text-[12px] text-ink-3">
                        {t.falseStarts} false {t.falseStarts === 1 ? "start" : "starts"}
                      </span>
                    )}
                    {view === "producer" && scoreOf(t) && (
                      <span className="tabular text-[12px] text-ink-3">{scoreOf(t)}</span>
                    )}
                    {view === "engineer" && (t.timecodeIn || t.timecodeOut) && (
                      <span className="tabular text-[12px] text-ink-3">
                        {t.timecodeIn ?? "…"} – {t.timecodeOut ?? "…"}
                      </span>
                    )}
                    {view === "engineer" && t.wallIn && (
                      <span className="tabular text-[12px] text-ink-3">
                        {clock(rolled(t, now))}
                      </span>
                    )}
                    <span className="sr-only">{takeLifecycleNames[t.lifecycle]}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </>
  );
}

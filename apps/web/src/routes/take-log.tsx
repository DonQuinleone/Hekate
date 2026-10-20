import {
  type SessionDetail,
  TAKE_RATING_MAX,
  type TakeChange,
  takeLifecycleNames,
  takeLogCsv,
} from "@hekate/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { Kbd } from "~/components/kbd";
import { PageHeader } from "~/components/page-header";
import { openShortcutMap } from "~/components/shortcut-map";
import { TakeOverview } from "~/components/take-overview";
import { Rating } from "~/components/takes";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/choice";
import { Input, Select, Textarea } from "~/components/ui/input";
import { Segmented } from "~/components/ui/segmented";
import { Switch } from "~/components/ui/toggle";
import { cn } from "~/lib/cn";
import { formatDates } from "~/lib/locale";
import { projectQuery, sessionQuery, useProjectCan, useTakeOutbox, viewQuery } from "~/lib/queries";
import { TEMPO_MAX, TEMPO_MIN, TONES, tempoOf, useReferenceAudio } from "~/lib/reference-audio";
import { useShortcuts } from "~/lib/shortcuts";
import {
  clock,
  keyTake,
  type LoggedTake,
  liveTake,
  logOrder,
  nextTrack,
  rolled,
  slotStatus,
} from "~/lib/take-log";
import { withPending } from "~/lib/take-outbox";

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
    data: served,
    error,
    isError,
  } = useQuery({
    ...sessionQuery(sessionId),
    refetchInterval: 2000,
  });
  // Written here first (#51): the server's session, with what this browser has yet to send.
  const outbox = useTakeOutbox(sessionId);
  const session = served ? withPending(served, outbox.pending) : undefined;
  const offline = isError || outbox.waiting;
  const { data: project } = useQuery({
    ...projectQuery(session?.projectId ?? ""),
    enabled: Boolean(session),
  });
  const can = useProjectCan(session?.projectId);
  const now = useNow();
  const [view, setView] = useState<View>("producer");
  const [chosen, setChosen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  /** Whether the note has been typed in since it was last saved or read. */
  const [noteDirty, setNoteDirty] = useState(false);
  /** The recorder's number for the next take, in a session the recorder numbers. */
  const [recorderNumber, setRecorderNumber] = useState("");
  const noteField = useRef<HTMLInputElement>(null);
  /** The log in large print, for the far side of the room. */
  const [large, setLarge] = useState(false);

  const rows = session ? logOrder(session.takeRows) : [];
  const current = liveTake(rows);
  const target = keyTake(rows);
  // Logged while the server cannot be reached too: the outbox sends it when it returns.
  const canLog = Boolean(session && project && can("edit_takes") && !project.archivedAt);
  const trackId = session ? nextTrack(chosen, rows, session.tracks) : null;
  const next = trackId ? session?.nextNumbers[trackId] : undefined;

  // The note field follows the take the keys act on, and takes up someone else's change to
  // its note unless it is being typed in, so it never writes an old note back over theirs.
  const noteFor = target?.id;
  const remoteNote = target?.notes ?? "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the take changes.
  useEffect(() => {
    setNoteDirty(false);
    setNote(remoteNote);
  }, [noteFor]);
  useEffect(() => {
    if (!noteDirty) setNote(remoteNote);
  }, [remoteNote, noteDirty]);
  const recorded = session?.numbering === "recorder";
  const recorderValue = Number.parseInt(recorderNumber || String(next ?? ""), 10);

  const move = (lifecycle: LoggedTake["lifecycle"]) =>
    current && outbox.change(current, { lifecycle });
  const toggle = () => {
    if (!canLog) return;
    if (current?.lifecycle === "recording") return move("recorded");
    if (current?.lifecycle === "armed") return move("recording");
    begin("recording");
  };
  const arm = () => {
    if (!canLog || current) return;
    begin("armed");
  };
  /** The next take, with the recorder's number where the recorder numbers them. */
  const begin = (lifecycle: "armed" | "recording") => {
    if (!trackId) return;
    if (recorded && !(recorderValue >= 1)) return;
    void outbox.start(
      { trackId, lifecycle, ...(recorded ? { number: recorderValue } : {}) },
      recorded ? recorderValue : (next ?? 1),
    );
    setRecorderNumber("");
  };
  const onTarget = (patch: TakeChange) => target && outbox.change(target, patch);
  const saveNote = () => {
    setNoteDirty(false);
    if (!target || note.trim() === (target.notes ?? "")) return;
    void outbox.change(target, { notes: note.trim() || null });
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
  useShortcuts("take-log-view", "Take log", [
    { keys: ["l"], label: "Large print, or back", run: () => setLarge((on) => !on) },
  ]);

  if (error && !session) return <p className="p-8 text-signal">{error.message}</p>;
  if (!session || !project) return <p className="p-8 text-ink-3">Loading</p>;

  const recording = current?.lifecycle === "recording";
  const armed = current?.lifecycle === "armed";
  const slotNow = slotStatus(session, now);
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
            <Button variant="ghost" size="sm" onClick={() => setLarge(true)}>
              Large print
            </Button>
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
              offline ? "text-signal" : "text-ink-3",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-[7px] rounded-full",
                offline ? "border-[1.5px] border-signal" : "bg-ink-3",
              )}
            />
            {offline
              ? "Offline: written here, synced when back"
              : outbox.pending.length > 0
                ? "Syncing"
                : "Live for everyone in the room"}
            {outbox.pending.length > 0 && (
              <span className="tabular text-ink-3">
                · {outbox.pending.length} waiting to send
                {outbox.durable ? "" : "; keep this page open until they are"}
              </span>
            )}
          </span>
        </div>

        {session.tracks.length === 0 ? (
          <Empty
            title="No tracks for this session"
            text="Give the session the tracks it records, then log their takes here."
          />
        ) : (
          <div
            className={cn(
              "grid items-start gap-4",
              view === "producer"
                ? "lg:grid-cols-[minmax(0,1fr)_320px]"
                : "lg:grid-cols-[minmax(0,1fr)_260px]",
            )}
          >
            <div className="flex min-w-0 flex-col gap-4">
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
                  disabled={!canLog}
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
                      : (recorded ? recorderValue : next)
                        ? `Start take ${recorded ? recorderValue : next}`
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
                {recorded && !current && (
                  <label className="flex flex-col gap-1 text-[12px] text-ink-3">
                    Recorder's take
                    <Input
                      size="sm"
                      type="number"
                      min={1}
                      inputMode="numeric"
                      value={recorderNumber}
                      placeholder={next ? String(next) : ""}
                      onChange={(e) => setRecorderNumber(e.target.value)}
                      className="w-24"
                    />
                  </label>
                )}
                <div className="ml-auto flex flex-col items-end">
                  {slotNow && (
                    <span
                      className={cn(
                        "tabular text-[22px] leading-7",
                        slotNow.kind === "plenty" ? "text-ink" : "text-signal",
                      )}
                    >
                      {slotNow.kind === "over"
                        ? `${clock(slotNow.over)} over`
                        : clock(slotNow.left)}
                      <span className="text-[13px] text-ink-3">
                        {slotNow.kind === "over" ? " the slot" : " to slot end"}
                      </span>
                    </span>
                  )}
                  <span className="text-[12px] text-ink-3">
                    {[session.venue, slot, `wall clock ${timeOfDay.format(new Date(now))}`]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
              </section>
              {outbox.problem && (
                <p role="alert" className="m-0 text-[13px] text-signal">
                  {outbox.problem}
                </p>
              )}

              {target && canLog && (
                <div className="flex flex-wrap items-center gap-3">
                  <label htmlFor="take-note" className="text-[13px] text-ink-2">
                    Note on T{target.number}
                  </label>
                  <Input
                    id="take-note"
                    ref={noteField}
                    value={note}
                    onChange={(e) => {
                      setNote(e.target.value);
                      setNoteDirty(true);
                    }}
                    onBlur={saveNote}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        saveNote();
                        e.currentTarget.blur();
                      }
                      if (e.key === "Escape") {
                        setNoteDirty(false);
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
            </div>
            <TakeLogAside
              outbox={outbox}
              session={session}
              view={view}
              target={target}
              trackId={trackId}
              canLog={canLog}
            />
          </div>
        )}
      </div>
      {large && (
        <TakeOverview
          session={session.name}
          track={trackName(current?.track.id ?? trackId)}
          number={current?.number ?? ((recorded ? recorderValue : next) || null)}
          live={recording ? "recording" : armed ? "armed" : null}
          seconds={current ? rolled(current, now) : 0}
          slot={slotNow}
          wallClock={timeOfDay.format(new Date(now))}
          last={rows.filter((t) => t.id !== current?.id).at(-1) ?? null}
          onClose={() => setLarge(false)}
        />
      )}
    </>
  );
}

/**
 * Words the room shares (the session's notes, the producer's quick reference): saved when the
 * field is left, and taking up someone else's change whenever it is not being typed in.
 */
function SharedText({
  label,
  value,
  onSave,
  disabled,
  rows = 3,
  maxLength,
  placeholder,
}: {
  label: string;
  value: string | null;
  onSave: (text: string | null) => Promise<unknown>;
  disabled: boolean;
  rows?: number;
  maxLength: number;
  placeholder?: string;
}) {
  const [text, setText] = useState(value ?? "");
  const [dirty, setDirty] = useState(false);
  const [failed, setFailed] = useState(false);
  const latest = useRef(text);
  latest.current = text;
  useEffect(() => {
    if (!dirty) setText(value ?? "");
  }, [value, dirty]);
  const id = useId();
  // The draft stays until the server has it: a failed save keeps it, and says so.
  const save = () => {
    const sent = text.trim();
    if (sent === (value ?? "")) {
      setDirty(false);
      return;
    }
    setFailed(false);
    onSave(sent || null).then(
      () => {
        if (latest.current.trim() === sent) setDirty(false);
      },
      () => setFailed(true),
    );
  };
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className="label m-0">
        {label}
      </h2>
      <Textarea
        aria-labelledby={id}
        rows={rows}
        value={text}
        disabled={disabled}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
        }}
        onBlur={() => {
          if (dirty) save();
        }}
        className="text-[13px]"
      />
      {failed && (
        <p role="alert" className="m-0 flex items-center gap-2 text-[13px] text-signal">
          Not saved.
          <Button variant="quiet" size="sm" onClick={save}>
            Try again
          </Button>
        </p>
      )}
    </section>
  );
}

/** The page of the score a take starts on, as the server drew it; nothing until it is drawn. */
function ScorePage({
  scoreFileId,
  page,
  title,
}: {
  scoreFileId: string;
  page: number;
  title: string;
}) {
  const client = useQueryClient();
  const { data } = useQuery({ ...viewQuery(scoreFileId), retry: false });
  /** The link that would not load (lapsed, or the connection is down): hidden, not broken. */
  const [failed, setFailed] = useState<string | null>(null);
  // Only the page asked for: another page under this heading would send the room to the wrong bars.
  const shown = data?.pages.find((p) => p.page === page);
  if (!shown || failed === shown.url) return null;
  // Links lapse after a few hours: when one fails, ask for fresh ones.
  const refresh = () => {
    setFailed(shown.url);
    void client.invalidateQueries({ queryKey: viewQuery(scoreFileId).queryKey });
  };
  return (
    <section aria-label="Score" className="flex flex-col gap-2">
      <h2 className="label m-0">{title}</h2>
      <img
        src={shown.url}
        alt={`Page ${shown.page} of the score`}
        width={shown.width}
        height={shown.height}
        onError={refresh}
        className="h-auto w-full rounded-[4px] bg-ground"
      />
    </section>
  );
}

/** A tuning tone and a metronome for whoever has this page open, heard on their device only. */
function ToneAndMetronome() {
  const audio = useReferenceAudio();
  const id = useId();
  const [typed, setTyped] = useState(String(audio.tempo));
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className="label m-0">
        Tone and metronome
      </h2>
      <div className="grid grid-cols-4 gap-1">
        {TONES.map((hz) => (
          <Button
            key={hz}
            size="sm"
            variant="secondary"
            aria-pressed={audio.tone === hz}
            onClick={() => audio.setTone(audio.tone === hz ? null : hz)}
            className="tabular px-0 aria-pressed:border-signal/60 aria-pressed:bg-signal/10"
          >
            {hz} Hz
          </Button>
        ))}
      </div>
      <div className="flex items-center gap-2 text-[13px] text-ink">
        <span className="flex flex-1 items-center gap-2">
          Metronome
          <Input
            aria-label="Tempo, beats a minute"
            size="sm"
            type="number"
            inputMode="numeric"
            min={TEMPO_MIN}
            max={TEMPO_MAX}
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
              const bpm = tempoOf(e.target.valueAsNumber);
              if (bpm != null && bpm === e.target.valueAsNumber) audio.setTempo(bpm);
            }}
            onBlur={() => {
              const bpm = tempoOf(Number.parseFloat(typed)) ?? audio.tempo;
              audio.setTempo(bpm);
              setTyped(String(bpm));
            }}
            className="tabular w-16"
          />
          <span aria-hidden="true" className="text-ink-3">
            bpm
          </span>
        </span>
        <Switch label="Metronome" checked={audio.metronome} onChange={audio.setMetronome} />
      </div>
      {audio.outputs.length > 0 && (
        <Select
          size="sm"
          aria-label="Play through"
          value={audio.output}
          onChange={(e) => audio.setOutput(e.target.value)}
        >
          <option value="">This device's default output</option>
          {audio.outputs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </Select>
      )}
      {audio.pick && (
        <Button size="sm" variant="ghost" onClick={audio.pick} className="self-start">
          Choose an output
        </Button>
      )}
    </section>
  );
}

/**
 * Beside the log (#51): for the producer, the score where the take starts, the room's to-do
 * list and the quick reference; for everyone, the session's notes. Written here first, as the
 * log is, and sent when the server can be reached.
 */
function TakeLogAside({
  outbox,
  session,
  view,
  target,
  trackId,
  canLog,
}: {
  outbox: ReturnType<typeof useTakeOutbox>;
  session: SessionDetail;
  view: View;
  target: LoggedTake | null;
  trackId: string | null;
  canLog: boolean;
}) {
  const [todo, setTodo] = useState("");
  const scoreFileId = session.tracks.find(
    (t) => t.id === (target?.track.id ?? trackId),
  )?.scoreFileId;
  const page = target?.page ?? 1;
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!todo.trim()) return;
    void outbox.addTodo(todo.trim());
    setTodo("");
  };
  return (
    <aside aria-label="Beside the log" className="flex min-w-0 flex-col gap-5">
      {view === "producer" && (
        <>
          {scoreFileId && (
            <ScorePage
              scoreFileId={scoreFileId}
              page={page}
              title={
                target?.barFrom != null
                  ? `Score, bar ${target.barFrom} onwards`
                  : `Score, page ${page}`
              }
            />
          )}
          <section aria-label="To do" className="flex flex-col gap-2">
            <h2 className="label m-0">To do</h2>
            {session.todos.length > 0 && (
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px]">
                {session.todos.map((t) => (
                  <li key={t.id} className="group flex items-center gap-2">
                    <label className="flex min-w-0 flex-1 items-center gap-2">
                      <Checkbox
                        checked={t.done}
                        disabled={!canLog}
                        onChange={(e) => void outbox.changeTodo(t.id, { done: e.target.checked })}
                      />
                      <span
                        className={cn("min-w-0", t.done ? "text-ink-3 line-through" : "text-ink")}
                      >
                        {t.text}
                      </span>
                    </label>
                    {canLog && (
                      <Button
                        variant="quiet"
                        size="iconSm"
                        aria-label={`Remove ${t.text}`}
                        onClick={() => void outbox.removeTodo(t.id)}
                        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      >
                        <Icon name="close" size={12} />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canLog && (
              <form onSubmit={add} className="flex gap-2">
                <Input
                  size="sm"
                  value={todo}
                  maxLength={200}
                  aria-label="Something to do"
                  placeholder="Add something to do"
                  onChange={(e) => setTodo(e.target.value)}
                  className="min-w-0 flex-1"
                />
                <Button type="submit" variant="secondary" size="sm" disabled={!todo.trim()}>
                  Add
                </Button>
              </form>
            )}
          </section>
          <SharedText
            label="Quick reference"
            value={session.reference}
            disabled={!canLog}
            rows={2}
            maxLength={2000}
            placeholder="Trio from bar 65; coda at 89"
            onSave={(reference) => outbox.notes({ reference })}
          />
        </>
      )}
      <ToneAndMetronome />
      <SharedText
        label="Notes"
        value={session.notes}
        disabled={!canLog}
        maxLength={4000}
        placeholder="Piano a touch bright after lunch"
        onSave={(text) => outbox.notes({ notes: text })}
      />
    </aside>
  );
}

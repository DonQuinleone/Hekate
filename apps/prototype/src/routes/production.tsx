import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Avatar } from "~/components/avatar";
import { Icon, type IconName } from "~/components/icons";
import { Kbd, Label } from "~/components/label";
import { Page } from "~/components/pages";
import { Dot } from "~/components/status";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Input, Select, Textarea } from "~/components/ui/input";
import { ActionMenu, Dropdown } from "~/components/ui/menu";
import { Switch } from "~/components/ui/toggle";
import {
  fileById,
  type Project,
  patchList,
  personnel,
  type ScoreMark,
  schedule,
  scoreMarks,
  stagePlan,
  takes,
  trackById,
  tracks,
  venues,
  works,
} from "~/data";
import { cn } from "~/lib/cn";
import { inField } from "~/lib/dom";
import { formatLongDate } from "~/lib/format";
import { useViewer } from "~/viewer/context";
import { Empty, Refused, useScreenState } from "~/viewer/state-gate";
import { SessionsView } from "./takes.tsx";

export const productionSections = [
  { id: "repertoire", label: "Repertoire" },
  { id: "schedule", label: "Schedule" },
  { id: "sessions", label: "Sessions" },
  { id: "takelog", label: "Take log" },
  { id: "marking", label: "Score marking" },
  { id: "stage", label: "Stage plan" },
  { id: "patch", label: "Patch list" },
  { id: "personnel", label: "Personnel" },
  { id: "venues", label: "Venues" },
  { id: "import", label: "Import" },
];

/* ---------- Repertoire, venues, personnel ---------- */

function Repertoire() {
  const [order, setOrder] = useState<"alpha" | "schedule">("schedule");
  const state = useScreenState();
  const list = state === "empty" ? [] : works;
  if (list.length === 0)
    return (
      <Empty
        title="No works yet"
        text="A work holds its tracks in order, the score, and each track's printed pages."
        action={<Button variant="primary">Add a work</Button>}
      />
    );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Label>Works · {list.length}</Label>
        <span className="ml-auto flex items-center gap-1">
          <Dropdown
            value={order === "alpha" ? "Alphabetical" : "Schedule order"}
            align="right"
            actions={[
              {
                label: "Schedule order",
                checked: order === "schedule",
                onSelect: () => setOrder("schedule"),
              },
              {
                label: "Alphabetical",
                checked: order === "alpha",
                onSelect: () => setOrder("alpha"),
              },
            ]}
          />
          <Button variant="secondary" size="md">
            <Icon name="plus" size={14} />
            Work
          </Button>
        </span>
      </div>
      {list.map((w) => {
        const score = w.scoreFileId ? fileById(w.scoreFileId) : undefined;
        return (
          <section key={w.id} className="rounded-panel-lg border border-line bg-raised/25 shadow-1">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-4 py-3">
              <h3 className="text-[16px] font-medium text-ink">{w.title}</h3>
              <span className="text-[13px] text-ink-3">
                {w.composer} · {w.forces} · {w.abbreviation}
              </span>
              <span className="ml-auto flex items-center gap-2 text-[13px] text-ink-3">
                {score && (
                  <Link
                    to="/files/$fileId"
                    params={{ fileId: score.id }}
                    className="flex items-center gap-1.5 text-ink-2 hover:text-ink"
                  >
                    <Icon name="score" size={14} />
                    {score.name}
                  </Link>
                )}
                <span>page offset {w.pageOffset}</span>
                <ActionMenu
                  always
                  label={w.title}
                  actions={[
                    { label: "Edit", onSelect: () => {} },
                    { label: "Swap the score, keeping marks", onSelect: () => {} },
                    "divider",
                    { label: "Delete", danger: true, onSelect: () => {} },
                  ]}
                />
              </span>
            </div>
            {w.notes && <p className="px-4 pt-3 text-[13px] text-ink-2">{w.notes}</p>}
            <ol className="flex flex-col divide-y divide-line px-2 py-2">
              {w.trackIds.map((id, i) => {
                const t = trackById(id);
                const pages = w.pages.find((p) => p.trackId === id);
                return (
                  <li
                    key={id}
                    className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 px-2 py-2 text-[14px]"
                  >
                    <Input
                      defaultValue={["1", "2", "3", "4", "5"][i]}
                      aria-label="Number as typed"
                      className="h-7 w-8 px-0 text-center text-[13px]"
                    />
                    <Link
                      to="/tracks/$trackId"
                      params={{ trackId: id }}
                      className="truncate text-ink hover:text-signal"
                    >
                      {t?.name}
                    </Link>
                    <span className="tabular text-[13px] text-ink-3">
                      {pages ? `pp. ${pages.from}–${pages.to}` : "pages not set"}
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

function Venues() {
  const state = useScreenState();
  const list = state === "empty" ? [] : venues;
  if (list.length === 0)
    return (
      <Empty
        title="No venues yet"
        text="A venue has an address and notes for the get-in."
        action={<Button variant="primary">Add a venue</Button>}
      />
    );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Label>Venues · {list.length}</Label>
        <Button variant="secondary" size="md" className="ml-auto">
          <Icon name="plus" size={14} />
          Venue
        </Button>
      </div>
      <ul className="-mx-2 flex flex-col">
        {list.map((v) => (
          <li
            key={v.id}
            className="group flex items-start gap-3 rounded-panel px-2 py-2.5 transition-colors hover:bg-raised/60"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-panel bg-raised text-ink-2">
              <Icon name="pin" size={16} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-medium text-ink">{v.name}</span>
              <span className="block text-[13px] text-ink-3">{v.address.join(", ")}</span>
              {v.notes && <span className="block text-[13px] text-ink-2">{v.notes}</span>}
            </span>
            <ActionMenu
              label={v.name}
              actions={[
                { label: "Edit", onSelect: () => {} },
                "divider",
                { label: "Delete", danger: true, onSelect: () => {} },
              ]}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function PersonnelView() {
  const [open, setOpen] = useState<string | null>("pe-5");
  const state = useScreenState();
  const list = state === "empty" ? [] : personnel;
  if (list.length === 0)
    return (
      <Empty
        title="Nobody listed yet"
        text="Artists, ensembles, staff and others, with their agreement and headphone flags."
        action={<Button variant="primary">Add a person</Button>}
      />
    );
  const kinds: [string, string][] = [
    ["artist", "Artists"],
    ["ensemble", "Ensembles"],
    ["staff", "Staff"],
    ["other", "Others"],
  ];
  return (
    <div className="flex flex-col gap-6">
      {kinds.map(([kind, title]) => {
        const rows = list.filter((p) => p.kind === kind);
        if (rows.length === 0) return null;
        return (
          <section key={kind} className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Label>
                {title} · {rows.length}
              </Label>
              {kind === "artist" && (
                <Button variant="secondary" size="md" className="ml-auto">
                  <Icon name="plus" size={14} />
                  Person
                </Button>
              )}
            </div>
            <ul className="-mx-2 flex flex-col">
              {rows.map((p) => (
                <li key={p.id} className="flex flex-col">
                  <div className="group flex items-center gap-3 rounded-panel px-2 py-2 transition-colors hover:bg-raised/60">
                    {p.personId ? (
                      <Avatar personId={p.personId} size={28} />
                    ) : (
                      <span className="flex size-7 items-center justify-center rounded-full bg-raised text-ink-2">
                        <Icon name="users" size={13} />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-[14px] text-ink">
                        {p.name}
                        {p.guest && <span className="text-[12px] text-ink-3">guest</span>}
                        {p.personId && !p.guest && (
                          <span className="text-[12px] text-ink-3">member</span>
                        )}
                      </span>
                      <span className="block text-[13px] text-ink-3">
                        {p.role}
                        {p.sections
                          ? ` · ${p.sections.reduce((n, s) => n + s.count, 0)} players`
                          : ""}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "flex items-center gap-1.5 text-[12px]",
                        p.agreement ? "text-ink-2" : "text-ink-3",
                      )}
                      title="Session agreement"
                    >
                      <Dot state={p.agreement ? "approved" : "invited"} />
                      agreement
                    </span>
                    <span
                      className={cn(
                        "flex items-center gap-1.5 text-[12px]",
                        p.headphones ? "text-ink-2" : "text-ink-3",
                      )}
                      title="Headphones"
                    >
                      <Dot state={p.headphones ? "approved" : "invited"} />
                      headphones
                    </span>
                    {p.sections && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setOpen(open === p.id ? null : p.id)}
                      >
                        {open === p.id ? "Hide" : "Breakdown"}
                      </Button>
                    )}
                    <ActionMenu
                      label={p.name}
                      actions={[
                        { label: "Edit", onSelect: () => {} },
                        {
                          label: p.personId
                            ? "Unlink from the member"
                            : "Link to a member or guest",
                          onSelect: () => {},
                        },
                        "divider",
                        { label: "Remove", danger: true, onSelect: () => {} },
                      ]}
                    />
                  </div>
                  {p.sections && open === p.id && (
                    <div className="rise-in mx-2 mb-2 rounded-panel border border-line bg-raised/30 p-3">
                      <table className="w-full text-[13px]">
                        <tbody>
                          {p.sections.map((s) => (
                            <tr key={s.name} className="border-b border-line last:border-b-0">
                              <td className="py-1.5 text-ink">{s.name}</td>
                              <td className="tabular py-1.5 text-ink-2">{s.count}</td>
                              <td className="py-1.5 text-ink-3">
                                {s.divisi
                                  ? `divisi ${s.divisi}`
                                  : s.names
                                    ? s.names.join(", ")
                                    : "names to come"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {p.seating && (
                        <p className="mt-2 text-[12px] text-ink-3">Seating: {p.seating}</p>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/* ---------- Schedule ---------- */

const addMinutes = (hhmm: string, m: number) => {
  const [h = 0, mm = 0] = hhmm.split(":").map(Number);
  const t = h * 60 + mm + m;
  return `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

function Schedule() {
  const [days, setDays] = useState(schedule);
  const [view, setView] = useState<"rows" | "coverage">("rows");
  const [timer, setTimer] = useState<string | null>(null);
  const state = useScreenState();
  const toggle = (dayId: string, rowId: string) =>
    setDays((d) =>
      d.map((day) =>
        day.id === dayId
          ? { ...day, rows: day.rows.map((r) => (r.id === rowId ? { ...r, done: !r.done } : r)) }
          : day,
      ),
    );
  const rowIcon: Record<string, IconName> = {
    slot: "track",
    break: "clock",
    "get-in": "upload",
    venue: "pin",
  };
  if (state === "empty")
    return (
      <Empty
        title="Nothing scheduled"
        text="Days with their venue, repertoire slots, breaks and get-ins. Times chain from the row before."
        action={<Button variant="primary">Add a day</Button>}
      />
    );
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="radiogroup"
          className="flex rounded-control border border-line bg-ground/60 p-0.5"
        >
          {(["rows", "coverage"] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={view === v}
              onClick={() => setView(v)}
              className={cn(
                "h-7 rounded-[4px] px-2.5 text-[13px]",
                view === v ? "bg-overlay text-ink shadow-2" : "text-ink-3 hover:text-ink",
              )}
            >
              {v === "rows" ? "Days" : "Coverage"}
            </button>
          ))}
        </div>
        <span className="ml-auto flex gap-1">
          <Dropdown
            value="Export"
            align="right"
            actions={[
              { label: "PDF, with front page and ensemble breakdown", onSelect: () => {} },
              { label: "XLSX", onSelect: () => {} },
            ]}
          />
          <Button variant="secondary" size="md">
            <Icon name="plus" size={14} />
            Day
          </Button>
        </span>
      </div>
      {view === "coverage" ? (
        <ul className="flex flex-col divide-y divide-line rounded-panel-lg border border-line bg-raised/25">
          {tracks
            .filter((t) => t.projectId === "proj-joplin")
            .map((t) => {
              const slots = days.flatMap((d) =>
                d.rows.filter((r) => r.trackId === t.id).map((r) => ({ ...r, day: d.label })),
              );
              const minutes = slots.reduce((n, r) => n + r.minutes, 0);
              return (
                <li key={t.id} className="flex items-center gap-3 px-4 py-2.5 text-[14px]">
                  <span className="min-w-0 flex-1 truncate text-ink">{t.name}</span>
                  <span className="text-[13px] text-ink-3">
                    {slots.map((s) => `${s.day} ${s.start}`).join(", ") || "no slot"}
                  </span>
                  <span
                    className={cn(
                      "tabular w-16 text-right text-[13px]",
                      minutes === 0 ? "text-signal" : "text-ink-2",
                    )}
                  >
                    {minutes} min
                  </span>
                </li>
              );
            })}
        </ul>
      ) : (
        days.map((day) => {
          const venue = venues.find((v) => v.id === day.venueId);
          const live = day.id === "d-1";
          return (
            <section key={day.id} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h3 className="text-[16px] font-medium text-ink">{day.label}</h3>
                <span className="text-[13px] text-ink-3">
                  {formatLongDate(day.date)} · {venue?.name}
                </span>
                {live && (
                  <span className="flex items-center gap-1.5 text-[12px] text-signal">
                    <Dot state="changes_requested" />
                    today, live for everyone
                  </span>
                )}
              </div>
              <ul className="flex flex-col divide-y divide-line rounded-panel-lg border border-line bg-raised/25">
                {day.rows.map((r) => {
                  const track = r.trackId ? trackById(r.trackId) : undefined;
                  return (
                    <li
                      key={r.id}
                      className={cn(
                        "group flex items-center gap-3 px-3 py-2 text-[14px] transition-opacity",
                        r.done && "opacity-50",
                      )}
                    >
                      {live ? (
                        <button
                          type="button"
                          aria-pressed={Boolean(r.done)}
                          aria-label="Done"
                          onClick={() => toggle(day.id, r.id)}
                          className={cn(
                            "flex size-5 items-center justify-center rounded-full border transition-colors",
                            r.done
                              ? "border-ink bg-ink text-ground"
                              : "border-line-strong hover:border-edge-strong",
                          )}
                        >
                          {r.done && <Icon name="check" size={11} />}
                        </button>
                      ) : (
                        <span className="size-5" />
                      )}
                      <span className="tabular w-[92px] shrink-0 text-ink-2">
                        {r.start}–{addMinutes(r.start, r.minutes)}
                      </span>
                      <Icon
                        name={rowIcon[r.kind] ?? "clock"}
                        size={14}
                        className="shrink-0 text-ink-3"
                      />
                      <span className="min-w-0 flex-1 truncate text-ink">
                        {track?.name ?? r.label}
                        {r.notes && <span className="text-ink-3"> · {r.notes}</span>}
                      </span>
                      <span className="hidden text-[13px] text-ink-3 @3xl/app:inline">
                        {r.personnel}
                      </span>
                      <span className="tabular text-[13px] text-ink-3">{r.minutes} min</span>
                      {live && r.kind === "slot" && !r.done && (
                        <Button
                          variant={timer === r.id ? "primary" : "ghost"}
                          size="sm"
                          onClick={() => setTimer(timer === r.id ? null : r.id)}
                        >
                          {timer === r.id ? "Timer running" : "Run timer to slot end"}
                        </Button>
                      )}
                      <ActionMenu
                        label={track?.name ?? r.label ?? "row"}
                        actions={[
                          { label: "Edit", onSelect: () => {} },
                          { label: "Insert a break after", onSelect: () => {} },
                          { label: "Move up", onSelect: () => {} },
                          { label: "Move down", onSelect: () => {} },
                          "divider",
                          { label: "Remove", danger: true, onSelect: () => {} },
                        ]}
                      />
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}

/* ---------- Take log (live) ---------- */

function TakeLog() {
  const [view, setView] = useState<"engineer" | "producer" | "logger">("producer");
  const [list, setList] = useState(takes.filter((t) => t.sessionId === "sess-2").slice(-6));
  const [armed, setArmed] = useState(false);
  const [recording, setRecording] = useState(false);
  const [clock, setClock] = useState(0);
  const [help, setHelp] = useState(false);
  const [tone, setTone] = useState<number | null>(null);
  const [metronome, setMetronome] = useState(false);
  const state = useScreenState();
  const offline = state === "failed";
  const synced = state !== "processing";
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setClock((c) => c + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);
  const nextNumber = (list.at(-1)?.number ?? 0) + 1;
  const start = () => {
    if (recording) {
      setRecording(false);
      setList((l) =>
        l.map((t, i) =>
          i === l.length - 1 ? { ...t, lifecycle: "recorded", duration: clock } : t,
        ),
      );
      return;
    }
    setArmed(false);
    setRecording(true);
    setClock(0);
    setList((l) => [
      ...l,
      {
        ...(l.at(-1) as (typeof l)[number]),
        id: `take-live-${nextNumber}`,
        number: nextNumber,
        rating: 0,
        starred: false,
        falseStarts: 0,
        notes: "",
        lifecycle: "recording",
        duration: 0,
        usedIn: undefined,
        timecodeIn: "11:02:14:00",
        timecodeOut: undefined,
      },
    ]);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (inField(e) || e.metaKey || e.ctrlKey) return;
      if (e.key === " ") {
        e.preventDefault();
        start();
      } else if (e.key === "?") setHelp((h) => !h);
      else if (e.key === "a") setArmed((a) => !a);
      else if (e.key === "f")
        setList((l) =>
          l.map((t, i) => (i === l.length - 1 ? { ...t, falseStarts: t.falseStarts + 1 } : t)),
        );
      else if (e.key === "x" && recording) {
        setRecording(false);
        setList((l) => l.map((t, i) => (i === l.length - 1 ? { ...t, lifecycle: "aborted" } : t)));
      } else if (/^[1-5]$/.test(e.key))
        setList((l) =>
          l.map((t, i) =>
            i === l.length - 1 ? { ...t, rating: Number(e.key) as 1 | 2 | 3 | 4 | 5 } : t,
          ),
        );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const current = list.at(-1);
  const slotEnd = 16 * 60; // 16:00
  const now = 15 * 60 + 12 + Math.floor(clock / 60);
  const left = slotEnd - now;
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="radiogroup"
          className="flex rounded-control border border-line bg-ground/60 p-0.5"
        >
          {(["engineer", "producer", "logger"] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={view === v}
              onClick={() => setView(v)}
              className={cn(
                "h-7 rounded-[4px] px-2.5 text-[13px] capitalize",
                view === v ? "bg-overlay text-ink shadow-2" : "text-ink-3 hover:text-ink",
              )}
            >
              {v}
            </button>
          ))}
        </div>
        <span className="text-[12px] text-ink-3">
          The same take log, a view per person in the room.
        </span>
        <span className="ml-auto flex items-center gap-3 text-[12px] text-ink-3">
          <span className={cn("flex items-center gap-1.5", offline && "text-signal")}>
            <Dot state={offline ? "changes_requested" : "approved"} />
            {offline ? "Offline: written here, synced when back" : "Live for everyone in the room"}
          </span>
          <span className="flex items-center gap-1.5">
            <Dot state={synced ? "approved" : "invited"} />
            {synced ? "Synced to the recorder" : "Recorder not connected"}
          </span>
          <Dropdown
            value="Export"
            align="right"
            actions={[
              { label: "CSV", onSelect: () => {} },
              { label: "Markers for the DAW", onSelect: () => {} },
            ]}
          />
          <button
            type="button"
            onClick={() => setHelp(true)}
            className="flex size-7 items-center justify-center rounded-control text-ink-3 hover:bg-raised hover:text-ink"
          >
            <Kbd>?</Kbd>
          </button>
        </span>
      </div>
      <div
        className={cn(
          "grid gap-4",
          view === "producer"
            ? "@5xl/app:grid-cols-[minmax(0,1fr)_320px]"
            : "@5xl/app:grid-cols-[minmax(0,1fr)_260px]",
        )}
      >
        <div className="flex min-w-0 flex-col gap-4">
          <div
            className={cn(
              "flex flex-wrap items-center gap-4 rounded-panel-lg border p-4 transition-colors",
              recording ? "border-signal/50 bg-signal/[0.06]" : "border-line bg-raised/25",
            )}
          >
            <button
              type="button"
              onClick={start}
              className={cn(
                "flex h-14 items-center gap-3 rounded-full px-6 text-[16px] font-medium shadow-2 transition-colors",
                recording ? "bg-signal text-ground" : "bg-ink text-ground hover:bg-ink/90",
              )}
            >
              <span
                className={cn("size-3 rounded-full", recording ? "breathe bg-ground" : "bg-signal")}
              />
              {recording ? `Stop take ${current?.number}` : `Start take ${nextNumber}`}
              <Kbd>Space</Kbd>
            </button>
            <div className="flex flex-col">
              <span className="tabular text-[28px] leading-8 text-ink">{fmt(clock)}</span>
              <span className="text-[12px] text-ink-3">
                {recording ? "recording" : armed ? "armed" : "idle"} · timecode 11:02:
                {String(14 + clock).padStart(2, "0")}:00
              </span>
            </div>
            <div className="ml-auto flex flex-col items-end">
              <span
                className={cn(
                  "tabular text-[22px] leading-7",
                  left < 10 ? "text-signal" : "text-ink",
                )}
              >
                {fmt((Math.max(0, left * 60) / 60) | 0)}
                <span className="text-[13px] text-ink-3"> to slot end</span>
              </span>
              <span className="text-[12px] text-ink-3">
                Solace · 14:00–16:00 · {view === "logger" ? "wall clock 15:12" : "Day 1"}
              </span>
            </div>
          </div>
          {view === "logger" ? (
            <div className="scroll-quiet overflow-x-auto rounded-panel-lg border border-line bg-raised/25">
              <table className="w-full min-w-[720px] text-[13px]">
                <thead>
                  <tr className="text-left">
                    {[
                      "Take",
                      "Track",
                      "In",
                      "Out",
                      "Wall",
                      "Rating",
                      "False starts",
                      "Notes",
                      "Score",
                    ].map((h) => (
                      <th key={h} className="px-3 py-2 font-normal">
                        <Label>{h}</Label>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {list.map((t) => (
                    <tr
                      key={t.id}
                      className={cn(
                        "border-t border-line",
                        t.lifecycle === "recording" && "bg-signal/[0.06]",
                        t.lifecycle === "aborted" && "opacity-50",
                      )}
                    >
                      <td className="tabular px-3 py-1.5 text-ink">T{t.number}</td>
                      <td className="px-3 py-1.5 text-ink-2">
                        {t.trackId ? trackById(t.trackId)?.name : ""}
                      </td>
                      <td className="tabular px-3 py-1.5 text-ink-3">{t.timecodeIn}</td>
                      <td className="tabular px-3 py-1.5 text-ink-3">
                        {t.timecodeOut ?? (t.lifecycle === "recording" ? "…" : "")}
                      </td>
                      <td className="tabular px-3 py-1.5 text-ink-3">
                        15:{String(12 - (list.length - list.indexOf(t)) * 2).padStart(2, "0")}
                      </td>
                      <td className="px-3 py-1.5 text-ink-2">{"●".repeat(t.rating)}</td>
                      <td className="tabular px-3 py-1.5 text-ink-3">{t.falseStarts || ""}</td>
                      <td className="px-3 py-1.5 text-ink-2">
                        <Input
                          defaultValue={t.notes}
                          className="h-7 text-[13px]"
                          aria-label="Notes"
                        />
                      </td>
                      <td className="tabular px-3 py-1.5 text-ink-3">
                        {t.coverage ? `${t.coverage.barFrom}–${t.coverage.barTo}` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <ul className="flex flex-col divide-y divide-line rounded-panel-lg border border-line bg-raised/25">
              {list.map((t) => (
                <li
                  key={t.id}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 text-[14px]",
                    t.lifecycle === "recording" && "bg-signal/[0.06]",
                    t.lifecycle === "aborted" && "opacity-50",
                  )}
                >
                  <span
                    className={cn(
                      "tabular w-10 font-medium",
                      t.lifecycle === "recording" ? "text-signal" : "text-ink",
                    )}
                  >
                    T{t.number}
                  </span>
                  <span className="flex gap-[3px]">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <span
                        key={n}
                        className={cn(
                          "size-[6px] rounded-full",
                          n <= t.rating ? "bg-ink" : "border border-edge-strong",
                        )}
                      />
                    ))}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-ink-2">
                    {t.notes ||
                      (t.lifecycle === "recording"
                        ? "recording…"
                        : t.lifecycle === "aborted"
                          ? "aborted"
                          : "")}
                  </span>
                  {t.falseStarts > 0 && (
                    <span className="text-[12px] text-ink-3">
                      {t.falseStarts} false {t.falseStarts === 1 ? "start" : "starts"}
                    </span>
                  )}
                  {t.coverage && (
                    <span className="tabular text-[12px] text-ink-3">
                      p. {t.coverage.page} · bars {t.coverage.barFrom}–{t.coverage.barTo}
                    </span>
                  )}
                  <span className="tabular text-[12px] text-ink-3">{t.timecodeIn}</span>
                  {view === "engineer" && (
                    <span className="tabular text-[12px] text-ink-3">
                      {t.files.length - 1} mics
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {view === "engineer" && (
            <div className="rounded-panel-lg border border-line bg-raised/25 p-3">
              <Label>Patch</Label>
              <div className="mt-2 grid grid-cols-3 gap-x-4 gap-y-1 text-[13px] @3xl/app:grid-cols-6">
                {patchList[0]?.inputs.map((i) => (
                  <span key={i.channel} className="flex items-center gap-2">
                    <span className="tabular text-ink-3">{i.channel}</span>
                    <span className="text-ink">{i.source}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
        <aside className="flex min-w-0 flex-col gap-4">
          {view === "producer" && (
            <>
              <div className="rounded-panel-lg border border-line bg-raised/25 p-3">
                <Label>Score, bar 65 onwards</Label>
                <div className="mt-2 overflow-hidden rounded-[4px] shadow-paper">
                  {fileById("file-score-maple") && (
                    <Page
                      file={
                        fileById("file-score-maple") as NonNullable<ReturnType<typeof fileById>>
                      }
                      page={4}
                      width={280}
                    />
                  )}
                </div>
              </div>
              <div className="rounded-panel-lg border border-line bg-raised/25 p-3">
                <Label>To do</Label>
                <ul className="mt-2 flex flex-col gap-1.5 text-[13px]">
                  {[
                    ["Pick-ups for Maple, bars 17–19", false],
                    ["Tell the tuner about the A", true],
                    ["Check the coda balance on the room pair", false],
                  ].map(([text, done]) => (
                    <li key={String(text)} className="flex items-center gap-2">
                      <input type="checkbox" defaultChecked={Boolean(done)} />
                      <span className={cn(done ? "text-ink-3 line-through" : "text-ink")}>
                        {text}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="rounded-panel-lg border border-line bg-raised/25 p-3">
                <Label>Quick reference</Label>
                <p className="mt-1 text-[13px] text-ink-2">
                  Trio from bar 65, repeat taken. Coda at 89. Keep T12's opening.
                </p>
              </div>
            </>
          )}
          <div className="rounded-panel-lg border border-line bg-raised/25 p-3">
            <Label>Tone and metronome</Label>
            <div className="mt-2 flex flex-wrap gap-1">
              {[415, 432, 440, 442].map((hz) => (
                <button
                  key={hz}
                  type="button"
                  aria-pressed={tone === hz}
                  onClick={() => setTone(tone === hz ? null : hz)}
                  className={cn(
                    "tabular h-7 rounded-control border px-2 text-[12px] transition-colors",
                    tone === hz
                      ? "border-signal/60 bg-signal/10 text-ink"
                      : "border-line text-ink-3 hover:text-ink",
                  )}
                >
                  {hz} Hz
                </button>
              ))}
            </div>
            <div className="mt-2 flex items-center justify-between text-[13px] text-ink">
              Metronome, 88
              <Switch label="Metronome" checked={metronome} onChange={setMetronome} />
            </div>
          </div>
          <div className="rounded-panel-lg border border-line bg-raised/25 p-3">
            <Label>Notes</Label>
            <Textarea
              rows={3}
              className="mt-2 text-[13px]"
              defaultValue="Piano a touch bright after lunch; room pair up 1 dB."
            />
          </div>
        </aside>
      </div>
      {help && (
        <Dialog title="Keys" onClose={() => setHelp(false)} width="sm">
          <ul className="flex flex-col gap-1.5 text-[14px]">
            {[
              ["Space", "Start the next take, or stop the one recording"],
              ["A", "Arm"],
              ["X", "Abort the take recording"],
              ["F", "Count a false start"],
              ["1 to 5", "Rate the last take"],
              ["S", "Star the last take"],
              ["N", "Note on the last take"],
              ["?", "This map"],
            ].map(([k, what]) => (
              <li key={String(k)} className="flex items-center gap-3">
                <Kbd>{String(k)}</Kbd>
                <span className="text-ink-2">{what}</span>
              </li>
            ))}
          </ul>
        </Dialog>
      )}
    </div>
  );
}

/* ---------- Score marking ---------- */

const markKinds: { id: ScoreMark["kind"]; label: string; key: string }[] = [
  { id: "issue", label: "Issue", key: "I" },
  { id: "edit", label: "Edit point", key: "E" },
  { id: "take-start", label: "Take start", key: "[" },
  { id: "take-end", label: "Take end", key: "]" },
  { id: "punch", label: "Punch-in", key: "P" },
  { id: "wrong-note", label: "Wrong note", key: "W" },
  { id: "dynamic", label: "Dynamic", key: "D" },
  { id: "note", label: "Sticky note", key: "N" },
  { id: "ink", label: "Ink", key: "K" },
];
const markGlyph: Record<ScoreMark["kind"], string> = {
  issue: "!",
  edit: "T",
  "take-start": "[",
  "take-end": "]",
  punch: "P",
  "wrong-note": "×",
  dynamic: "○",
  note: "≡",
  ink: "~",
};

function ScoreMarking() {
  const score = fileById("file-score-maple");
  const [page, setPage] = useState(1);
  const [layout, setLayout] = useState<"single" | "two" | "continuous">("single");
  const [filter, setFilter] = useState<"none" | "invert" | "sepia" | "amber" | "cyan" | "grey">(
    "none",
  );
  const [tool, setTool] = useState<ScoreMark["kind"]>("issue");
  const [selected, setSelected] = useState<string | null>("sm-2");
  const [marks, setMarks] = useState(scoreMarks);
  const state = useScreenState();
  const shown = state === "empty" ? [] : marks;
  const onPage = shown.filter((m) => m.page === page);
  const current = shown.find((m) => m.id === selected);
  const edits = shown
    .filter((m) => m.kind === "edit" || m.kind === "punch")
    .sort((a, b) => a.bar - b.bar);
  const broken = state === "failed";
  if (!score) return <Refused />;
  const filterCss = {
    none: "",
    invert: "invert(1) hue-rotate(180deg)",
    sepia: "sepia(0.6)",
    amber: "sepia(0.8) saturate(2) hue-rotate(-10deg)",
    cyan: "sepia(0.5) hue-rotate(150deg)",
    grey: "grayscale(1) contrast(0.9)",
  }[filter];
  const pages = score.media.pages ?? 1;
  const pageEls = (
    layout === "two"
      ? [page, Math.min(pages, page + 1)]
      : layout === "continuous"
        ? [1, 2, 3, 4]
        : [page]
  ).map((p) => (
    <div
      key={p}
      className="relative shrink-0 shadow-paper"
      style={{ filter: filterCss, width: layout === "single" ? 520 : 360 }}
    >
      <Page file={score} page={p} width={layout === "single" ? 520 : 360} />
      {shown
        .filter((m) => m.page === p)
        .map((m) => (
          <button
            key={m.id}
            type="button"
            aria-label={`${m.kind} at bar ${m.bar}`}
            onClick={() => setSelected(m.id)}
            className={cn(
              "absolute flex h-6 min-w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full px-1.5 text-[11px] font-medium shadow-2 transition-transform hover:scale-110",
              m.kind === "note"
                ? "bg-[#f3d36b] text-ground"
                : m.kind === "edit" || m.kind === "punch"
                  ? "bg-signal text-ground"
                  : m.fixedBy
                    ? "bg-ink/80 text-ground"
                    : "bg-ground text-ink",
              selected === m.id && "ring-2 ring-signal ring-offset-2 ring-offset-paper",
            )}
            style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%` }}
          >
            {markGlyph[m.kind]}
            {m.kind === "edit" ? m.text.split(" ")[0]?.replace("T", "") : ""}
          </button>
        ))}
      {shown
        .filter((m) => m.page === p && m.barTo)
        .map((m) => (
          <span
            key={`${m.id}-r`}
            className="pointer-events-none absolute h-9 -translate-y-1/2 rounded-[3px] bg-signal/15"
            style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%`, width: "18%" }}
          />
        ))}
    </div>
  ));
  return (
    <div className="flex min-h-0 flex-col gap-3 @3xl/app:flex-row">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {markKinds.map((k) => (
            <button
              key={k.id}
              type="button"
              aria-pressed={tool === k.id}
              onClick={() => setTool(k.id)}
              title={k.label}
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-control border px-2 text-[12px] transition-colors",
                tool === k.id
                  ? "border-signal/60 bg-signal/10 text-ink"
                  : "border-line text-ink-3 hover:text-ink",
              )}
            >
              <span className="tabular w-3 text-center">{markGlyph[k.id]}</span>
              {k.label}
              <Kbd>{k.key}</Kbd>
            </button>
          ))}
          <span className="ml-auto flex items-center gap-1">
            <Dropdown
              value={layout === "single" ? "Single" : layout === "two" ? "Two-up" : "Continuous"}
              align="right"
              actions={[
                {
                  label: "Single",
                  checked: layout === "single",
                  onSelect: () => setLayout("single"),
                },
                { label: "Two-up", checked: layout === "two", onSelect: () => setLayout("two") },
                {
                  label: "Continuous",
                  checked: layout === "continuous",
                  onSelect: () => setLayout("continuous"),
                },
              ]}
            />
            <Dropdown
              value={filter === "none" ? "Paper" : filter}
              align="right"
              actions={(["none", "invert", "sepia", "amber", "cyan", "grey"] as const).map((f) => ({
                label: f === "none" ? "Paper" : f[0]?.toUpperCase() + f.slice(1),
                checked: filter === f,
                onSelect: () => setFilter(f),
              }))}
            />
            <Dropdown
              value="Export"
              align="right"
              actions={[
                { label: "Annotated PDF", onSelect: () => {} },
                { label: "Marks as CSV", onSelect: () => {} },
              ]}
            />
          </span>
        </div>
        <div className="flex items-center gap-2 text-[13px] text-ink-3">
          <button
            type="button"
            onClick={() => setPage(Math.max(1, page - 1))}
            className="flex size-7 items-center justify-center rounded-control hover:bg-raised hover:text-ink"
          >
            <Icon name="chevronLeft" size={14} />
          </button>
          <span className="tabular text-ink">
            p. {page} <span className="text-ink-3">/ {pages}</span>
          </span>
          <button
            type="button"
            onClick={() => setPage(Math.min(pages, page + 1))}
            className="flex size-7 items-center justify-center rounded-control hover:bg-raised hover:text-ink"
          >
            <Icon name="chevronRight" size={14} />
          </button>
          <span className="mx-2">go to</span>
          <Input placeholder="page" className="h-7 w-16 text-[12px]" aria-label="Go to page" />
          <Input
            placeholder="bar"
            className="h-7 w-16 text-[12px]"
            aria-label="Go to bar"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const b = Number((e.target as HTMLInputElement).value);
                setPage(b > 24 ? 2 : 1);
              }
            }}
          />
          <span className="ml-auto flex items-center gap-1">
            step through edit points
            <button
              type="button"
              onClick={() => {
                const i = edits.findIndex((m) => m.id === selected);
                const next = edits[(i + 1) % Math.max(1, edits.length)];
                if (next) {
                  setSelected(next.id);
                  setPage(next.page);
                }
              }}
              className="flex h-7 items-center gap-1 rounded-control border border-line px-2 text-ink-2 hover:text-ink"
            >
              <Icon name="chevronRight" size={12} />
              next
            </button>
          </span>
        </div>
        <div className="scroll-quiet flex max-h-[720px] gap-4 overflow-auto rounded-panel-lg bg-sunken p-4">
          {shown.length === 0 && (
            <p className="m-auto text-[13px] text-ink-3">
              No marks yet. Choose a kind and click on the score.
            </p>
          )}
          {pageEls}
        </div>
      </div>
      <aside className="flex w-full shrink-0 flex-col gap-4 @3xl/app:w-[280px]">
        <section className="rounded-panel-lg border border-line bg-raised/25 p-3">
          <Label>Inspector</Label>
          {current ? (
            <div className="mt-2 flex flex-col gap-2 text-[13px]">
              <span className="text-[14px] font-medium text-ink">
                {markKinds.find((k) => k.id === current.kind)?.label}
                {current.category ? ` · ${current.category}` : ""}
              </span>
              <span className="tabular text-ink-3">
                p. {current.page} · bar {current.bar}
                {current.barTo ? `–${current.barTo}` : ""}
              </span>
              <Input defaultValue={current.text} className="h-8 text-[13px]" aria-label="Text" />
              {current.takeNumbers && (
                <span className="text-ink-2">
                  Takes affected: {current.takeNumbers.map((n) => `T${n}`).join(", ")}
                </span>
              )}
              {current.fixedBy !== undefined && (
                <span className="flex items-center gap-1.5 text-ink-2">
                  <Dot state="approved" />
                  Fixed by T{current.fixedBy}
                </span>
              )}
              {current.kind === "edit" && (
                <span className="text-ink-3">
                  An edit mark reads as in the plot: 3T12 means bar 3 of take 12; a lead-in is T3;
                  chains and overdubs are written the same way.
                </span>
              )}
              <span className="flex gap-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setMarks((m) => m.filter((x) => x.id !== current.id));
                    setSelected(null);
                  }}
                >
                  Delete
                </Button>
              </span>
            </div>
          ) : (
            <p className="mt-2 text-[13px] text-ink-3">Click a mark.</p>
          )}
        </section>
        <section className="rounded-panel-lg border border-line bg-raised/25 p-3">
          <Label>Edit plot check</Label>
          {broken ? (
            <p className="mt-2 flex items-start gap-2 text-[13px] text-signal">
              <Icon name="warning" size={14} className="mt-0.5 shrink-0" />
              The chain breaks at bar 36: the punch into T13 has no take covering bars 33–35.
            </p>
          ) : (
            <p className="mt-2 flex items-center gap-2 text-[13px] text-ink-2">
              <Dot state="approved" />
              Every hand-over has a take on both sides.
            </p>
          )}
          <ul className="mt-2 flex flex-col gap-1 text-[12px] text-ink-3">
            {edits.map((m) => (
              <li key={m.id} className="tabular">
                bar {m.bar}: {m.text}
              </li>
            ))}
          </ul>
        </section>
        <section className="rounded-panel-lg border border-line bg-raised/25 p-3">
          <Label>On this page · {onPage.length}</Label>
          <ul className="mt-2 flex flex-col gap-1 text-[13px]">
            {onPage.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => setSelected(m.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-chip px-1 text-left hover:text-ink",
                    selected === m.id ? "text-ink" : "text-ink-2",
                  )}
                >
                  <span className="tabular w-10 text-ink-3">bar {m.bar}</span>
                  {m.text}
                </button>
              </li>
            ))}
          </ul>
        </section>
      </aside>
    </div>
  );
}

/* ---------- Stage plan and patch list ---------- */

function StagePlan() {
  const [selected, setSelected] = useState<string | null>("s-5");
  const [underlay, setUnderlay] = useState(false);
  const [snap, setSnap] = useState(true);
  const state = useScreenState();
  const scale = 68;
  const items = state === "empty" ? [] : stagePlan.items;
  const sel = items.find((i) => i.id === selected);
  const mic = sel?.micId ? patchList[0]?.inputs.find((i) => i.micId === sel.micId) : undefined;
  return (
    <div className="flex flex-col gap-3 @3xl/app:flex-row">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {(["performer", "ensemble", "mic", "instrument", "riser", "wall", "label"] as const).map(
            (k) => (
              <Button key={k} variant="secondary" size="sm" className="capitalize">
                {k}
              </Button>
            ),
          )}
          <span className="ml-auto flex items-center gap-2 text-[12px] text-ink-3">
            <span className="flex items-center gap-1.5">
              snap
              <Switch label="Snap" checked={snap} onChange={setSnap} />
            </span>
            <span className="flex items-center gap-1.5">
              underlay
              <Switch label="Floor plan underlay" checked={underlay} onChange={setUnderlay} />
            </span>
            <Dropdown
              value="Export PDF"
              align="right"
              actions={[
                { label: "A3, with rulers and scale bar", onSelect: () => {} },
                { label: "A4", onSelect: () => {} },
              ]}
            />
          </span>
        </div>
        <div className="scroll-quiet overflow-auto rounded-panel-lg border border-line bg-sunken p-4">
          <svg
            width={stagePlan.width * scale + 40}
            height={stagePlan.height * scale + 40}
            role="img"
            aria-label="Stage plan"
          >
            <defs>
              <pattern id="grid" width={scale} height={scale} patternUnits="userSpaceOnUse">
                <path d={`M ${scale} 0 L 0 0 0 ${scale}`} fill="none" stroke="var(--hk-line)" />
              </pattern>
            </defs>
            <g transform="translate(30, 10)">
              <rect
                width={stagePlan.width * scale}
                height={stagePlan.height * scale}
                fill={underlay ? "rgb(233 232 227 / 0.06)" : "transparent"}
                stroke="var(--hk-line-strong)"
              />
              <rect
                width={stagePlan.width * scale}
                height={stagePlan.height * scale}
                fill="url(#grid)"
              />
              {underlay && (
                <path
                  d={`M 0 ${6 * scale} Q ${6 * scale} ${7.6 * scale} ${12 * scale} ${6 * scale}`}
                  fill="none"
                  stroke="var(--hk-ink-3)"
                  strokeDasharray="6 4"
                />
              )}
              {Array.from({ length: stagePlan.width + 1 }, (_, i) => (
                <text
                  key={`x${String(i)}`}
                  x={i * scale}
                  y={-2}
                  fill="var(--hk-ink-3)"
                  fontSize={9}
                  textAnchor="middle"
                  fontFamily="var(--hk-font-sans)"
                >
                  {i} m
                </text>
              ))}
              {items.map((it) => {
                const isSel = selected === it.id;
                const common = {
                  onClick: () => setSelected(it.id),
                  className: "cursor-pointer",
                  role: "button" as const,
                  "aria-label": it.label,
                };
                if (it.kind === "mic")
                  return (
                    <g
                      key={it.id}
                      transform={`translate(${it.x * scale}, ${it.y * scale})`}
                      {...common}
                    >
                      <circle
                        r={9}
                        fill={isSel ? "var(--hk-signal)" : "var(--hk-raised)"}
                        stroke={isSel ? "var(--hk-signal)" : "var(--hk-ink-3)"}
                      />
                      <circle r={3} fill={isSel ? "var(--hk-ground)" : "var(--hk-ink-2)"} />
                      <text
                        x={12}
                        y={4}
                        fill="var(--hk-ink-2)"
                        fontSize={10}
                        fontFamily="var(--hk-font-sans)"
                      >
                        {it.label}
                      </text>
                    </g>
                  );
                if (it.kind === "performer")
                  return (
                    <g
                      key={it.id}
                      transform={`translate(${it.x * scale}, ${it.y * scale})`}
                      {...common}
                    >
                      <circle
                        r={(it.w * scale) / 2}
                        fill={
                          isSel
                            ? "color-mix(in oklab, var(--hk-signal) 25%, var(--hk-raised))"
                            : "var(--hk-raised)"
                        }
                        stroke={isSel ? "var(--hk-signal)" : "var(--hk-ink-3)"}
                      />
                      <text
                        y={4}
                        fill="var(--hk-ink)"
                        fontSize={10}
                        textAnchor="middle"
                        fontFamily="var(--hk-font-sans)"
                      >
                        {it.label.slice(0, 2)}
                      </text>
                    </g>
                  );
                return (
                  <g
                    key={it.id}
                    transform={`translate(${it.x * scale}, ${it.y * scale}) rotate(${it.rotation ?? 0})`}
                    {...common}
                  >
                    <rect
                      width={it.w * scale}
                      height={it.h * scale}
                      rx={it.kind === "instrument" ? 10 : 2}
                      fill={
                        it.kind === "wall"
                          ? "var(--hk-ink-3)"
                          : it.kind === "label"
                            ? "transparent"
                            : isSel
                              ? "color-mix(in oklab, var(--hk-signal) 20%, var(--hk-raised))"
                              : "var(--hk-raised)"
                      }
                      stroke={
                        it.kind === "label"
                          ? "none"
                          : isSel
                            ? "var(--hk-signal)"
                            : "var(--hk-line-strong)"
                      }
                      strokeDasharray={it.kind === "riser" ? "4 3" : undefined}
                    />
                    {it.kind !== "wall" && (
                      <text
                        x={(it.w * scale) / 2}
                        y={(it.h * scale) / 2 + 4}
                        fill="var(--hk-ink-2)"
                        fontSize={11}
                        textAnchor="middle"
                        fontFamily="var(--hk-font-sans)"
                      >
                        {it.label}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
          {items.length === 0 && (
            <p className="text-[13px] text-ink-3">
              Nothing on the stage yet. Add performers, microphones, instruments, risers and walls;
              an ensemble block is sized from its head-count.
            </p>
          )}
        </div>
      </div>
      <aside className="flex w-full shrink-0 flex-col gap-3 @3xl/app:w-[260px]">
        <section className="rounded-panel-lg border border-line bg-raised/25 p-3">
          <Label>Selected</Label>
          {sel ? (
            <div className="mt-2 flex flex-col gap-2 text-[13px]">
              <span className="text-[14px] font-medium text-ink capitalize">
                {sel.kind}: {sel.label}
              </span>
              <span className="tabular text-ink-3">
                {sel.x} m, {sel.y} m · {sel.w} × {sel.h} m
                {sel.rotation ? ` · ${sel.rotation}°` : ""}
              </span>
              {mic && (
                <span className="text-ink-2">
                  Patch: ch {mic.channel}, {mic.device}, cable {mic.cable}
                </span>
              )}
              <div className="flex flex-wrap gap-1">
                {["Align", "Rotate", "Resize", "Duplicate", "Undo"].map((a) => (
                  <Button key={a} variant="ghost" size="sm">
                    {a}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            <p className="mt-2 text-[13px] text-ink-3">
              Click something on the plan, or drag a marquee.
            </p>
          )}
        </section>
        <section className="rounded-panel-lg border border-line bg-raised/25 p-3">
          <Label>Label groups</Label>
          <ul className="mt-2 flex flex-col gap-1 text-[13px] text-ink-2">
            {["Main pair", "Piano spots", "Room pair"].map((g) => (
              <li key={g} className="flex items-center gap-2">
                <Icon name="tag" size={12} className="text-ink-3" />
                {g}
              </li>
            ))}
          </ul>
        </section>
      </aside>
    </div>
  );
}

function Patch() {
  const state = useScreenState();
  const boxes = state === "empty" ? [] : patchList;
  if (boxes.length === 0)
    return (
      <Empty
        title="No stage boxes yet"
        text="Inputs and outputs per stage box: source, device, cable or channel, notes, linked to the microphones on the plan."
        action={<Button variant="primary">Add a stage box</Button>}
      />
    );
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <Label>Stage boxes · {boxes.length}</Label>
        <span className="ml-auto flex gap-1">
          <Dropdown
            value="Export"
            align="right"
            actions={[
              { label: "PDF", onSelect: () => {} },
              { label: "XLSX", onSelect: () => {} },
            ]}
          />
          <Button variant="secondary" size="md">
            <Icon name="plus" size={14} />
            Stage box
          </Button>
        </span>
      </div>
      {boxes.map((b) => (
        <section key={b.id} className="flex flex-col gap-3">
          <h3 className="text-[16px] font-medium text-ink">{b.name}</h3>
          {(["inputs", "outputs"] as const).map((dir) => (
            <div key={dir} className="rounded-panel-lg border border-line bg-raised/25">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left">
                    {[
                      dir === "inputs" ? "In" : "Out",
                      "Source",
                      "Device",
                      "Cable",
                      "Notes",
                      "",
                    ].map((h) => (
                      <th key={h} className="px-3 py-2 font-normal">
                        <Label>{h}</Label>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b[dir].map((r) => (
                    <tr key={r.channel} className="group border-t border-line">
                      <td className="tabular px-3 py-1.5 text-ink-3">{r.channel}</td>
                      <td className="px-3 py-1.5 text-ink">
                        {r.source}
                        {r.micId && (
                          <Icon name="mic" size={11} className="ml-1.5 inline text-ink-3" />
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-ink-2">{r.device}</td>
                      <td className="tabular px-3 py-1.5 text-ink-2">{r.cable}</td>
                      <td className="px-3 py-1.5 text-ink-3">{r.notes}</td>
                      <td className="px-1 py-1 text-right">
                        <ActionMenu
                          label={r.source}
                          actions={[
                            { label: "Edit", onSelect: () => {} },
                            { label: "Link to a microphone on the plan", onSelect: () => {} },
                            "divider",
                            { label: "Remove", danger: true, onSelect: () => {} },
                          ]}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

/* ---------- Import ---------- */

function ImportView() {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const state = useScreenState();
  const counts = [
    ["Works", 1],
    ["Tracks", 5],
    ["Venues", 2],
    ["Personnel", 6],
    ["Schedule days", 2],
    ["Takes", 26],
    ["Score marks", 7],
    ["Stage items", 13],
    ["Patch rows", 8],
  ];
  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4">
      <p className="text-[14px] text-ink-2">
        Bring a ControlRoom project (.croom) into this one. Everything it holds becomes the
        project's: works, schedule, personnel, takes, marks, the stage plan and the patch list.
      </p>
      {step === 0 && (
        <button
          type="button"
          onClick={() => setStep(1)}
          className="flex w-full flex-col items-center gap-2 rounded-panel-lg border border-dashed border-line-strong px-6 py-10 text-center transition-colors hover:border-edge-strong hover:bg-raised/40"
        >
          <Icon name="upload" size={20} className="text-ink-3" />
          <span className="text-[14px] text-ink">Drop the .croom file here</span>
          <span className="text-[13px] text-ink-3">Nothing changes until you confirm.</span>
        </button>
      )}
      {step >= 1 && (
        <>
          <ul className="flex flex-col divide-y divide-line rounded-panel-lg border border-line bg-raised/25">
            {counts.map(([k, n]) => (
              <li
                key={String(k)}
                className="flex items-center justify-between px-4 py-2 text-[14px]"
              >
                <span className="text-ink">{k}</span>
                <span className="tabular text-ink-2">{n}</span>
              </li>
            ))}
          </ul>
          {state === "failed" ? (
            <p className="flex items-start gap-2 text-[13px] text-signal">
              <Icon name="warning" size={14} className="mt-0.5 shrink-0" />
              The schedule refers to a venue that is not in the file; 2 takes have no session. They
              will be imported without a venue and as unplaced.
            </p>
          ) : (
            <p className="flex items-start gap-2 text-[13px] text-ink-2">
              <Icon name="warning" size={14} className="mt-0.5 shrink-0 text-ink-3" />
              Conflict: a work named Rags already exists. Merge into it, or import as a second work.
            </p>
          )}
          <div className="flex items-center gap-2">
            <Select defaultValue="merge" className="w-48">
              <option value="merge">Merge into Rags</option>
              <option value="new">Import as a new work</option>
            </Select>
            <Button
              variant="primary"
              className="ml-auto"
              onClick={() => setStep(2)}
              disabled={step === 2}
            >
              {step === 2 ? "Imported" : "Import"}
            </Button>
          </div>
          {step === 2 && (
            <p className="flex items-center gap-2 text-[13px] text-ink-2">
              <Dot state="approved" />
              Done. 26 takes matched to their sessions; the score marks sit on Maple Leaf Rag -
              Score.pdf.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/* ---------- The view ---------- */

export function ProductionView({ project, section }: { project: Project; section?: string }) {
  const viewer = useViewer();
  if (!viewer.tools(project.id).has("production"))
    return (
      <Refused
        title="Not among your tools"
        text="The production tools are given per role in the project's tool access."
      />
    );
  const sec = productionSections.some((s) => s.id === section) ? (section as string) : "repertoire";
  return (
    <div className="flex flex-col gap-5">
      <nav
        aria-label="Production"
        className="scroll-quiet -mx-4 flex gap-1 overflow-x-auto px-4 @3xl/app:mx-0 @3xl/app:px-0"
      >
        {productionSections.map((s) => (
          <Link
            key={s.id}
            to="/projects/$projectId/$view"
            params={{ projectId: project.id, view: "production" }}
            search={{ section: s.id }}
            className={cn(
              "h-8 shrink-0 rounded-control px-2.5 text-[13px] leading-8 whitespace-nowrap transition-colors",
              sec === s.id ? "bg-raised text-ink shadow-1" : "text-ink-3 hover:text-ink",
            )}
          >
            {s.label}
          </Link>
        ))}
      </nav>
      {sec === "repertoire" && <Repertoire />}
      {sec === "schedule" && <Schedule />}
      {sec === "sessions" && <SessionsView project={project} />}
      {sec === "takelog" && <TakeLog />}
      {sec === "marking" && <ScoreMarking />}
      {sec === "stage" && <StagePlan />}
      {sec === "patch" && <Patch />}
      {sec === "personnel" && <PersonnelView />}
      {sec === "venues" && <Venues />}
      {sec === "import" && <ImportView />}
    </div>
  );
}

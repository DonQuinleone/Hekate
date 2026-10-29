import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Avatar, AvatarRow } from "~/components/avatar";
import { CalendarSubscribeDialog } from "~/components/calendar-subscribe";
import { Icon, type IconName } from "~/components/icons";
import { Label } from "~/components/label";
import { Card } from "~/components/page";
import { Dot } from "~/components/status";
import { Button } from "~/components/ui/button";
import { Floating } from "~/components/ui/floating";
import { usePopover } from "~/components/ui/menu";
import { Switch } from "~/components/ui/toggle";
import {
  comments,
  NOW,
  type Project,
  personById,
  primaryFile,
  reviews,
  schedule,
  sessions,
  tasks,
  tracks,
  workflows,
} from "~/data";
import { cn } from "~/lib/cn";
import { dueIn, formatDate } from "~/lib/format";
import { latestDecision } from "~/lib/reviews";
import { trackState } from "~/lib/tracks";

interface Display {
  groupBy: "status" | "stage";
  tasks: boolean;
  comments: boolean;
  decisions: boolean;
  fields: { version: boolean; stage: boolean; reviewers: boolean; due: boolean };
}
const defaultDisplay: Display = {
  groupBy: "status",
  tasks: true,
  comments: true,
  decisions: true,
  fields: { version: true, stage: true, reviewers: true, due: true },
};

/** The board's display options, as Linear keeps them: grouping, what is shown, which fields. */
function Customise({ display, set }: { display: Display; set: (d: Display) => void }) {
  const [open, setOpen, box] = usePopover();
  // What everyone sees until they arrange it for themselves; Reset goes back to it.
  const [projectDefault, setProjectDefault] = useState<Display>(defaultDisplay);
  const isDefault = JSON.stringify(display) === JSON.stringify(projectDefault);
  const row = (label: string, checked: boolean, onChange: (v: boolean) => void) => (
    <label className="flex h-8 items-center justify-between gap-6 text-[13px] text-ink">
      {label}
      <Switch label={label} checked={checked} onChange={onChange} />
    </label>
  );
  return (
    <div ref={box} className="relative">
      <Button variant="ghost" size="md" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="sliders" size={14} />
        Customise
      </Button>
      {open && (
        <Floating
          anchor={box}
          align="end"
          side="bottom"
          onClose={() => setOpen(false)}
          className="rise-in w-72 rounded-panel-lg bg-overlay p-3 shadow-4"
        >
          <div className="flex flex-col gap-1.5">
            <Label>Group by</Label>
            <div className="flex rounded-control border border-line bg-raised/40 p-0.5">
              {(
                [
                  ["status", "Status"],
                  ["stage", "Stage"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={display.groupBy === id}
                  onClick={() => set({ ...display, groupBy: id })}
                  className={cn(
                    "h-7 flex-1 rounded-[4px] text-[13px]",
                    display.groupBy === id
                      ? "bg-raised text-ink shadow-2"
                      : "text-ink-3 hover:text-ink",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-3 flex flex-col">
            <Label className="mb-1">On the cards</Label>
            {row("Tasks", display.tasks, (v) => set({ ...display, tasks: v }))}
            {row("Open comments", display.comments, (v) => set({ ...display, comments: v }))}
            {row("Decisions and feedback", display.decisions, (v) =>
              set({ ...display, decisions: v }),
            )}
          </div>
          <div className="mt-3 flex flex-col gap-1.5">
            <Label>Fields</Label>
            <div className="flex flex-wrap gap-1">
              {(
                [
                  ["version", "Version"],
                  ["stage", "Stage"],
                  ["reviewers", "Reviewers"],
                  ["due", "Due"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={display.fields[id]}
                  onClick={() =>
                    set({ ...display, fields: { ...display.fields, [id]: !display.fields[id] } })
                  }
                  className={cn(
                    "h-7 rounded-chip border px-2.5 text-[13px]",
                    display.fields[id]
                      ? "border-edge bg-raised text-ink"
                      : "border-line text-ink-3 hover:text-ink",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-line pt-3 text-[12px]">
            <button
              type="button"
              onClick={() => set(projectDefault)}
              className="text-ink-3 hover:text-ink"
              title="Back to the project's default"
            >
              Reset
            </button>
            {isDefault ? (
              <span className="text-ink-3">The project's default</span>
            ) : (
              <button
                type="button"
                onClick={() => setProjectDefault(display)}
                className="text-ink-3 hover:text-ink"
                title="What everyone sees until they arrange it for themselves"
              >
                Set as the project's default
              </button>
            )}
          </div>
        </Floating>
      )}
    </div>
  );
}

function TrackCard({
  trackId,
  project,
  display,
}: {
  trackId: string;
  project: Project;
  display: Display;
}) {
  const track = tracks.find((t) => t.id === trackId);
  if (!track) return null;
  const s = trackState(track, project);
  const file = s.version ? primaryFile(s.version) : undefined;
  const fileIds = new Set(s.version?.variations.map((v) => v.fileId) ?? []);
  const open = comments.filter((c) => fileIds.has(c.fileId) && !c.parentId && !c.resolved);
  const linked = tasks.filter(
    (t) => t.projectId === project.id && t.fileId && fileIds.has(t.fileId) && t.status !== "done",
  );
  const decisions = s.review
    ? s.review.reviewers
        .filter((r) => r.state === "submitted")
        .map((r) => ({ personId: r.personId, decision: latestDecision(r) }))
    : [];
  return (
    <Link
      to={file ? "/files/$fileId" : "/tracks/$trackId"}
      params={file ? { fileId: file.id } : { trackId: track.id }}
      search={file ? {} : { view: "versions" }}
      className="flex flex-col gap-2 rounded-panel border border-line bg-raised/40 p-3 shadow-1 transition-colors hover:border-edge"
    >
      <span className="flex items-start gap-2">
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">
          {track.name}
        </span>
        {display.fields.version && s.version && (
          <span className="tabular shrink-0 text-[12px] text-ink-3">V{s.version.number}</span>
        )}
      </span>
      {display.fields.stage && s.stage && (
        <span className="text-[12px] text-ink-2">{s.stage.name}</span>
      )}
      {(display.fields.reviewers || display.fields.due) && s.review && (
        <span className="flex items-center gap-2 text-[12px] text-ink-3">
          {display.fields.reviewers && <AvatarRow personIds={s.waitingOn} size={18} />}
          {display.fields.reviewers && s.waitingOn.length > 0 && <span>waiting</span>}
          {display.fields.due && s.review.dueAt && (
            <span
              className={cn("tabular ml-auto", dueIn(s.review.dueAt).days < 0 && "text-signal")}
            >
              {formatDate(s.review.dueAt)}
            </span>
          )}
        </span>
      )}
      {s.version?.state === "failed" && (
        <span className="flex items-center gap-1 text-[12px] text-signal">
          <Icon name="warning" size={12} /> could not be analysed
        </span>
      )}
      {(display.decisions && decisions.length > 0) ||
      (display.tasks && linked.length > 0) ||
      (display.comments && open.length > 0) ? (
        <span className="mt-0.5 flex flex-col gap-1 border-t border-line pt-2">
          {display.decisions &&
            decisions.map((d) => (
              <span key={d.personId} className="flex items-center gap-1.5 text-[12px] text-ink-2">
                <Dot
                  state={
                    d.decision === "approved"
                      ? "approved"
                      : d.decision === "changes_requested"
                        ? "changes_requested"
                        : "submitted"
                  }
                  className="size-[7px]"
                />
                <span className="truncate">
                  {personById(d.personId).name.split(" ")[0]}{" "}
                  {d.decision === "approved"
                    ? "approved"
                    : d.decision === "changes_requested"
                      ? "requested changes"
                      : "gave feedback"}
                </span>
              </span>
            ))}
          {display.tasks &&
            linked.map((t) => (
              <span key={t.id} className="flex items-center gap-1.5 text-[12px] text-ink-2">
                <Icon name="task" size={12} className="text-ink-3" />
                <span className="truncate">{t.title}</span>
                {t.assigneeId && <Avatar personId={t.assigneeId} size={14} />}
              </span>
            ))}
          {display.comments && open.length > 0 && (
            <span className="flex items-center gap-1.5 text-[12px] text-ink-3">
              <Icon name="comment" size={12} /> {open.length} open
            </span>
          )}
        </span>
      ) : null}
    </Link>
  );
}

export function Board({ project, month }: { project: Project; month?: string }) {
  const workflow = workflows.find((w) => w.id === project.workflowId);
  const [mode, setMode] = useState<"board" | "timeline" | "calendar">("board");
  const [display, setDisplay] = useState<Display>(defaultDisplay);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const projectTracks = tracks.filter((t) => t.projectId === project.id);
  const columns =
    display.groupBy === "stage"
      ? [
          { id: "none", name: "No version", category: "todo" as const },
          ...(workflow?.stages.map((s) => ({
            id: s.id,
            name: s.name,
            category: "in_progress" as const,
          })) ?? []),
          { id: "done", name: "Finished", category: "done" as const },
        ]
      : [
          { id: "none", name: "No version", category: "todo" as const },
          ...(workflow?.statuses.map((s) => ({ id: s.name, name: s.name, category: s.category })) ??
            []),
        ];
  const inColumn = (colId: string) =>
    projectTracks.filter((t) => {
      const s = trackState(t, project);
      if (colId === "none") return !s.version;
      if (!s.version) return false;
      if (display.groupBy === "stage") {
        if (colId === "done") return s.version.status === "Approved" && !s.stage;
        return s.stage?.id === colId;
      }
      return s.version.status === colId;
    });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="radiogroup"
          className="flex rounded-control border border-line bg-raised/40 p-0.5"
        >
          {(
            [
              ["board", "Board", "board"],
              ["timeline", "Timeline", "chart"],
              ["calendar", "Calendar", "calendar"],
            ] as const
          ).map(([m, label, icon]) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-[4px] px-2.5 text-[13px]",
                mode === m ? "bg-overlay text-ink shadow-2" : "text-ink-3 hover:text-ink",
              )}
            >
              <Icon name={icon as IconName} size={13} />
              {label}
            </button>
          ))}
        </div>
        <span className="text-[13px] text-ink-3">{workflow?.name}</span>
        <span className="ml-auto flex items-center gap-1">
          {mode === "board" && <Customise display={display} set={setDisplay} />}
        </span>
      </div>
      {mode === "timeline" && <Timeline project={project} />}
      {mode === "calendar" && <Calendar project={project} month={month} />}
      {mode === "board" && (
        <div className="-mx-5 overflow-x-auto px-5 @3xl/app:-mx-10 @3xl/app:px-10">
          <div className="flex min-w-max items-start gap-3 pb-2">
            {columns
              .filter((c) => !hidden.has(c.id))
              .map((col) => {
                const cards = inColumn(col.id);
                return (
                  <div key={col.id} className="flex w-[272px] shrink-0 flex-col gap-2">
                    <div className="group flex h-8 items-center gap-2 px-1">
                      <Dot
                        state={
                          col.category === "done"
                            ? "approved"
                            : col.category === "todo"
                              ? "invited"
                              : "in_review"
                        }
                      />
                      <span className="truncate text-[14px] font-medium text-ink">{col.name}</span>
                      <span className="tabular text-[13px] text-ink-3">{cards.length}</span>
                      <button
                        type="button"
                        aria-label={`Hide ${col.name}`}
                        onClick={() => setHidden(new Set(hidden).add(col.id))}
                        className="ml-auto flex size-6 items-center justify-center rounded-control text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-raised hover:text-ink"
                      >
                        <Icon name="eyeOff" size={13} />
                      </button>
                    </div>
                    <div className="flex min-h-28 flex-col gap-2 rounded-panel-lg bg-sunken/80 p-2">
                      {cards.map((t) => (
                        <TrackCard key={t.id} trackId={t.id} project={project} display={display} />
                      ))}
                      {cards.length === 0 && (
                        <span className="px-2 py-4 text-center text-[12px] text-ink-3">
                          Nothing here
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            {hidden.size > 0 && (
              <div className="flex w-[200px] shrink-0 flex-col gap-1 rounded-panel-lg border border-dashed border-line p-3">
                <Label>Hidden columns</Label>
                {[...hidden].map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      const next = new Set(hidden);
                      next.delete(id);
                      setHidden(next);
                    }}
                    className="flex h-7 items-center gap-2 rounded-control px-2 text-left text-[13px] text-ink-2 hover:bg-raised hover:text-ink"
                  >
                    <Icon name="eye" size={12} /> {columns.find((c) => c.id === id)?.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** A Gantt-like view from the schedule and the due dates: one row per track, its stages across the weeks. */
function Timeline({ project }: { project: Project }) {
  const projectTracks = tracks.filter((t) => t.projectId === project.id);
  const days = 42;
  const start = new Date("2026-09-28T00:00:00Z");
  const x = (iso: string) =>
    ((new Date(iso).getTime() - start.getTime()) / 86_400_000 / days) * 100;
  const weeks = Array.from(
    { length: days / 7 },
    (_, i) => new Date(start.getTime() + i * 7 * 86_400_000),
  );
  const today = x(NOW.toISOString());
  return (
    <Card className="scroll-quiet overflow-x-auto">
      <div className="relative min-w-[760px]">
        <div className="relative ml-[200px] flex h-9 border-b border-line text-[11px] text-ink-3">
          {weeks.map((w) => (
            <span key={w.toISOString()} className="flex-1 border-l border-line pl-1.5 leading-9">
              {formatDate(w.toISOString())}
            </span>
          ))}
        </div>
        {projectTracks.map((t, i) => {
          const s = trackState(t, project);
          const from = s.version?.uploadedAt ?? t.versions[0]?.uploadedAt;
          const to =
            s.review?.dueAt ??
            (from ? new Date(new Date(from).getTime() + 7 * 86_400_000).toISOString() : null);
          return (
            <div
              key={t.id}
              className="relative flex h-12 items-center border-b border-line last:border-b-0"
            >
              <Link
                to="/tracks/$trackId"
                params={{ trackId: t.id }}
                search={{ view: "versions" }}
                className="w-[200px] shrink-0 truncate px-4 text-[13px] text-ink hover:text-signal"
              >
                {t.name}
              </Link>
              <div className="relative h-full flex-1">
                {weeks.map((w, j) => (
                  <span
                    key={w.toISOString()}
                    className="absolute top-0 bottom-0 border-l border-line"
                    style={{ left: `${(j / weeks.length) * 100}%` }}
                  />
                ))}
                {from && to && (
                  <span
                    className={cn(
                      "absolute top-3 h-6 rounded-[5px] px-2 text-[12px] leading-6 text-ground",
                      s.version?.status === "Approved" ? "bg-ink" : i % 2 ? "bg-ink-2" : "bg-ink-3",
                    )}
                    style={{
                      left: `${Math.max(0, x(from))}%`,
                      width: `${Math.max(4, x(to) - x(from))}%`,
                    }}
                  >
                    <span className="block truncate">{s.stage?.name ?? s.label}</span>
                  </span>
                )}
                {!from && (
                  <span className="absolute top-3.5 left-2 text-[12px] text-ink-3">
                    Nothing scheduled
                  </span>
                )}
              </div>
            </div>
          );
        })}
        <span
          className="pointer-events-none absolute top-0 bottom-0 w-px bg-signal"
          style={{ left: `calc(200px + ${today}% * (100% - 200px) / 100)` }}
        />
      </div>
    </Card>
  );
}

interface Event {
  id: string;
  date: string;
  title: string;
  kind: "review" | "task" | "session" | "day";
  to?: string;
  overdue?: boolean;
}

const eventIcon: Record<Event["kind"], IconName> = {
  review: "review",
  task: "task",
  session: "mic",
  day: "calendar",
};

/** A month of what is due and what is booked, with the feed to take it elsewhere. */
function Calendar({ project, month }: { project: Project; month?: string }) {
  const [cursor, setCursor] = useState(() => {
    const [y, m] = (month ?? "2026-10").split("-").map(Number);
    return new Date(Date.UTC(y ?? 2026, (m ?? 10) - 1, 1));
  });
  const [subscribe, setSubscribe] = useState(false);
  const year = cursor.getUTCFullYear();
  const monthIndex = cursor.getUTCMonth();
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const lead = (first.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const cells = Array.from({ length: 42 }, (_, i) => {
    const day = i - lead + 1;
    const d = new Date(Date.UTC(year, monthIndex, day));
    return { d, inMonth: day >= 1 && day <= daysInMonth, key: d.toISOString().slice(0, 10) };
  });
  const events: Event[] = [
    ...reviews
      .filter((r) => r.projectId === project.id && r.dueAt)
      .map((r) => ({
        id: r.id,
        date: (r.dueAt as string).slice(0, 10),
        title: r.title,
        kind: "review" as const,
        to: `/reviews/${r.id}`,
        overdue: r.status === "open" && dueIn(r.dueAt as string).days < 0,
      })),
    ...tasks
      .filter((t) => t.projectId === project.id && t.dueAt)
      .map((t) => ({
        id: t.id,
        date: t.dueAt as string,
        title: t.title,
        kind: "task" as const,
        to: `/projects/${project.id}/tasks?task=${t.id}`,
        overdue: t.status !== "done" && dueIn(`${t.dueAt}T23:59:00Z`).days < 0,
      })),
    ...sessions
      .filter((s) => s.projectId === project.id)
      .map((s) => ({
        id: s.id,
        date: s.date,
        title: `${s.name} at ${s.venue}`,
        kind: "session" as const,
        to: `/sessions/${s.id}`,
      })),
    ...(project.profile === "music"
      ? schedule.map((d) => ({
          id: d.id,
          date: d.date,
          title: `${d.label} schedule`,
          kind: "day" as const,
          to: `/projects/${project.id}/production?section=schedule`,
        }))
      : []),
  ];
  const byDay = new Map<string, Event[]>();
  for (const e of events) byDay.set(e.date, [...(byDay.get(e.date) ?? []), e]);
  const today = NOW.toISOString().slice(0, 10);
  const label = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(cursor);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => setCursor(new Date(Date.UTC(year, monthIndex - 1, 1)))}
          className="flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-raised hover:text-ink"
        >
          <Icon name="chevronLeft" size={14} />
        </button>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => setCursor(new Date(Date.UTC(year, monthIndex + 1, 1)))}
          className="flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-raised hover:text-ink"
        >
          <Icon name="chevronRight" size={14} />
        </button>
        <span className="text-[15px] font-medium text-ink">{label}</span>
        <button
          type="button"
          onClick={() => setCursor(new Date(Date.UTC(2026, 9, 1)))}
          className="h-7 rounded-control px-2 text-[13px] text-ink-3 hover:bg-raised hover:text-ink"
        >
          Today
        </button>
        <Button
          variant="secondary"
          size="md"
          className="ml-auto"
          onClick={() => setSubscribe(true)}
        >
          <Icon name="calendar" size={14} />
          Add to your calendar
        </Button>
      </div>
      <Card className="overflow-hidden">
        <div className="grid grid-cols-7 border-b border-line">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
            <span key={d} className="eyebrow px-2 py-2 text-[12px]">
              {d}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((c, i) => {
            const list = byDay.get(c.key) ?? [];
            return (
              <div
                key={c.key}
                className={cn(
                  "flex min-h-[104px] flex-col gap-1 border-b border-line p-1.5",
                  i % 7 !== 6 && "border-r",
                  !c.inMonth && "bg-sunken/40",
                )}
              >
                <span
                  className={cn(
                    "tabular flex size-6 items-center justify-center rounded-full text-[12px]",
                    c.key === today
                      ? "bg-signal font-medium text-ground"
                      : c.inMonth
                        ? "text-ink-2"
                        : "text-ink-3/60",
                  )}
                >
                  {c.d.getUTCDate()}
                </span>
                {list.slice(0, 3).map((e) =>
                  e.to ? (
                    <Link
                      key={e.id}
                      to={e.to}
                      className={cn(
                        "flex items-center gap-1 truncate rounded-chip border px-1.5 py-0.5 text-[11px] leading-[15px] transition-colors hover:border-edge",
                        e.overdue
                          ? "border-signal/40 bg-signal/10 text-ink"
                          : e.kind === "review"
                            ? "border-line bg-raised/60 text-ink"
                            : "border-line text-ink-2",
                      )}
                    >
                      <Icon name={eventIcon[e.kind]} size={10} className="shrink-0 text-ink-3" />
                      <span className="truncate">{e.title}</span>
                    </Link>
                  ) : null,
                )}
                {list.length > 3 && (
                  <span className="px-1 text-[11px] text-ink-3">and {list.length - 3} more</span>
                )}
              </div>
            );
          })}
        </div>
      </Card>
      <p className="text-[12px] text-ink-3">
        Review due dates, task deadlines, sessions and schedule days. Open comments with a date
        would appear here too.
      </p>
      {subscribe && (
        <CalendarSubscribeDialog onClose={() => setSubscribe(false)} scope={project.name} />
      )}
    </div>
  );
}

import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Avatar, AvatarRow } from "~/components/avatar";
import { CalendarSubscribeDialog } from "~/components/calendar-subscribe";
import { Icon, type IconName } from "~/components/icons";
import { Label } from "~/components/label";
import { Card } from "~/components/page";
import { Dot } from "~/components/status";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Floating } from "~/components/ui/floating";
import { Input, Select } from "~/components/ui/input";
import { usePopover } from "~/components/ui/menu";
import { Switch } from "~/components/ui/toggle";
import {
  type CalendarEntry,
  calendarEntries,
  comments,
  NOW,
  type Project,
  people,
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
  const fileIds = new Set(s.version?.variants.map((v) => v.fileId) ?? []);
  const open = comments.filter((c) => fileIds.has(c.fileId) && !c.parentId && !c.resolved);
  const linked = tasks.filter(
    (t) => t.projectId === project.id && t.fileId && fileIds.has(t.fileId) && t.status !== "done",
  );
  const decisions = s.review
    ? s.review.reviewers
        .filter((r) => r.state === "submitted")
        .map((r) => ({ personId: r.personId, decision: latestDecision(r) }))
    : [];
  // Its own deadline (#505) over its review's due date.
  const deadline = track.dueAt ?? s.review?.dueAt ?? null;
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
      {((display.fields.reviewers && s.review) || (display.fields.due && deadline)) && (
        <span className="flex items-center gap-2 text-[12px] text-ink-3">
          {display.fields.reviewers && s.review && <AvatarRow personIds={s.waitingOn} size={18} />}
          {display.fields.reviewers && s.waitingOn.length > 0 && <span>waiting</span>}
          {display.fields.due && deadline && (
            <span
              className={cn(
                "tabular ml-auto flex items-center gap-1",
                dueIn(deadline).days < 0 && "text-signal",
              )}
              title={track.dueAt ? "Deadline" : "Review due"}
            >
              {track.dueAt && <Icon name="flag" size={11} />}
              {formatDate(deadline)}
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
  /** An entry being added or changed (#505), from the calendar or the timeline. */
  const [opening, setOpening] = useState<{ day?: string; entry?: CalendarEntry } | null>(null);
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
      {mode === "timeline" && (
        <>
          <Timeline project={project} onOpen={(entry) => setOpening({ entry })} />
          {opening?.entry && (
            <EntryDialog project={project} entry={opening.entry} onClose={() => setOpening(null)} />
          )}
        </>
      )}
      {mode === "calendar" && (
        <Calendar project={project} month={month} opening={opening} onOpen={setOpening} />
      )}
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

const entryIcon: Record<CalendarEntry["kind"], IconName> = {
  session: "mic",
  delivery: "send",
  meeting: "users",
  other: "calendar",
};

/** The handle at a bar's end: dragging it moves the end a day at a time (#505). */
function Handle() {
  return (
    <span
      aria-hidden="true"
      className="absolute inset-y-0 right-0 flex w-2.5 cursor-ew-resize items-center justify-end pr-1 opacity-0 transition-opacity group-hover:opacity-100"
    >
      <span className="h-3 w-0.5 rounded-full bg-current opacity-60" />
    </span>
  );
}

/**
 * A Gantt-like view from the schedule and the due dates: one row per track, from its latest
 * version to its deadline (its own, else its review's), its stage across the weeks; under them
 * the calendar's entries (#505). A bar's end is dragged to set the deadline; an entry is dragged
 * to move it, its end to change its length; each change is saved and offered back with Undo.
 */
function Timeline({ project, onOpen }: { project: Project; onOpen: (e: CalendarEntry) => void }) {
  const projectTracks = tracks.filter((t) => t.projectId === project.id);
  const entries = calendarEntries.filter((e) => e.projectId === project.id);
  const [undo, setUndo] = useState<string | null>("Maple Leaf Rag due 12 Oct");
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
    <div className="flex flex-col gap-3">
      {undo && (
        <div
          role="status"
          className="flex items-center gap-1 self-end rounded-control border border-line bg-overlay py-0.5 pr-0.5 pl-3 text-[13px] text-ink-2 shadow-2"
        >
          <span>{undo}</span>
          <Button variant="ghost" size="sm" onClick={() => setUndo(null)}>
            Undo
          </Button>
          <Button variant="quiet" size="iconSm" aria-label="Dismiss" onClick={() => setUndo(null)}>
            <Icon name="close" size={13} />
          </Button>
        </div>
      )}
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
            // Its own deadline, else its review's, else a week on.
            const to =
              t.dueAt ??
              s.review?.dueAt ??
              (from ? new Date(new Date(from).getTime() + 7 * 86_400_000).toISOString() : null);
            const late = t.dueAt ? dueIn(t.dueAt).days < 0 : false;
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
                      title={
                        t.dueAt ? `Due ${formatDate(t.dueAt)}${late ? ", late" : ""}` : undefined
                      }
                      className={cn(
                        "group absolute top-3 h-6 rounded-[5px] px-2 text-[12px] leading-6",
                        s.version?.status === "Approved"
                          ? "bg-ink text-ground"
                          : late
                            ? "border border-signal/50 bg-signal/15 text-ink"
                            : i % 2
                              ? "bg-ink-2 text-ground"
                              : "bg-ink-3 text-ground",
                      )}
                      style={{
                        left: `${Math.max(0, x(from))}%`,
                        width: `${Math.max(4, x(to) - x(from))}%`,
                      }}
                    >
                      <span className="block truncate">
                        {s.stage?.name ?? s.label}
                        {t.dueAt && (
                          <Icon
                            name="flag"
                            size={10}
                            className="ml-1.5 inline-block align-[-1px] opacity-80"
                          />
                        )}
                      </span>
                      <Handle />
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
          {entries.length > 0 && (
            <div className="flex h-8 items-center border-b border-line bg-sunken/40">
              <Label className="w-[200px] shrink-0 px-4">Entries</Label>
            </div>
          )}
          {entries.map((e) => {
            const from = `${e.startsOn}T00:00:00Z`;
            const to = `${e.endsOn ?? e.startsOn}T00:00:00Z`;
            const when = e.endsOn ? `${formatDate(from)} – ${formatDate(to)}` : formatDate(from);
            return (
              <div
                key={e.id}
                className="relative flex h-12 items-center border-b border-line last:border-b-0"
              >
                <button
                  type="button"
                  onClick={() => onOpen(e)}
                  className="flex w-[200px] shrink-0 items-center gap-1.5 px-4 text-left text-[13px] text-ink hover:text-signal"
                >
                  <Icon name={entryIcon[e.kind]} size={12} className="shrink-0 text-ink-3" />
                  <span className="truncate">{e.title}</span>
                </button>
                <div className="relative h-full flex-1">
                  {weeks.map((w, j) => (
                    <span
                      key={w.toISOString()}
                      className="absolute top-0 bottom-0 border-l border-line"
                      style={{ left: `${(j / weeks.length) * 100}%` }}
                    />
                  ))}
                  <button
                    type="button"
                    title={`${e.title}: ${when}`}
                    onClick={() => onOpen(e)}
                    className="group absolute top-3 h-6 min-w-6 cursor-grab rounded-[5px] border border-line-strong bg-raised px-2 text-left text-[12px] leading-6 text-ink hover:border-edge"
                    style={{
                      left: `${x(from)}%`,
                      width: `${x(to) - x(from) + 100 / days}%`,
                    }}
                  >
                    <span className="block truncate">{when}</span>
                    <Handle />
                  </button>
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
      <p className="text-[12px] text-ink-3">
        From each track's latest version to its deadline, or to when its review is due, or a week on
        where neither is set; drag a bar's end to set the deadline; drag an entry to move it, or its
        end to change its length.
      </p>
    </div>
  );
}

/**
 * A calendar entry (#505): new from the calendar's button or a double-click on a day, or an
 * existing one to change or remove. A session entry books a recording session under
 * Production.
 */
function EntryDialog({
  project,
  entry,
  day,
  onClose,
}: {
  project: Project;
  entry?: CalendarEntry;
  day?: string;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<CalendarEntry["kind"]>(entry?.kind ?? "meeting");
  const [attendees, setAttendees] = useState<string[]>(entry?.attendeeIds ?? []);
  const projectTracks = tracks.filter((t) => t.projectId === project.id);
  const projectReviews = reviews.filter((r) => r.projectId === project.id);
  const kinds = [
    ["session", "Session"],
    ["delivery", "Delivery"],
    ["meeting", "Meeting"],
    ["other", "Other"],
  ] as const;
  return (
    <Dialog
      title={entry ? "Entry" : "New entry"}
      description={
        entry
          ? undefined
          : "A session, a delivery, a listening meeting: anything with a day that is not a review, a task or a deadline."
      }
      onClose={onClose}
      footer={
        <>
          {entry && (
            <Button
              variant="ghost"
              className="mr-auto text-signal hover:text-signal"
              onClick={onClose}
            >
              Remove
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onClose}>
            {entry ? "Save" : "Add entry"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          Title
          <Input defaultValue={entry?.title ?? ""} placeholder="Listening meeting with the label" />
        </label>
        <div className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          Kind
          <div
            role="radiogroup"
            className="flex h-8 self-start rounded-control border border-line bg-raised/40 p-0.5"
          >
            {kinds.map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                onClick={() => setKind(k)}
                className={cn(
                  "flex h-7 items-center rounded-[5px] px-2.5 text-[13px]",
                  kind === k ? "bg-overlay text-ink shadow-2" : "text-ink-3 hover:text-ink",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {kind === "session" && (
            <span className="text-[12px] text-ink-3">
              Books a recording session under Production, on the day it starts.
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
            Starts
            <Input type="date" defaultValue={entry?.startsOn ?? day ?? "2026-10-14"} />
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
            Ends
            <Input type="date" defaultValue={entry?.endsOn ?? ""} />
            <span className="text-[12px] text-ink-3">Leave empty for one day</span>
          </label>
        </div>
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          About
          <Select
            defaultValue={
              entry?.trackId
                ? `track:${entry.trackId}`
                : entry?.reviewId
                  ? `review:${entry.reviewId}`
                  : ""
            }
          >
            <option value="">Nothing in particular</option>
            <optgroup label="Tracks">
              {projectTracks.map((t) => (
                <option key={t.id} value={`track:${t.id}`}>
                  {t.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Reviews">
              {projectReviews.map((r) => (
                <option key={r.id} value={`review:${r.id}`}>
                  {r.title}
                </option>
              ))}
            </optgroup>
          </Select>
          <span className="text-[12px] text-ink-3">A track or a review it concerns, if any</span>
        </label>
        <div className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          Attendees
          <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-control border border-line-strong bg-ground/70 px-2 py-1.5">
            {attendees.map((id) => (
              <span
                key={id}
                className="flex h-6 items-center gap-1.5 rounded-chip border border-line bg-raised pr-1 pl-1.5 text-[12px] text-ink"
              >
                <Avatar personId={id} size={14} />
                {personById(id).name}
                <button
                  type="button"
                  aria-label={`Remove ${personById(id).name}`}
                  onClick={() => setAttendees(attendees.filter((a) => a !== id))}
                  className="flex size-4 items-center justify-center rounded-full text-ink-3 hover:text-ink"
                >
                  <Icon name="close" size={10} />
                </button>
              </span>
            ))}
            <Select
              className="h-6 w-auto border-0 bg-transparent px-1 text-[13px] text-ink-3 shadow-none"
              value=""
              onChange={(e) => e.target.value && setAttendees([...attendees, e.target.value])}
            >
              <option value="">Members expected</option>
              {people
                .filter((p) => !attendees.includes(p.id))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </Select>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

interface Event {
  id: string;
  date: string;
  title: string;
  kind: "review" | "task" | "track" | "session" | "day" | "entry";
  to?: string;
  overdue?: boolean;
  /** The entry it is, which opens to be changed (#505). */
  entry?: CalendarEntry;
}

const eventIcon: Record<Event["kind"], IconName> = {
  review: "review",
  task: "task",
  track: "flag",
  session: "mic",
  day: "calendar",
  entry: "calendar",
};

/** Every day of a range, both ends included. */
function daysOf(start: string, end: string | null): string[] {
  const out = [start];
  if (!end) return out;
  for (let d = new Date(`${start}T00:00:00Z`); ; ) {
    d = new Date(d.getTime() + 86_400_000);
    const day = d.toISOString().slice(0, 10);
    if (day > end) break;
    out.push(day);
  }
  return out;
}

/**
 * A month of what is due and what is booked, with the feed to take it elsewhere. Whoever edits
 * the schedule adds an entry (#505) from the button or by double-clicking a day, and opens one
 * to change it.
 */
function Calendar({
  project,
  month,
  opening,
  onOpen,
}: {
  project: Project;
  month?: string;
  opening: { day?: string; entry?: CalendarEntry } | null;
  onOpen: (next: { day?: string; entry?: CalendarEntry } | null) => void;
}) {
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
    ...tracks
      .filter((t) => t.projectId === project.id && t.dueAt)
      .map((t) => ({
        id: `track-${t.id}`,
        date: (t.dueAt as string).slice(0, 10),
        title: `${t.name} due`,
        kind: "track" as const,
        to: `/tracks/${t.id}`,
        overdue: dueIn(t.dueAt as string).days < 0,
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
    ...calendarEntries
      .filter((e) => e.projectId === project.id)
      .flatMap((e) =>
        daysOf(e.startsOn, e.endsOn).map((date) => ({
          id: `${e.id}-${date}`,
          date,
          title: e.title,
          kind: "entry" as const,
          entry: e,
        })),
      ),
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
        <span className="ml-auto flex items-center gap-2">
          <Button variant="secondary" size="md" onClick={() => setSubscribe(true)}>
            <Icon name="calendar" size={14} />
            Add to your calendar
          </Button>
          <Button variant="primary" size="md" onClick={() => onOpen({ day: today })}>
            <Icon name="plus" size={14} />
            New entry
          </Button>
        </span>
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
              // A double-click on a day is a shortcut to New entry above.
              <div
                key={c.key}
                onDoubleClick={(e) => {
                  if (!(e.target as HTMLElement).closest("a, button")) onOpen({ day: c.key });
                }}
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
                {list.slice(0, 3).map((e) => {
                  const className = cn(
                    "flex items-center gap-1 truncate rounded-chip border px-1.5 py-0.5 text-left text-[11px] leading-[15px] transition-colors hover:border-edge",
                    e.overdue
                      ? "border-signal/40 bg-signal/10 text-ink"
                      : e.kind === "review" || e.kind === "track"
                        ? "border-line bg-raised/60 text-ink"
                        : e.kind === "entry"
                          ? "border-line-strong bg-raised/30 text-ink"
                          : "border-line text-ink-2",
                  );
                  const inner = (
                    <>
                      <Icon
                        name={e.entry ? entryIcon[e.entry.kind] : eventIcon[e.kind]}
                        size={10}
                        className="shrink-0 text-ink-3"
                      />
                      <span className="truncate">{e.title}</span>
                    </>
                  );
                  return e.entry ? (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => onOpen({ entry: e.entry })}
                      className={className}
                    >
                      {inner}
                    </button>
                  ) : e.to ? (
                    <Link key={e.id} to={e.to} className={className}>
                      {inner}
                    </Link>
                  ) : null;
                })}
                {list.length > 3 && (
                  <span className="px-1 text-[11px] text-ink-3">and {list.length - 3} more</span>
                )}
              </div>
            );
          })}
        </div>
      </Card>
      <p className="text-[12px] text-ink-3">
        Review, track and task deadlines, recording sessions, schedule days and the project's
        entries; double-click a day to add one.
      </p>
      {subscribe && (
        <CalendarSubscribeDialog onClose={() => setSubscribe(false)} scope={project.name} />
      )}
      {opening && (
        <EntryDialog
          project={project}
          entry={opening.entry}
          day={opening.day}
          onClose={() => onOpen(null)}
        />
      )}
    </div>
  );
}

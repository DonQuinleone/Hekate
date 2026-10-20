import {
  coverage,
  rowWords,
  type ScheduleDay,
  type ScheduleRow,
  type ScheduleRowKind,
  scheduleKindWords,
  scheduleRowKinds,
  secondsLeft,
  timesOf,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { Empty } from "~/components/empty";
import { Icon, type IconName } from "~/components/icons";
import { ProductionNav } from "~/components/production-nav";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/choice";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input, Textarea } from "~/components/ui/input";
import { ActionMenu, Dropdown } from "~/components/ui/menu";
import { Segmented } from "~/components/ui/segmented";
import { cn } from "~/lib/cn";
import { formatDates } from "~/lib/locale";
import { scheduleQuery, useProjectCan, useSchedule } from "~/lib/queries";
import { ProjectFrame } from "./project";

type Data = NonNullable<ReturnType<typeof useScheduleData>["data"]>;

const dayFormat = formatDates({
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const kindWords = scheduleKindWords;

const kindIcon: Record<ScheduleRowKind, IconName> = {
  slot: "track",
  break: "clock",
  "get-in": "upload",
  venue: "pin",
  custom: "list",
};

/** Today's calendar date where the browser is: "2026-09-12". */
const today = () => new Date().toLocaleDateString("en-CA");

const useScheduleData = (projectId: string, enabled: boolean) =>
  useQuery({
    ...scheduleQuery(projectId),
    enabled,
    // On the day, ticks from the control room reach everyone within moments.
    refetchInterval: (q) => (q.state.data?.days.some((d) => d.date === today()) ? 5000 : false),
  });

/**
 * The schedule (#50), in Production as the prototype has it: the days at their venues, each
 * with its rows chained in time and ticked off as the day goes, and the coverage of every track.
 */
export function SchedulePage({ projectId }: { projectId: string }) {
  const can = useProjectCan(projectId);
  const { data, error } = useScheduleData(projectId, can("view_production"));
  return (
    <ProjectFrame projectId={projectId} title="Schedule">
      {(project) => (
        <div className="fade-in mx-auto flex w-full max-w-[1100px] flex-col gap-5 px-5 py-6 @3xl/app:px-10">
          <ProductionNav projectId={projectId} current="schedule" can={can} />
          {!can("view_production") ? (
            <Empty
              title="Not among what your role shows"
              text="The schedule is shown to the roles the project's access gives the production tools."
            />
          ) : error ? (
            <p className="m-0 text-signal">{error.message}</p>
          ) : !data ? (
            <p className="m-0 text-ink-3">Loading</p>
          ) : (
            <Schedule
              projectId={projectId}
              data={data}
              canEdit={can("edit_production") && !project.archivedAt}
            />
          )}
        </div>
      )}
    </ProjectFrame>
  );
}

type Editing =
  | { what: "day"; day?: ScheduleDay }
  | { what: "row"; dayId: string; row?: ScheduleRow; after?: string; kind?: ScheduleRowKind };

function Schedule({
  projectId,
  data,
  canEdit,
}: {
  projectId: string;
  data: Data;
  canEdit: boolean;
}) {
  const [view, setView] = useState<"days" | "coverage">("days");
  const [editing, setEditing] = useState<Editing | null>(null);
  return (
    <>
      {data.days.length === 0 ? (
        <Empty
          title="Nothing scheduled"
          text="Days with their venue, repertoire slots, breaks and get-ins. Times chain from the row before."
          action={
            canEdit ? (
              <Button variant="primary" onClick={() => setEditing({ what: "day" })}>
                Add a day
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              label="View"
              value={view}
              options={[
                { value: "days", label: "Days" },
                { value: "coverage", label: "Coverage" },
              ]}
              onChange={setView}
            />
            <span className="ml-auto flex items-center gap-1">
              {/* To send out, and as a workbook: made on the server, for this person. */}
              <Dropdown
                value="Export"
                align="right"
                actions={[
                  {
                    label: "PDF, with front page and ensemble breakdown",
                    onSelect: () =>
                      window.location.assign(`/api/projects/${projectId}/schedule/pdf`),
                  },
                  {
                    label: "XLSX",
                    onSelect: () =>
                      window.location.assign(`/api/projects/${projectId}/schedule/xlsx`),
                  },
                ]}
              />
              {canEdit && (
                <Button variant="secondary" size="md" onClick={() => setEditing({ what: "day" })}>
                  <Icon name="plus" size={14} />
                  Day
                </Button>
              )}
            </span>
          </div>
          {view === "coverage" ? (
            <Coverage data={data} />
          ) : (
            data.days.map((day) => (
              <Day
                key={day.id}
                projectId={projectId}
                day={day}
                data={data}
                canEdit={canEdit}
                onEdit={setEditing}
              />
            ))
          )}
        </div>
      )}
      {editing?.what === "day" && (
        <DayDialog
          projectId={projectId}
          day={editing.day}
          venues={data.venues}
          count={data.days.length}
          onClose={() => setEditing(null)}
        />
      )}
      {editing?.what === "row" && (
        <RowDialog
          projectId={projectId}
          editing={editing}
          data={data}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function Day({
  projectId,
  day,
  data,
  canEdit,
  onEdit,
}: {
  projectId: string;
  day: ScheduleDay;
  data: Data;
  canEdit: boolean;
  onEdit: (editing: Editing) => void;
}) {
  const { removeDay, tick, moveRow, removeRow } = useSchedule(projectId);
  const times = timesOf(day);
  const live = day.date === today();
  const venue = data.venues.find((v) => v.id === day.venueId);
  const [timer, setTimer] = useState<string | null>(null);
  const when = [day.date ? dayFormat.format(new Date(day.date)) : null, venue?.name]
    .filter(Boolean)
    .join(" · ");
  return (
    <section aria-label={day.label} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="m-0 text-[16px] font-medium text-ink">{day.label}</h2>
        {when && <span className="text-[13px] text-ink-3">{when}</span>}
        {live && (
          <span className="flex items-center gap-1.5 text-[12px] text-signal">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-signal" />
            Today, live for everyone
          </span>
        )}
        {canEdit && (
          <span className="ml-auto flex items-center gap-1 self-center">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onEdit({ what: "row", dayId: day.id })}
            >
              <Icon name="plus" size={13} />
              Row
            </Button>
            <ActionMenu
              always
              label={day.label}
              actions={[
                { label: "Edit", onSelect: () => onEdit({ what: "day", day }) },
                "divider",
                { label: "Delete", danger: true, onSelect: () => removeDay.mutate(day.id) },
              ]}
            />
          </span>
        )}
      </div>
      {day.rows.length === 0 ? (
        <p className="m-0 rounded-panel-lg border border-line px-4 py-3 text-[13px] text-ink-3">
          No rows yet.{" "}
          {canEdit ? "Add a slot, a break or a get-in; each starts as the last ends." : ""}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-line rounded-panel-lg border border-line bg-raised/25 p-0">
          {day.rows.map((r, i) => {
            const words = rowWords(r, data.works, data.tracks);
            const at = times[i];
            return (
              <li
                key={r.id}
                className={cn(
                  "group flex items-center gap-3 px-3 py-2 text-[14px] transition-opacity duration-300",
                  r.done && "opacity-50",
                )}
              >
                {canEdit ? (
                  <button
                    type="button"
                    aria-pressed={r.done}
                    aria-label={`${words} done`}
                    onClick={() => tick.mutate({ id: r.id, done: !r.done })}
                    className={cn(
                      "flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
                      r.done
                        ? "border-ink bg-ink text-ground"
                        : "border-line-strong hover:border-edge-strong",
                    )}
                  >
                    {r.done && <Icon name="check" size={11} />}
                  </button>
                ) : (
                  r.done && <Icon name="check" size={14} className="shrink-0 text-ink-3" />
                )}
                <span
                  className="tabular w-[92px] shrink-0 text-ink-2"
                  title={at?.fixed ? "Starts at a set time" : undefined}
                >
                  {at?.start}–{at?.end}
                </span>
                <Icon
                  name={kindIcon[r.kind]}
                  size={14}
                  className="hidden shrink-0 text-ink-3 @xl/app:block"
                />
                <span className="min-w-0 flex-1 truncate text-ink">
                  {words}
                  {r.notes && <span className="text-ink-3"> · {r.notes}</span>}
                </span>
                {r.personnel && (
                  <span className="hidden max-w-[200px] truncate text-[13px] text-ink-3 @3xl/app:inline">
                    {r.personnel}
                  </span>
                )}
                <span className="tabular shrink-0 text-[13px] text-ink-3">{r.minutes} min</span>
                {live && r.kind === "slot" && !r.done && at && (
                  <SlotTimer
                    date={day.date ?? today()}
                    ends={at.ends}
                    running={timer === r.id}
                    onToggle={() => setTimer(timer === r.id ? null : r.id)}
                  />
                )}
                {canEdit && (
                  <ActionMenu
                    label={words}
                    actions={[
                      {
                        label: "Edit",
                        onSelect: () => onEdit({ what: "row", dayId: day.id, row: r }),
                      },
                      {
                        label: "Insert a break after",
                        onSelect: () =>
                          onEdit({ what: "row", dayId: day.id, after: r.id, kind: "break" }),
                      },
                      ...(i > 0
                        ? [
                            {
                              label: "Move up",
                              onSelect: () => moveRow.mutate({ id: r.id, direction: "up" }),
                            },
                          ]
                        : []),
                      ...(i < day.rows.length - 1
                        ? [
                            {
                              label: "Move down",
                              onSelect: () => moveRow.mutate({ id: r.id, direction: "down" }),
                            },
                          ]
                        : []),
                      "divider",
                      { label: "Remove", danger: true, onSelect: () => removeRow.mutate(r.id) },
                    ]}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** A countdown to the slot's end, today: the producer's eye on the clock. */
function SlotTimer({
  date,
  ends,
  running,
  onToggle,
}: {
  date: string;
  ends: number;
  running: boolean;
  onToggle: () => void;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, [running]);
  // To the slot's end on its day, so one running past midnight counts down through it.
  const left = secondsLeft(date, ends, now);
  const shown = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  return (
    <Button variant={running ? "primary" : "ghost"} size="sm" onClick={onToggle}>
      {running ? `${shown} left` : "Run timer to slot end"}
    </Button>
  );
}

/** Every track with its slots across the days, so a track with none stands out. */
function Coverage({ data }: { data: Data }) {
  const slots = coverage(
    data.days,
    data.works,
    data.tracks.map((t) => t.id),
  );
  if (data.tracks.length === 0)
    return (
      <p className="m-0 text-[13px] text-ink-3">
        No tracks yet: coverage lists each with its slots.
      </p>
    );
  return (
    <ul className="m-0 flex list-none flex-col divide-y divide-line rounded-panel-lg border border-line bg-raised/25 p-0">
      {data.tracks.map((t) => {
        const held = slots.get(t.id) ?? [];
        const minutes = held.reduce((n, s) => n + s.minutes, 0);
        return (
          <li key={t.id} className="flex items-center gap-3 px-4 py-2.5 text-[14px]">
            <span className="min-w-0 flex-1 truncate text-ink">{t.name}</span>
            <span className="min-w-0 truncate text-[13px] text-ink-3">
              {held.map((s) => `${s.day} ${s.start}`).join(", ") || "No slot"}
            </span>
            <span
              className={cn(
                "tabular w-16 shrink-0 text-right text-[13px]",
                minutes === 0 ? "text-signal" : "text-ink-2",
              )}
            >
              {minutes} min
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function DayDialog({
  projectId,
  day,
  venues,
  count,
  onClose,
}: {
  projectId: string;
  day?: ScheduleDay;
  venues: Data["venues"];
  count: number;
  onClose: () => void;
}) {
  const { addDay, changeDay } = useSchedule(projectId);
  const [label, setLabel] = useState(day?.label ?? `Day ${count + 1}`);
  const [date, setDate] = useState(day?.date ?? "");
  const [venueId, setVenueId] = useState(day?.venueId ?? null);
  const [start, setStart] = useState(day?.start ?? "10:00");
  const saving = day ? changeDay : addDay;
  const valid = label.trim() !== "" && /^\d{2}:\d{2}$/.test(start);
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const input = { label, date: date || null, venueId, start };
    if (day) changeDay.mutate({ id: day.id, ...input }, { onSuccess: onClose });
    else addDay.mutate(input, { onSuccess: onClose });
  };
  return (
    <Dialog
      title={day ? `Edit ${day.label}` : "Add a day"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="schedule-day"
            disabled={!valid || saving.isPending}
          >
            {day ? "Save" : "Add"}
          </Button>
        </>
      }
    >
      <form
        id="schedule-day"
        onSubmit={save}
        className="grid grid-cols-1 gap-3 @xl/app:grid-cols-2"
      >
        <Field label="Label" error={saving.error?.message}>
          <Input
            autoFocus
            value={label}
            maxLength={60}
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
        <Field label="Date">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Venue" hint={venues.length === 0 ? "Add venues under Venues" : undefined}>
          <Dropdown
            variant="field"
            value={venues.find((v) => v.id === venueId)?.name ?? "No venue"}
            actions={[
              { label: "No venue", checked: venueId === null, onSelect: () => setVenueId(null) },
              ...(venues.length > 0 ? ["divider" as const] : []),
              ...venues.map((v) => ({
                label: v.name,
                checked: v.id === venueId,
                onSelect: () => setVenueId(v.id),
              })),
            ]}
          />
        </Field>
        <Field label="Starts" hint="When the first row starts, unless it sets its own">
          <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
      </form>
    </Dialog>
  );
}

function RowDialog({
  projectId,
  editing,
  data,
  onClose,
}: {
  projectId: string;
  editing: Extract<Editing, { what: "row" }>;
  data: Data;
  onClose: () => void;
}) {
  const { addRow, changeRow } = useSchedule(projectId);
  const row = editing.row;
  const [kind, setKind] = useState<ScheduleRowKind>(row?.kind ?? editing.kind ?? "slot");
  const [start, setStart] = useState(row?.start ?? "");
  const [minutes, setMinutes] = useState(String(row?.minutes ?? (kind === "break" ? 20 : 60)));
  const [label, setLabel] = useState(row?.label ?? "");
  const [allRepertoire, setAllRepertoire] = useState(row?.allRepertoire ?? false);
  const [workIds, setWorkIds] = useState(new Set(row?.workIds ?? []));
  const [trackIds, setTrackIds] = useState(new Set(row?.trackIds ?? []));
  const [personnel, setPersonnel] = useState(row?.personnel ?? "");
  const [notes, setNotes] = useState(row?.notes ?? "");
  const saving = row ? changeRow : addRow;
  const length = /^\d{1,4}$/.test(minutes.trim()) ? Number(minutes) : Number.NaN;
  const valid = !Number.isNaN(length) && length <= 24 * 60;
  const flip = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    return next;
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const slot = kind === "slot";
    const input = {
      kind,
      start: start || null,
      minutes: length,
      label,
      allRepertoire: slot && allRepertoire,
      workIds: slot && !allRepertoire ? [...workIds] : [],
      trackIds: slot && !allRepertoire ? [...trackIds] : [],
      personnel,
      notes,
    };
    if (row) changeRow.mutate({ id: row.id, ...input }, { onSuccess: onClose });
    else
      addRow.mutate(
        { dayId: editing.dayId, after: editing.after, ...input },
        { onSuccess: onClose },
      );
  };
  return (
    <Dialog
      title={row ? "Edit the row" : editing.after ? "Insert a row" : "Add a row"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="schedule-row"
            disabled={!valid || saving.isPending}
          >
            {row ? "Save" : "Add"}
          </Button>
        </>
      }
    >
      <form
        id="schedule-row"
        onSubmit={save}
        className="grid grid-cols-1 gap-3 @xl/app:grid-cols-2"
      >
        <Field label="Kind" error={saving.error?.message}>
          <Dropdown
            variant="field"
            value={kindWords[kind]}
            actions={scheduleRowKinds.map((k) => ({
              label: kindWords[k],
              checked: k === kind,
              onSelect: () => setKind(k),
            }))}
          />
        </Field>
        <Field
          label={kind === "slot" ? "Label, if no repertoire" : "Label"}
          hint={kind === "break" ? "Lunch, coffee" : undefined}
        >
          <Input value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Starts" hint="Blank to follow the row before">
          <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="Minutes" error={valid ? undefined : "Whole minutes, up to a day"}>
          <Input inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        </Field>
        {kind === "slot" && (
          <div className="flex flex-col gap-2 @xl/app:col-span-2">
            <span className="label">Repertoire</span>
            <label className="flex items-center gap-2 text-[14px] text-ink">
              <Checkbox
                checked={allRepertoire}
                onChange={(e) => setAllRepertoire(e.target.checked)}
              />
              All repertoire
            </label>
            {!allRepertoire && (
              <div className="scroll-quiet flex max-h-56 flex-col gap-1.5 overflow-y-auto rounded-control border border-line p-2">
                {data.works.length === 0 && data.tracks.length === 0 && (
                  <p className="m-0 text-[13px] text-ink-3">No works or tracks yet.</p>
                )}
                {data.works.map((w) => (
                  <label key={w.id} className="flex items-center gap-2 text-[14px] text-ink">
                    <Checkbox
                      checked={workIds.has(w.id)}
                      onChange={() => setWorkIds((s) => flip(s, w.id))}
                    />
                    <span className="truncate">{w.title}</span>
                    <span className="text-[13px] text-ink-3">whole work</span>
                  </label>
                ))}
                {data.tracks.map((t) => (
                  <label key={t.id} className="flex items-center gap-2 text-[14px] text-ink">
                    <Checkbox
                      checked={trackIds.has(t.id)}
                      onChange={() => setTrackIds((s) => flip(s, t.id))}
                    />
                    <span className="truncate">{t.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
        <Field label="Personnel" className="@xl/app:col-span-2">
          <Input
            value={personnel}
            maxLength={200}
            placeholder="Trio, engineer"
            onChange={(e) => setPersonnel(e.target.value)}
          />
        </Field>
        <Field label="Notes" className="@xl/app:col-span-2">
          <Textarea
            value={notes}
            rows={2}
            maxLength={1000}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  );
}

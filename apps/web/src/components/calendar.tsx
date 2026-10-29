import {
  type CalendarEntry,
  type CalendarEvent,
  type CalendarKind,
  daysOf,
  monthGrid,
  shiftMonth,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type MouseEvent, type ReactNode, useState } from "react";
import { EntryDialog } from "~/components/calendar-entry";
import { Icon, type IconName } from "~/components/icons";
import { Card } from "~/components/page";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { cn } from "~/lib/cn";
import { dayHere, formatDates } from "~/lib/locale";
import { projectCalendarQuery, useCalendarFeed, useProjectCan } from "~/lib/queries";

/** Each kind's mark; an entry's is its own kind's. */
const kindIcon: Record<CalendarKind, IconName> = {
  review: "review",
  task: "task",
  track: "flag",
  session: "mic",
  schedule: "calendar",
  entry: "calendar",
};
export const entryIcon: Record<CalendarEntry["kind"], IconName> = {
  session: "mic",
  delivery: "send",
  meeting: "users",
  other: "calendar",
};
export const iconOf = (e: CalendarEvent): IconName =>
  e.entry ? entryIcon[e.entry.kind] : kindIcon[e.kind];

/** What is being opened: a new entry on a day, or an entry to change. */
type Opening = { day?: string; entry?: CalendarEntry } | null;

const monthFormat = formatDates({ month: "long", year: "numeric", timeZone: "UTC" });
const dayFormat = formatDates({ weekday: "short", day: "numeric", timeZone: "UTC" });
const sinceFormat = formatDates({ day: "numeric", month: "long", year: "numeric" });

/** This month where the member is: 2026-10. */
export const thisMonth = () => dayHere().slice(0, 7);

/**
 * The feed of a project's calendar (#141), into whichever calendar someone keeps. The link is
 * theirs alone and shown once, as it is made: getting a new one stops the old.
 */
function SubscribeDialog({
  projectId,
  projectName,
  feed,
  onClose,
}: {
  projectId: string;
  projectName: string;
  feed: { createdAt: string; readAt: string | null } | null;
  onClose: () => void;
}) {
  const { create, remove } = useCalendarFeed(projectId);
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const url = create.data;
  const copy = () => {
    if (!url) return;
    void navigator.clipboard
      ?.writeText(url)
      .then(() => setCopied("copied"))
      .catch(() => setCopied("failed"));
  };
  const failure = create.error ?? remove.error;
  return (
    <Dialog
      title="Add to your calendar"
      description={`A feed of ${projectName}: review due dates, task deadlines, sessions and schedule days. It updates itself; the link is yours alone.`}
      onClose={onClose}
      width="sm"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {url ? (
          <>
            <div className="flex items-center gap-2 rounded-control border border-line bg-ground/60 px-3 py-2">
              <Icon name="link" size={14} className="shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2" title={url}>
                {url}
              </span>
              <button
                type="button"
                onClick={copy}
                className="shrink-0 rounded-control px-1 text-[13px] text-ink-3 hover:text-ink"
              >
                {copied === "copied" ? "Copied" : copied === "failed" ? "Copy it by hand" : "Copy"}
              </button>
            </div>
            <p className="m-0 text-[12px] text-ink-3">
              Paste it where your calendar subscribes to a calendar by address: Apple Calendar (New
              Calendar Subscription), Google Calendar (From URL) or Outlook (Subscribe from web). It
              is shown only now; you can always make a new one.
            </p>
          </>
        ) : (
          <>
            {feed && (
              <p className="m-0 text-[13px] text-ink-2">
                You made a link on {sinceFormat.format(new Date(feed.createdAt))}
                {feed.readAt
                  ? `; a calendar last read it on ${sinceFormat.format(new Date(feed.readAt))}`
                  : ""}
                . A new one stops it.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => create.mutate()} disabled={create.isPending}>
                <Icon name="calendar" size={14} />
                {feed ? "Make a new link" : "Make my link"}
              </Button>
              {feed && (
                <Button variant="ghost" onClick={() => remove.mutate()} disabled={remove.isPending}>
                  Stop the feed
                </Button>
              )}
            </div>
          </>
        )}
        {failure && <p className="m-0 text-[13px] text-signal">{failure.message}</p>}
        <p className="m-0 text-[12px] text-ink-3">
          Anyone with the link sees the dates and titles, nothing else, and only while you may see
          this project.
        </p>
      </div>
    </Dialog>
  );
}

/**
 * A month of a project's calendar (#141), as the prototype has it: reviews, tracks and tasks
 * due, sessions recorded, schedule days (#50) and the project's own entries (#505), each
 * opening where it is; late ones marked. Whoever edits the schedule adds an entry from the
 * button or by double-clicking a day, and opens one to change it. The feed takes it elsewhere.
 */
export function ProjectCalendar({
  projectId,
  projectName,
  month,
  onMonth,
}: {
  projectId: string;
  projectName: string;
  month: string;
  onMonth: (month: string) => void;
}) {
  const { data, error } = useQuery(projectCalendarQuery(projectId, { month }));
  const can = useProjectCan(projectId);
  const editing = can("edit_production");
  const [subscribing, setSubscribing] = useState(false);
  const [opening, setOpening] = useState<Opening>(null);
  const { days } = monthGrid(month);
  const today = dayHere();
  const byDay = new Map<string, CalendarEvent[]>();
  // An entry over several days is on each of them.
  for (const e of data?.events ?? [])
    for (const day of daysOf(e.date, e.end)) byDay.set(day, [...(byDay.get(day) ?? []), e]);
  const monthEvents = (data?.events ?? []).filter(
    (e) => e.date.startsWith(month) || e.end?.startsWith(month),
  );
  // A double-click on a day starts an entry there; a click on what is already there does not.
  const onDayDoubleClick = (event: MouseEvent<HTMLElement>) => {
    if (!editing) return;
    const target = event.target as HTMLElement;
    if (target.closest("a, button")) return;
    const day = target.closest<HTMLElement>("[data-day]")?.dataset.day;
    if (day) setOpening({ day });
  };
  /** An entry opens its dialog for whoever may change it; anything else opens where it is. */
  const item = (e: CalendarEvent, className: string, children: ReactNode) =>
    e.entry && editing ? (
      <button
        type="button"
        onClick={() => setOpening({ entry: e.entry })}
        className={cn(className, "text-left")}
      >
        {children}
      </button>
    ) : (
      <Link to={e.link} className={className}>
        {children}
      </Link>
    );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => onMonth(shiftMonth(month, -1))}
          className="flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-raised hover:text-ink"
        >
          <Icon name="chevronLeft" size={14} />
        </button>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => onMonth(shiftMonth(month, 1))}
          className="flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-raised hover:text-ink"
        >
          <Icon name="chevronRight" size={14} />
        </button>
        <h2 className="m-0 text-[15px] font-medium text-ink">
          {monthFormat.format(new Date(`${month}-01T12:00:00Z`))}
        </h2>
        {month !== thisMonth() && (
          <button
            type="button"
            onClick={() => onMonth(thisMonth())}
            className="h-8 rounded-control px-2 text-[13px] text-ink-3 hover:bg-raised hover:text-ink"
          >
            Today
          </button>
        )}
        <span className="ml-auto flex items-center gap-2">
          <Button variant="secondary" onClick={() => setSubscribing(true)}>
            <Icon name="calendar" size={14} />
            <span className="sr-only @md/app:not-sr-only">Add to your calendar</span>
          </Button>
          {editing && (
            <Button variant="primary" onClick={() => setOpening({ day: dayHere() })}>
              <Icon name="plus" size={14} />
              New entry
            </Button>
          )}
        </span>
      </div>
      {error && <p className="m-0 text-signal">{error.message}</p>}
      <Card className="overflow-hidden">
        <div className="grid grid-cols-7 border-b border-line" aria-hidden="true">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
            <span key={d} className="eyebrow px-2 py-2">
              {d}
            </span>
          ))}
        </div>
        {/* A double-click on a day is a shortcut to New entry above, which the keyboard reaches. */}
        <ol className="m-0 grid list-none grid-cols-7 p-0" onDoubleClick={onDayDoubleClick}>
          {days.map((day, i) => {
            const list = byDay.get(day) ?? [];
            const inMonth = day.startsWith(month);
            return (
              <li
                key={day}
                aria-label={day}
                data-day={day}
                className={cn(
                  "flex min-h-[64px] min-w-0 flex-col gap-1 border-b border-line p-1.5 @3xl/app:min-h-[104px]",
                  i % 7 !== 6 && "border-r",
                  !inMonth && "bg-sunken/40",
                )}
              >
                <span
                  className={cn(
                    "tabular flex size-6 items-center justify-center rounded-full text-[12px]",
                    day === today
                      ? "bg-signal font-medium text-ground"
                      : inMonth
                        ? "text-ink-2"
                        : "text-ink-3",
                  )}
                >
                  {Number(day.slice(8))}
                </span>
                {/* On a phone a day has room for a mark only; the list below names them. */}
                {list.length > 0 && (
                  <span className="flex flex-wrap gap-0.5 px-1 @3xl/app:hidden" aria-hidden="true">
                    {list.slice(0, 3).map((e) => (
                      <span
                        key={e.id}
                        className={cn(
                          "size-1.5 rounded-full",
                          e.overdue ? "bg-signal" : "bg-ink-3",
                        )}
                      />
                    ))}
                  </span>
                )}
                {list.slice(0, 3).map((e) => (
                  <span key={e.id} className="hidden min-w-0 @3xl/app:flex" title={e.title}>
                    {item(
                      e,
                      cn(
                        "flex min-w-0 flex-1 items-center gap-1 rounded-chip border px-1.5 py-0.5 text-[11px] leading-[15px] transition-colors hover:border-edge",
                        e.overdue
                          ? "border-signal/40 bg-signal/10 text-ink"
                          : e.kind === "review" || e.kind === "track"
                            ? "border-line bg-raised/60 text-ink"
                            : e.kind === "entry"
                              ? "border-line-strong bg-raised/30 text-ink"
                              : "border-line text-ink-2",
                      ),
                      <>
                        <Icon name={iconOf(e)} size={10} className="shrink-0 text-ink-3" />
                        <span className="truncate">{e.title}</span>
                      </>,
                    )}
                  </span>
                ))}
                {list.length > 3 && (
                  <span className="hidden px-1 text-[11px] text-ink-3 @3xl/app:inline">
                    and {list.length - 3} more
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </Card>
      <ol className="m-0 flex list-none flex-col p-0 @3xl/app:hidden">
        {monthEvents.map((e) => (
          <li key={e.id} className="border-b border-line last:border-b-0">
            {item(
              e,
              "flex min-h-11 w-full items-center gap-3 py-2 text-[14px] text-ink hover:text-ink",
              <>
                <span
                  className={cn(
                    "tabular w-14 shrink-0 text-[13px]",
                    e.overdue ? "text-signal" : "text-ink-3",
                  )}
                >
                  {dayFormat.format(new Date(`${e.date}T12:00:00Z`))}
                </span>
                <Icon name={iconOf(e)} size={14} className="shrink-0 text-ink-3" />
                <span className="min-w-0 flex-1 truncate">
                  {e.title}
                  {e.end && (
                    <span className="text-ink-3">
                      {" "}
                      to {dayFormat.format(new Date(`${e.end}T12:00:00Z`))}
                    </span>
                  )}
                </span>
                {e.overdue && <span className="shrink-0 text-[12px] text-signal">Late</span>}
              </>,
            )}
          </li>
        ))}
        {data && monthEvents.length === 0 && (
          <li className="py-2 text-[13px] text-ink-3">Nothing due or booked this month.</li>
        )}
      </ol>
      <p className="m-0 text-[12px] text-ink-3">
        Review, track and task deadlines, recording sessions, schedule days and the project's
        entries{editing ? "; double-click a day to add one" : ""}.
      </p>
      {opening && (
        <EntryDialog
          projectId={projectId}
          entry={opening.entry}
          day={opening.day}
          onClose={() => setOpening(null)}
        />
      )}
      {subscribing && (
        <SubscribeDialog
          projectId={projectId}
          projectName={projectName}
          feed={data?.feed ?? null}
          onClose={() => setSubscribing(false)}
        />
      )}
    </div>
  );
}

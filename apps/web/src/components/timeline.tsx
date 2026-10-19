import { shiftWeeks, timelineBar, timelineWeeks } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useLayoutEffect, useRef, useState } from "react";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { Card } from "~/components/page";
import { cn } from "~/lib/cn";
import { formatDates } from "~/lib/locale";
import { projectBoardQuery } from "~/lib/queries";

const weekFormat = formatDates({ day: "numeric", month: "short", timeZone: "UTC" });
const rangeFormat = formatDates({
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const WEEKS = 6;
const DAYS = WEEKS * 7;

const today = () => new Date().toLocaleDateString("en-CA");
const noon = (day: string) => new Date(`${day}T12:00:00Z`);

/**
 * A project's tracks across six weeks (#141), approximating a Gantt as the prototype does: each
 * runs from its latest version to when an open review of it is due, labelled with the step it
 * waits at, finished ones solid and late ones marked. Moved by three weeks at a time.
 */
export function ProjectTimeline({ projectId }: { projectId: string }) {
  const { data, error } = useQuery(projectBoardQuery(projectId));
  const [day, setDay] = useState(today);
  const scroller = useRef<HTMLDivElement>(null);
  const span = useRef<HTMLDivElement>(null);
  const weeks = timelineWeeks(day, WEEKS);
  const start = weeks[0] ?? day;
  const now = today();
  const todayAt = (Date.parse(now) - Date.parse(start)) / (DAYS * 86_400_000);
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
  if (error) return <p className="m-0 text-signal">{error.message}</p>;
  if (!data) return null;
  if (data.cards.length === 0)
    return (
      <Empty
        title="No tracks yet"
        text="The timeline runs each track from its latest version to when its review is due. Add a track and upload a version to start."
      />
    );
  const last = shiftWeeks(start, WEEKS);
  const done = new Set(data.columns.status.filter((c) => c.category === "done").map((c) => c.id));
  const end = new Date(Date.parse(last) - 86_400_000).toISOString().slice(0, 10);
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
      </div>
      <Card className="overflow-hidden">
        <div ref={scroller} className="scroll-quiet overflow-x-auto">
          <div className="relative min-w-[720px] [--name:128px] @3xl/app:[--name:180px]">
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
                const bar = timelineBar(card, start, DAYS);
                const finished = card.status !== null && done.has(card.status);
                const late =
                  !finished && card.dueAt !== null && new Date(card.dueAt).getTime() < Date.now();
                const label =
                  card.stage ??
                  card.status ??
                  (card.version ? `Version ${card.version.number}` : "");
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
                        <span
                          title={`${label}: ${weekFormat.formatRange(noon(bar.from), noon(bar.to))}${late ? ", late" : ""}`}
                          className={cn(
                            "absolute top-3 h-6 rounded-[5px] px-2 text-[12px] leading-6",
                            finished
                              ? "bg-ink text-ground"
                              : late
                                ? "border border-signal/50 bg-signal/15 text-ink"
                                : "bg-ink-3 text-ground",
                          )}
                          style={{ left: `${bar.left * 100}%`, width: `${bar.width * 100}%` }}
                        >
                          <span className="block truncate">{label}</span>
                        </span>
                      ) : (
                        <span className="absolute top-3.5 left-2 text-[12px] text-ink-3">
                          {card.version ? "Not in these weeks" : "No version yet"}
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
        From each track's latest version to when its review is due, or a week on where none is.
      </p>
    </div>
  );
}

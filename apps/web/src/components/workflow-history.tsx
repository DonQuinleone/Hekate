import { useQuery } from "@tanstack/react-query";
import { formatDates } from "~/lib/locale";
import { trackWorkflowRunsQuery } from "~/lib/queries";
import { runState, transitionsOf } from "~/lib/workflow-history";
import { Avatar } from "./avatar";
import { Card } from "./page";

const whenFormat = formatDates({
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * A track's history of transitions (#25), under its versions as the prototype has it: each run
 * of its workflows, newest first, and every move it made in order, with the status it set, who
 * made it and when. A move nobody made (a wait that elapsed, a due date passing) is Hekate's.
 * Nothing shows for a track no workflow has run on.
 */
export function WorkflowHistory({ trackId }: { trackId: string }) {
  const { data: runs = [] } = useQuery(trackWorkflowRunsQuery(trackId));
  if (runs.length === 0) return null;
  return (
    <section aria-label="Workflow history" className="flex flex-col gap-2">
      <h2 className="eyebrow m-0 px-1">History</h2>
      <Card>
        {runs.map((run) => (
          <div key={run.id} className="border-t border-line first:border-t-0">
            <div className="flex flex-wrap items-baseline gap-x-2 px-4 pt-3 pb-1 text-[13px]">
              <span className="font-medium text-ink">{run.workflowName}</span>
              <span className="text-ink-3">{runState(run)}</span>
            </div>
            <ol className="m-0 list-none p-0 pb-1.5">
              {transitionsOf(run).map((t) => (
                <li
                  key={t.key}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-1.5 text-[13px] @3xl/app:grid-cols-[120px_minmax(0,1fr)_180px]"
                >
                  <time
                    dateTime={t.at}
                    className="tabular col-span-2 text-[12px] text-ink-3 @3xl/app:col-span-1 @3xl/app:text-[13px]"
                  >
                    {whenFormat.format(new Date(t.at))}
                  </time>
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-ink-2">
                    <span className="truncate">{t.text}</span>
                    {t.status && (
                      <span className="rounded-chip bg-raised px-1.5 text-[12px] text-ink-2">
                        {t.status}
                      </span>
                    )}
                  </span>
                  <span className="flex min-w-0 items-center gap-2 justify-self-end text-ink-3 @3xl/app:justify-self-start">
                    {t.by ? (
                      <>
                        <Avatar id={t.byId ?? t.by} name={t.by} size={18} />
                        <span className="truncate">{t.by}</span>
                      </>
                    ) : (
                      <span>Hekate</span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </Card>
    </section>
  );
}

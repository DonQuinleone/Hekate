import {
  formatJobSeconds,
  type QueueJobRow,
  type QueueRetryResult,
  type QueueRow,
  type QueuesView,
} from "@hekate/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Code, Fact, Facts } from "~/components/inspect";
import { Row, Section } from "~/components/settings";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { ActionMenu } from "~/components/ui/menu";
import { type ReviewState, StatusDot } from "~/components/ui/status";
import { api } from "~/lib/api";
import { cn } from "~/lib/cn";
import { ago } from "~/lib/comments";
import { formatDates } from "~/lib/locale";
import { instanceQueueJobQuery, instanceQueuesQuery, json } from "~/lib/queries";

const moment = formatDates({
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const at = (iso: string | null) => (iso ? moment.format(new Date(iso)) : "Not yet");

const dotOf = (state: QueueJobRow["state"]): ReviewState =>
  state === "completed"
    ? "approved"
    : state === "failed"
      ? "changes_requested"
      : state === "cancelled"
        ? "cancelled"
        : "in_review";

const stateWords: Record<QueueJobRow["state"], string> = {
  created: "waiting",
  retry: "waiting to be tried again",
  active: "running",
  completed: "done",
  cancelled: "cancelled",
  failed: "failed",
};

const retried = (r: QueueRetryResult) =>
  r.retried + r.cleared === 0
    ? "Nothing had failed."
    : [
        r.retried > 0 && `${r.retried} running again`,
        r.cleared > 0 &&
          `${r.cleared} cleared, as ${r.cleared === 1 ? "its file was" : "their files were"} prepared or removed since`,
      ]
        .filter(Boolean)
        .join("; ")
        .replace(/^./, (c) => c.toUpperCase())
        .concat(".");

const columns =
  "grid grid-cols-[minmax(0,1fr)_repeat(4,52px)_28px] items-center gap-2 px-4 @3xl/app:grid-cols-[minmax(0,1fr)_repeat(4,80px)_32px]";

/**
 * Instance, Queues (decision 250): every pg-boss queue with what waits, runs and failed in it,
 * and what an operator does about them; the jobs that ran last, each with its Details.
 */
export function Queues() {
  const client = useQueryClient();
  const { data, error } = useQuery(instanceQueuesQuery);
  const [note, setNote] = useState<string | null>(null);
  const [draining, setDraining] = useState<QueueRow | null>(null);
  const [details, setDetails] = useState<QueueJobRow | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ["instance", "queues"] });
  const set = (view: QueuesView) => client.setQueryData(instanceQueuesQuery.queryKey, view);
  const retryAll = useMutation({
    mutationFn: async () => json<QueueRetryResult>(await api.instance.queues.retry.$post()),
    onSuccess: (r) => {
      setNote(retried(r));
      void refresh();
    },
  });
  const pauseAll = useMutation({
    mutationFn: async (paused: boolean) =>
      json<QueuesView>(await api.instance.queues.pause.$post({ json: { paused } })),
    onSuccess: set,
  });
  const retryQueue = useMutation({
    mutationFn: async (name: string) =>
      json<QueueRetryResult>(await api.instance.queues[":name"].retry.$post({ param: { name } })),
    onSuccess: (r) => {
      setNote(retried(r));
      void refresh();
    },
  });
  const pause = useMutation({
    mutationFn: async ({ name, paused }: { name: string; paused: boolean }) =>
      json<QueuesView>(
        await api.instance.queues[":name"].pause.$post({ param: { name }, json: { paused } }),
      ),
    onSuccess: set,
  });
  const retryJob = useMutation({
    mutationFn: async (job: QueueJobRow) =>
      json<QueueRetryResult>(
        await api.instance.queues[":name"].jobs[":id"].retry.$post({
          param: { name: job.queue, id: job.id },
        }),
      ),
    onSuccess: (r) => {
      setNote(retried(r));
      void refresh();
    },
  });
  const failure =
    retryAll.error ?? pauseAll.error ?? retryQueue.error ?? pause.error ?? retryJob.error;
  if (error)
    return (
      <Section title="Queues">
        <Row name="The queue could not be read" hint={error.message} />
      </Section>
    );
  if (!data) return null;
  const failed = data.queues.reduce((n, q) => n + q.failed, 0);
  const allPaused = data.queues.every((q) => q.paused);
  return (
    <>
      <Section
        title="Queues"
        intro="pg-boss in the database. A failed job is tried again with backoff, then waits here with an error reference."
        action={
          <span className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="md"
              disabled={failed === 0 || retryAll.isPending}
              onClick={() => retryAll.mutate()}
            >
              Retry every failure
            </Button>
            <Button
              variant="ghost"
              size="md"
              disabled={pauseAll.isPending}
              onClick={() => pauseAll.mutate(!allPaused)}
            >
              {allPaused ? "Resume all" : "Pause all"}
            </Button>
          </span>
        }
      >
        {data.maintenance && (
          <Row
            name="Maintenance mode is on"
            hint="Every queue waits until it is over, whatever is paused here. Nothing is lost."
          />
        )}
        {(note || failure) && (
          <p
            role={failure ? "alert" : "status"}
            className={cn("m-0 px-4 py-2 text-[13px]", failure ? "text-signal" : "text-ink-2")}
          >
            {failure?.message ?? note}
          </p>
        )}
        <div className={cn(columns, "py-2")}>
          <span className="eyebrow">Queue</span>
          <span className="eyebrow text-right">Waiting</span>
          <span className="eyebrow text-right">Active</span>
          <span className="eyebrow text-right">Failed</span>
          <span className="eyebrow text-right">p95</span>
          <span />
        </div>
        {data.queues.map((q) => (
          <div key={q.name} className={cn(columns, "group py-2.5")}>
            <span className="min-w-0">
              <span className="tabular flex items-center gap-2 text-[14px] text-ink">
                <span className="truncate">{q.name}</span>
                {q.paused && <span className="shrink-0 text-[12px] text-signal">Paused</span>}
              </span>
              <span className="block truncate text-[12px] text-ink-3">
                {q.hint}
                {q.scheduled ? " · scheduled" : ""}
              </span>
            </span>
            <span className="tabular text-right text-[13px] text-ink-2">{q.waiting}</span>
            <span className="tabular text-right text-[13px] text-ink-2">{q.active}</span>
            <span
              className={cn(
                "tabular text-right text-[13px]",
                q.failed ? "text-signal" : "text-ink-3",
              )}
            >
              {q.failed}
            </span>
            <span className="tabular text-right text-[13px] text-ink-3">
              {q.p95Seconds === null ? "–" : formatJobSeconds(q.p95Seconds)}
            </span>
            <ActionMenu
              label={q.name}
              actions={[
                {
                  label: "Retry failed",
                  onSelect: () => retryQueue.mutate(q.name),
                },
                {
                  label: q.paused ? "Resume" : "Pause",
                  onSelect: () => pause.mutate({ name: q.name, paused: !q.paused }),
                },
                { label: "Drain…", danger: true, onSelect: () => setDraining(q) },
              ]}
            />
          </div>
        ))}
      </Section>
      <Section
        title="Recent jobs"
        intro="The last day's work for files, channels and workspaces; scheduled sweeps when they failed."
      >
        {data.recent.length === 0 && (
          <Row name="Nothing yet" hint="Jobs appear here as files arrive and mail goes out." />
        )}
        {data.recent.map((j) => (
          <Row
            key={j.id}
            name={
              <span className="flex min-w-0 items-center gap-2">
                <StatusDot state={dotOf(j.state)} />
                <span className="tabular shrink-0 text-[12px] text-ink-3">{j.queue}</span>
                <span className="truncate">{j.what ?? stateWords[j.state]}</span>
              </span>
            }
            hint={[j.workspace?.name ?? "The instance", stateWords[j.state], ago(j.at), j.reference]
              .filter(Boolean)
              .join(" · ")}
          >
            {j.state === "failed" && (
              <Button
                variant="secondary"
                size="md"
                disabled={retryJob.isPending}
                onClick={() => retryJob.mutate(j)}
              >
                Retry
              </Button>
            )}
            <Button variant="ghost" size="md" onClick={() => setDetails(j)}>
              Details
            </Button>
          </Row>
        ))}
      </Section>
      {draining && <DrainQueue queue={draining} onClose={() => setDraining(null)} />}
      {details && <JobDetails job={details} onClose={() => setDetails(null)} />}
    </>
  );
}

/** Draining removes what waits, so it is asked first. */
function DrainQueue({ queue, onClose }: { queue: QueueRow; onClose: () => void }) {
  const client = useQueryClient();
  const drain = useMutation({
    mutationFn: async () =>
      json<{ drained: number }>(
        await api.instance.queues[":name"].drain.$post({ param: { name: queue.name } }),
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["instance", "queues"] });
      onClose();
    },
  });
  return (
    <Dialog
      title={`Drain ${queue.name}`}
      description={`The ${queue.waiting === 1 ? "job" : `${queue.waiting} jobs`} waiting in it ${queue.waiting === 1 ? "is" : "are"} removed, and none of them runs. A file whose preparation waited there is marked failed, for its Retry to prepare it later. Running and failed jobs stay.`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={drain.isPending} onClick={() => drain.mutate()}>
            Drain
          </Button>
        </>
      }
    >
      {drain.error && (
        <p role="alert" className="m-0 text-[13px] text-signal">
          {drain.error.message}
        </p>
      )}
    </Dialog>
  );
}

/** One job in full: when it moved, its attempts, its data and its last error. */
function JobDetails({ job, onClose }: { job: QueueJobRow; onClose: () => void }) {
  const { data: d, error } = useQuery(instanceQueueJobQuery(job.queue, job.id));
  return (
    <Dialog
      title={job.what ?? job.queue}
      description={`${job.queue} · ${job.id}`}
      onClose={onClose}
      width="lg"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      {error && <p className="m-0 text-[13px] text-signal">{error.message}</p>}
      {d && (
        <div className="flex flex-col gap-3">
          <Facts>
            <Fact term="State">{stateWords[d.state]}</Fact>
            <Fact term="Workspace">{d.workspace?.name ?? "The instance"}</Fact>
            <Fact term="Attempts" tabular>
              {`${d.attempts} of ${d.retryLimit + 1}`}
            </Fact>
            <Fact term="Queued" tabular>
              {at(d.createdAt)}
            </Fact>
            <Fact term="Started" tabular>
              {at(d.startedAt)}
            </Fact>
            <Fact term="Finished" tabular>
              {at(d.completedAt)}
            </Fact>
            {d.reference && (
              <Fact term="Error reference" tabular>
                <Link
                  to="/instance/$section"
                  params={{ section: "debug" }}
                  search={{ reference: d.reference }}
                  className="text-ink underline-offset-2 hover:underline"
                >
                  {d.reference}
                </Link>
              </Fact>
            )}
          </Facts>
          {d.error && <Code label="Its last error">{d.error}</Code>}
          {d.data && <Code label="Its data">{JSON.stringify(d.data, null, 2)}</Code>}
        </div>
      )}
    </Dialog>
  );
}

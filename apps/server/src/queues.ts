import { type Database, inOrg, schema } from "@hekate/db";
import {
  type QueueJobDetail,
  type QueueJobRow,
  type QueueJobState,
  type QueueRetryResult,
  type QueueRow,
  queueHints,
  queueJobStates,
} from "@hekate/shared";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { type JobName, type Jobs, jobDefinitions, type QueueAdmin } from "./jobs.ts";
import { retryFile } from "./routes/retry.ts";

/**
 * The instance's Queues (decision 250), read from pg-boss's own table as the metrics are, and
 * acted on through pg-boss. Job data holds identifiers only; what a job was for is looked up in
 * the workspace its data names, with `inOrg`, as the instance side alone may (decision 066).
 */

export const queueNames = Object.keys(jobDefinitions) as JobName[];
export const isQueue = (name: string): name is JobName => name in jobDefinitions;

/** A file's preparation: run again by its retry plan, so the file waits again as it does so. */
const FILE_JOBS = new Set<string>([
  "media-probe",
  "media-proxy",
  "media-analysis",
  "document-render",
]);
/** How many failures one call runs again; the rest wait for the next. */
const RETRY_BATCH = 500;
/** How many jobs Recent jobs lists. */
const RECENT = 20;

/** The queue's tables not made yet (a fresh database, before the worker first starts). */
const notYetMade = (error: unknown) => {
  const code = (error as { cause?: { code?: string }; code?: string }).cause?.code;
  return code === "42P01" || code === "3F000";
};

const jobTable = (admin: Pick<QueueAdmin, "schema">) => sql`${sql.identifier(admin.schema)}.job`;
const iso = (d: Date | string) => new Date(d).toISOString();
const stateOf = (s: string): QueueJobState =>
  (queueJobStates as readonly string[]).includes(s) ? (s as QueueJobState) : "created";
const idsOf = (data: unknown) => {
  const d = (data ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof d[key] === "string" ? (d[key] as string) : null);
  return {
    organisationId: text("organisationId"),
    fileId: text("fileId"),
    blobId: text("blobId"),
    deliveryId: text("deliveryId"),
    runId: text("runId"),
    exportId: text("exportId"),
  };
};

/** Every queue with its counts and its jobs' p95 over the last day; null when unreadable. */
export async function queueRows(
  db: Database,
  admin: Pick<QueueAdmin, "schema">,
  paused: readonly string[],
): Promise<QueueRow[] | null> {
  let rows: {
    name: string;
    waiting: number;
    active: number;
    failed: number;
    p95: number | null;
  }[];
  try {
    rows = await db.execute(sql`
      select name,
        count(*) filter (where state in ('created', 'retry'))::int as waiting,
        count(*) filter (where state = 'active')::int as active,
        count(*) filter (where state = 'failed')::int as failed,
        percentile_cont(0.95) within group (
          order by extract(epoch from completed_on - started_on)
        ) filter (
          where state = 'completed' and started_on is not null
            and completed_on > now() - interval '1 day'
        ) as p95
      from ${jobTable(admin)}
      group by name`);
  } catch (error) {
    if (!notYetMade(error)) {
      console.error("The job queue could not be read:", error);
      return null;
    }
    rows = [];
  }
  const byName = new Map(rows.map((r) => [r.name, r]));
  return queueNames.map((name) => {
    const r = byName.get(name);
    const definition = jobDefinitions[name];
    return {
      name,
      lane: definition.lane,
      hint: queueHints[name] ?? "",
      scheduled: "schedule" in definition,
      waiting: r?.waiting ?? 0,
      active: r?.active ?? 0,
      failed: r?.failed ?? 0,
      p95Seconds: r?.p95 === null || r?.p95 === undefined ? null : Number(r.p95),
      paused: paused.includes(name),
    };
  });
}

type JobRecord = {
  id: string;
  name: string;
  state: string;
  data: unknown;
  retry_count: number;
  retry_limit: number;
  created_on: Date | string;
  started_on: Date | string | null;
  completed_on: Date | string | null;
  output: unknown;
};

/**
 * What jobs were for, in words: the file, the channel or the track their data names, each looked
 * up only in the workspace the data names. Null where the data names nothing, or nothing now.
 */
async function describe(db: Database, jobs: JobRecord[]) {
  const ids = jobs.map((j) => ({ id: j.id, ...idsOf(j.data) }));
  const orgIds = [...new Set(ids.flatMap((j) => (j.organisationId ? [j.organisationId] : [])))];
  const workspaces = new Map(
    orgIds.length
      ? (
          await db
            .select({ id: schema.organisations.id, name: schema.organisations.name })
            .from(schema.organisations)
            .where(inArray(schema.organisations.id, orgIds))
        ).map((o) => [o.id, o.name])
      : [],
  );
  const what = new Map<string, string>();
  for (const orgId of orgIds) {
    const mine = ids.filter((j) => j.organisationId === orgId);
    const fileIds = mine.flatMap((j) => (j.fileId ? [j.fileId] : []));
    const blobIds = mine.flatMap((j) => (j.blobId ? [j.blobId] : []));
    const deliveryIds = mine.flatMap((j) => (j.deliveryId ? [j.deliveryId] : []));
    const runIds = mine.flatMap((j) => (j.runId ? [j.runId] : []));
    const files = fileIds.length
      ? await db
          .select({ id: schema.files.id, name: schema.files.name })
          .from(schema.files)
          .where(inOrg(schema.files, orgId, inArray(schema.files.id, fileIds)))
      : [];
    const blobs = blobIds.length
      ? await db
          .select({ id: schema.files.blobId, name: schema.files.name })
          .from(schema.files)
          .where(inOrg(schema.files, orgId, inArray(schema.files.blobId, blobIds)))
      : [];
    const channels = deliveryIds.length
      ? await db
          .select({ id: schema.eventDeliveries.id, name: schema.channels.name })
          .from(schema.eventDeliveries)
          .innerJoin(schema.channels, eq(schema.channels.id, schema.eventDeliveries.channelId))
          .where(
            inOrg(schema.eventDeliveries, orgId, inArray(schema.eventDeliveries.id, deliveryIds)),
          )
      : [];
    const runs = runIds.length
      ? await db
          .select({ id: schema.workflowRuns.id, name: schema.tracks.name })
          .from(schema.workflowRuns)
          .innerJoin(schema.tracks, eq(schema.tracks.id, schema.workflowRuns.trackId))
          .where(inOrg(schema.workflowRuns, orgId, inArray(schema.workflowRuns.id, runIds)))
      : [];
    const names = new Map<string, string>([
      ...files.map((f): [string, string] => [`file:${f.id}`, f.name]),
      ...blobs.map((f): [string, string] => [`blob:${f.id}`, f.name]),
      ...channels.map((c): [string, string] => [`delivery:${c.id}`, c.name]),
      ...runs.map((r): [string, string] => [`run:${r.id}`, r.name]),
    ]);
    for (const j of mine) {
      const found =
        (j.fileId && names.get(`file:${j.fileId}`)) ||
        (j.blobId && names.get(`blob:${j.blobId}`)) ||
        (j.deliveryId && names.get(`delivery:${j.deliveryId}`)) ||
        (j.runId && names.get(`run:${j.runId}`)) ||
        (j.exportId ? "Workspace export" : null);
      if (found) what.set(j.id, found);
    }
  }
  const references = new Map<string, string>();
  const failed = jobs.filter((j) => j.state === "failed").map((j) => j.id);
  if (failed.length) {
    const reports = await db
      .select({ jobId: schema.errorReports.jobId, reference: schema.errorReports.reference })
      .from(schema.errorReports)
      .where(inArray(schema.errorReports.jobId, failed))
      .orderBy(desc(schema.errorReports.occurredAt));
    for (const r of reports)
      if (r.jobId && !references.has(r.jobId)) references.set(r.jobId, r.reference);
  }
  return (j: JobRecord): QueueJobRow => {
    const { organisationId } = idsOf(j.data);
    const name = organisationId ? workspaces.get(organisationId) : undefined;
    return {
      id: j.id,
      queue: j.name,
      state: stateOf(j.state),
      what: what.get(j.id) ?? null,
      workspace: organisationId && name !== undefined ? { id: organisationId, name } : null,
      at: iso(j.completed_on ?? j.started_on ?? j.created_on),
      reference: references.get(j.id) ?? null,
    };
  };
}

const jobColumns = sql`id, name, state::text as state, data, retry_count, retry_limit,
  created_on, started_on, completed_on, output`;

/**
 * The latest jobs of the last day: work for files, channels and workspaces, and the scheduled
 * sweeps only where they failed, as they run every minute or hour and would fill the list.
 */
export async function recentJobs(
  db: Database,
  admin: Pick<QueueAdmin, "schema">,
): Promise<QueueJobRow[]> {
  // Only Hekate's own queues: pg-boss keeps its own beside them (`__pgboss_send-it`, which
  // fires the schedules every minute), and they are nobody's work.
  const listOf = (names: readonly JobName[]) =>
    sql.join(
      names.map((n) => sql`${n}`),
      sql`, `,
    );
  const work = queueNames.filter((n) => !("schedule" in jobDefinitions[n]));
  let rows: JobRecord[];
  try {
    rows = await db.execute<JobRecord>(sql`
      select ${jobColumns} from ${jobTable(admin)}
      where created_on > now() - interval '1 day'
        and name in (${listOf(queueNames)})
        and (state = 'failed' or name in (${listOf(work)}))
      order by coalesce(completed_on, started_on, created_on) desc
      limit ${RECENT}`);
  } catch (error) {
    if (notYetMade(error)) return [];
    throw error;
  }
  const row = await describe(db, rows);
  return rows.map(row);
}

/** One job in full; null when the queue holds no such job. */
export async function queueJob(
  db: Database,
  admin: Pick<QueueAdmin, "schema">,
  name: JobName,
  id: string,
): Promise<QueueJobDetail | null> {
  let rows: JobRecord[];
  try {
    rows = await db.execute<JobRecord>(
      sql`select ${jobColumns} from ${jobTable(admin)} where name = ${name} and id = ${id}::uuid`,
    );
  } catch (error) {
    if (notYetMade(error)) return null;
    throw error;
  }
  const [job] = rows;
  if (!job) return null;
  const row = (await describe(db, [job]))(job);
  const output = (job.output ?? null) as { message?: unknown } | null;
  return {
    ...row,
    data: (job.data as Record<string, unknown> | null) ?? null,
    attempts: job.retry_count + 1,
    retryLimit: job.retry_limit,
    createdAt: iso(job.created_on),
    startedAt: job.started_on ? iso(job.started_on) : null,
    completedAt: job.completed_on ? iso(job.completed_on) : null,
    error: job.state === "failed" && typeof output?.message === "string" ? output.message : null,
  };
}

/** Failed jobs of some queues, or the ones named, oldest first, a batch at a time. */
async function failedJobs(
  db: Database,
  admin: Pick<QueueAdmin, "schema">,
  names: readonly JobName[],
  ids?: readonly string[],
): Promise<JobRecord[]> {
  try {
    return await db.execute<JobRecord>(sql`
      select ${jobColumns} from ${jobTable(admin)}
      where state = 'failed' and name in (${sql.join(
        names.map((n) => sql`${n}`),
        sql`, `,
      )})
        ${
          ids
            ? sql`and id in (${sql.join(
                ids.map((i) => sql`${i}::uuid`),
                sql`, `,
              )})`
            : sql``
        }
      order by completed_on
      limit ${RETRY_BATCH}`);
  } catch (error) {
    if (notYetMade(error)) return [];
    throw error;
  }
}

/**
 * Runs failed jobs again (decision 250). A file's preparation runs again as the file's own
 * Retry does, so the file waits again meanwhile, and its old failure leaves the queue; one whose
 * file has since been prepared, or removed, is only cleared. Any other job runs again with its
 * own id and data.
 */
export async function retryFailures(
  db: Database,
  deps: { admin: QueueAdmin; jobs: Pick<Jobs, "send"> },
  names: readonly JobName[],
  ids?: readonly string[],
): Promise<QueueRetryResult> {
  const jobs = await failedJobs(db, deps.admin, names, ids);
  let retried = 0;
  let cleared = 0;
  const plain = new Map<JobName, string[]>();
  for (const job of jobs) {
    const name = job.name as JobName;
    const { organisationId, fileId } = idsOf(job.data);
    if (FILE_JOBS.has(name) && organisationId && fileId) {
      try {
        await retryFile(db, deps.jobs, organisationId, fileId);
        retried += 1;
      } catch (error) {
        const status = error instanceof HTTPException ? error.status : 0;
        // Found nothing failed about the file, or no file: nothing to run.
        if (status !== 404 && status !== 409) throw error;
        cleared += 1;
      }
      await deps.admin.remove(name, job.id);
      continue;
    }
    plain.set(name, [...(plain.get(name) ?? []), job.id]);
  }
  for (const [name, list] of plain) {
    await deps.admin.retry(name, list);
    retried += list.length;
  }
  return { retried, cleared };
}

/**
 * Removes every job waiting in a queue, none of them run. A file whose preparation was waiting
 * there is marked failed at that stage, so its Retry can prepare it again later, rather than
 * waiting for ever.
 */
export async function drainQueue(db: Database, admin: QueueAdmin, name: JobName): Promise<number> {
  let waiting: JobRecord[] = [];
  if (FILE_JOBS.has(name))
    try {
      waiting = await db.execute<JobRecord>(sql`
        select ${jobColumns} from ${jobTable(admin)}
        where name = ${name} and state in ('created', 'retry')`);
    } catch (error) {
      if (!notYetMade(error)) throw error;
    }
  const drained = await admin.drain(name);
  const column =
    name === "media-analysis" ? schema.files.analysisStatus : schema.files.streamStatus;
  for (const job of waiting) {
    const { organisationId, fileId } = idsOf(job.data);
    if (!organisationId || !fileId) continue;
    await db
      .update(schema.files)
      .set(name === "media-analysis" ? { analysisStatus: "failed" } : { streamStatus: "failed" })
      .where(
        inOrg(schema.files, organisationId, eq(schema.files.id, fileId), eq(column, "pending")),
      );
  }
  return drained;
}

/** The queues a pause names, kept in the order the server defines them. */
export const pausedAfter = (paused: readonly string[], name: JobName | "all", on: boolean) => {
  const now = new Set(paused.filter(isQueue));
  for (const n of name === "all" ? queueNames : [name]) {
    if (on) now.add(n);
    else now.delete(n);
  }
  return queueNames.filter((n) => now.has(n));
};

import { type Job, PgBoss, type QueueOptions } from "pg-boss";
import { z } from "zod";
import { concurrencyIn, type Lane, type LanePlan } from "./lanes.ts";
import { metrics } from "./metrics/index.ts";

/**
 * Background work, queued in PostgreSQL with pg-boss. Every job has a name, a
 * zod schema for its data and its retry policy here, so senders and workers
 * share one definition. Job data holds identifiers only, never media or secrets;
 * workers load what they need, scoped to the job's organisation.
 */
export const jobDefinitions = {
  /** Measure an uploaded audio or video file with ffprobe. */
  "media-probe": {
    lane: "analyse",
    data: z.object({ organisationId: z.uuid(), fileId: z.uuid() }),
    options: { retryLimit: 4, retryDelay: 15, retryBackoff: true, expireInSeconds: 10 * 60 },
  },
  /** Package and encrypt a measured file's HLS renditions for protected streaming. */
  "media-proxy": {
    lane: "transcode",
    data: z.object({ organisationId: z.uuid(), fileId: z.uuid() }),
    options: { retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 4 * 60 * 60 },
  },
  /** Analyse a file's audio: waveform peaks, loudness and spectrograms, per channel. */
  "media-analysis": {
    lane: "analyse",
    data: z.object({ organisationId: z.uuid(), fileId: z.uuid() }),
    options: { retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 2 * 60 * 60 },
  },
  /** Draw a document or picture as pages for protected viewing (#29). */
  "document-render": {
    lane: "pages",
    data: z.object({ organisationId: z.uuid(), fileId: z.uuid() }),
    options: { retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 60 * 60 },
  },
  /** Work out where the same music sits in two files, usually successive versions (#33). */
  "media-align": {
    lane: "analyse",
    data: z.object({ organisationId: z.uuid(), alignmentId: z.uuid() }),
    options: { retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 60 * 60 },
  },
  /** Compute a blob's SHA-256 after an upload, whose chunks arrived in any order. */
  "blob-checksum": {
    lane: "analyse",
    data: z.object({ organisationId: z.uuid(), blobId: z.uuid() }),
    options: { retryLimit: 4, retryDelay: 30, retryBackoff: true, expireInSeconds: 60 * 60 },
  },
  /** Each log kept as long as the instance's settings say, and no longer (#157). Daily. */
  "logs-retention": {
    lane: "system",
    data: z.object({}),
    options: { retryLimit: 2, expireInSeconds: 60 * 60 },
    schedule: "23 4 * * *",
  },
  /**
   * Forget sign-in attempts a day old that hold no lock, so they do not pile up, and error
   * reports past their time. Hourly.
   */
  "sign-in-attempts-purge": {
    lane: "system",
    data: z.object({}),
    options: { retryLimit: 1, expireInSeconds: 10 * 60 },
    schedule: "53 * * * *",
  },
  /** Abort uploads that were never completed, so their parts stop taking space. Hourly. */
  "uploads-expire": {
    lane: "system",
    data: z.object({}),
    options: { retryLimit: 2, expireInSeconds: 30 * 60 },
    schedule: "17 * * * *",
  },
  /**
   * Queue alignments still pending a while after their version was made: the queue was
   * down, or the process stopped, between creating the version and queueing its work.
   */
  "alignments-sweep": {
    lane: "system",
    data: z.object({}),
    options: { retryLimit: 1, expireInSeconds: 10 * 60 },
    schedule: "*/15 * * * *",
  },
  /** The releases feed, read once a day when HEKATE_UPDATE_CHECK is on (#158). */
  "release-check": {
    lane: "system",
    data: z.object({}),
    options: { retryLimit: 2, retryDelay: 600, expireInSeconds: 5 * 60 },
    schedule: "17 5 * * *",
  },
  /** Send notifications by mail as they happen. Every minute; each run sends what is waiting. */
  "notifications-mail": {
    lane: "mail",
    data: z.object({}),
    options: { retryLimit: 1, expireInSeconds: 5 * 60 },
    schedule: "* * * * *",
  },
  /** Send each digest that is due: hourly ones every hour, daily ones in the morning. */
  "notifications-digest": {
    lane: "mail",
    data: z.object({}),
    options: { retryLimit: 1, expireInSeconds: 30 * 60 },
    schedule: "3 * * * *",
  },
  /**
   * A workflow node's clock has run out (#25): a wait its days, a feedback or task stage its due
   * date. Its run carries on, if it still waits there.
   */
  "workflow-wait": {
    lane: "system",
    data: z.object({
      organisationId: z.uuid(),
      runId: z.uuid(),
      nodeId: z.string().min(1).max(64),
      stepId: z.uuid(),
    }),
    options: { retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 10 * 60 },
  },
  /**
   * A file has been measured, or cannot be (#25): the workflow checks stages waiting on a
   * version it belongs to look again.
   */
  "workflow-checks": {
    lane: "system",
    data: z.object({ organisationId: z.uuid(), fileId: z.uuid() }),
    options: { retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 10 * 60 },
  },
  /**
   * End the workflow clocks that have run out (waits, and stages past their due date), and the
   * checks stages whose files have all been measured, where no queued job did (#25). Hourly.
   */
  "workflow-waits-sweep": {
    lane: "system",
    data: z.object({}),
    options: { retryLimit: 1, expireInSeconds: 30 * 60 },
    schedule: "41 * * * *",
  },
  /**
   * Remind reviewers the day before a review waiting on them is due, and whoever a task is for
   * on the day it is due and once it is late (#140). Hourly.
   */
  "reviews-remind": {
    lane: "mail",
    data: z.object({}),
    options: { retryLimit: 1, expireInSeconds: 30 * 60 },
    schedule: "29 * * * *",
  },
  /** After a workspace's key is rotated, wrap everything it holds with the new key (#174). */
  "organisation-rewrap": {
    lane: "system",
    data: z.object({ organisationId: z.uuid() }),
    options: { retryLimit: 5, retryDelay: 60, retryBackoff: true, expireInSeconds: 2 * 60 * 60 },
  },
  /**
   * Delete the workspaces whose grace period after an operator deleted them is over, and rewrap
   * any a key rotation left behind. Hourly.
   */
  "workspaces-purge": {
    lane: "system",
    data: z.object({}),
    options: { retryLimit: 1, expireInSeconds: 2 * 60 * 60 },
    schedule: "37 * * * *",
  },
  /** Compare storage with the database: remove what nothing uses, report what is missing. Daily. */
  "storage-reconcile": {
    lane: "system",
    data: z.object({}),
    options: { retryLimit: 1, expireInSeconds: 2 * 60 * 60 },
    schedule: "41 3 * * *",
  },
} satisfies Record<
  string,
  { lane: Lane; data: z.ZodType; options: QueueOptions; schedule?: string }
>;

/** Which lane each kind of job runs in. */
export const laneOf = (name: JobName): Lane => jobDefinitions[name].lane;

export type JobName = keyof typeof jobDefinitions;
export type JobData<N extends JobName> = z.infer<(typeof jobDefinitions)[N]["data"]>;

export interface JobContext {
  id: string;
  /** Aborted when the job expires or the worker stops; pass it to long-running work. */
  signal: AbortSignal;
  retryCount: number;
}

export type JobHandler<N extends JobName> = (data: JobData<N>, job: JobContext) => Promise<void>;

export interface Jobs {
  /** Create the queue schema and queues. Safe to call on every start. */
  start(): Promise<void>;
  /** Stop workers, letting running jobs finish for up to `timeoutMs`. */
  stop(timeoutMs?: number): Promise<void>;
  /** Queue a job. A `singletonKey` drops duplicates while one is queued or running. */
  send<N extends JobName>(
    name: N,
    data: JobData<N>,
    options?: { singletonKey?: string; startAfterSeconds?: number },
  ): Promise<string | null>;
  /** Process jobs of one kind in this process. */
  work<N extends JobName>(
    name: N,
    handler: JobHandler<N>,
    options?: { concurrency?: number },
  ): Promise<void>;
  /** Look up a job's state, for tests and diagnostics. */
  state(name: JobName, id: string): Promise<string | undefined>;
  /**
   * Stop taking jobs, letting those under way finish, or take them up again (maintenance mode,
   * #154). Queued jobs wait in the queue meanwhile: none is lost or failed.
   */
  hold(held: boolean): Promise<void>;
}

/** A job that failed for the last time: no retry follows. */
export interface JobFailure {
  name: JobName;
  id: string;
  data: unknown;
  error: unknown;
}

// Jobs running in this process now: its worker lanes in use (#156).
let busy = 0;

/**
 * Runs one attempt of a job. When it fails and no retry is left, `onFailure` hears of it before
 * the queue does (#159); the error still reaches the queue, which marks the job failed.
 */
export async function runJob<N extends JobName>(
  name: N,
  job: { id: string; data: unknown; signal: AbortSignal; retryCount: number },
  handler: JobHandler<N>,
  onFailure?: (failure: JobFailure) => Promise<void>,
  /** Whether to log each job's start, end and time (the `worker.verbose` flag). */
  verbose?: () => Promise<boolean>,
): Promise<void> {
  const loud = (await verbose?.().catch(() => false)) ?? false;
  const started = performance.now();
  const took = () => `${Math.round(performance.now() - started)} ms`;
  if (loud) console.log(`Job ${name} ${job.id} started (attempt ${job.retryCount + 1})`);
  metrics.workerLanesBusy.set({}, ++busy);
  try {
    // Validate again on the way out: the queue is a database table, not a trusted channel.
    const data = jobDefinitions[name].data.parse(job.data) as JobData<N>;
    await handler(data, { id: job.id, signal: job.signal, retryCount: job.retryCount });
    if (loud) console.log(`Job ${name} ${job.id} finished in ${took()}`);
    metrics.jobDuration.observe(
      { queue: name, outcome: "completed" },
      (performance.now() - started) / 1000,
    );
  } catch (error) {
    if (loud) console.log(`Job ${name} ${job.id} failed after ${took()}: ${String(error)}`);
    metrics.jobDuration.observe(
      { queue: name, outcome: "failed" },
      (performance.now() - started) / 1000,
    );
    metrics.jobsFailed.inc({ queue: name });
    const options: QueueOptions = jobDefinitions[name].options;
    // pg-boss retries twice when a queue does not say.
    if (onFailure && job.retryCount >= (options.retryLimit ?? 2))
      await onFailure({ name, id: job.id, data: job.data, error }).catch((cause) =>
        console.error("Could not report a failed job:", cause),
      );
    throw error;
  } finally {
    metrics.workerLanesBusy.set({}, --busy);
  }
}

export function createJobs(options: {
  connectionString: string;
  schema?: string;
  /** Hears of each job that failed for the last time. */
  onFailure?: (failure: JobFailure) => Promise<void>;
  /** Whether to log each job's start, end and time, asked as each job starts. */
  verbose?: () => Promise<boolean>;
}): Jobs {
  const boss = new PgBoss({
    connectionString: options.connectionString,
    schema: options.schema ?? "pgboss",
    application_name: "hekate-jobs",
    max: 4,
  });
  boss.on("error", (error) => console.error("Job queue error:", error));
  // Each kind of job this process works, to stop and take up again as maintenance comes and goes.
  const workers = new Map<string, () => Promise<unknown>>();
  // Every kind of job's lanes, whether or not it is held: a held lane is idle, not gone.
  let lanes = 0;
  let held = false;
  // The kinds of job this process is taking now.
  const taking = new Set<string>();
  let holding = Promise.resolve();

  return {
    async start() {
      await boss.start();
      for (const [name, definition] of Object.entries(jobDefinitions)) {
        const existing = await boss.getQueue(name);
        if (existing) await boss.updateQueue(name, definition.options);
        else await boss.createQueue(name, definition.options);
        if ("schedule" in definition) await boss.schedule(name, definition.schedule, {});
      }
    },

    async stop(timeoutMs = 30_000) {
      await boss.stop({ graceful: true, timeout: timeoutMs });
    },

    async send(name, data, sendOptions) {
      const parsed = jobDefinitions[name].data.parse(data);
      return boss.send(name, parsed, {
        ...(sendOptions?.singletonKey ? { singletonKey: sendOptions.singletonKey } : {}),
        ...(sendOptions?.startAfterSeconds ? { startAfter: sendOptions.startAfterSeconds } : {}),
      });
    },

    async work(name, handler, workOptions) {
      const take = () =>
        boss.work(
          name,
          { localConcurrency: workOptions?.concurrency ?? 1, batchSize: 1 },
          async ([job]: Job<unknown>[]) => {
            if (!job) return;
            await runJob(name, job, handler, options.onFailure, options.verbose);
          },
        );
      workers.set(name, take);
      lanes += workOptions?.concurrency ?? 1;
      metrics.workerLanes.set({}, lanes);
      if (!held) {
        await take();
        taking.add(name);
      }
    },

    hold(next) {
      // One after another: turned on and off again quickly, each change finishes first.
      holding = holding
        .catch(() => {})
        .then(async () => {
          // Queue by queue, each only if not already so: one that failed is tried again next
          // time, and the state is the new one only once every queue has followed.
          for (const [name, take] of workers) {
            if (next && taking.has(name)) {
              await boss.offWork(name, { wait: true });
              taking.delete(name);
            } else if (!next && !taking.has(name)) {
              await take();
              taking.add(name);
            }
          }
          held = next;
        });
      return holding;
    },

    async state(name, id) {
      return (await boss.getJobById(name, id))?.state;
    },
  };
}

/**
 * The same jobs, worked only in the lanes a worker takes (#189), each lane as many at once as
 * the plan says, or as the job asks where it does not say.
 */
export function inLanes(jobs: Jobs, plan: LanePlan): Jobs {
  return {
    ...jobs,
    async work(name, handler, options) {
      const concurrency = concurrencyIn(plan, laneOf(name), options?.concurrency ?? 1);
      if (concurrency !== null) await jobs.work(name, handler, { concurrency });
    },
  };
}

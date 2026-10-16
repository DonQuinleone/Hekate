import { type Job, PgBoss, type QueueOptions } from "pg-boss";
import { z } from "zod";

/**
 * Background work, queued in PostgreSQL with pg-boss. Every job has a name, a
 * zod schema for its data and its retry policy here, so senders and workers
 * share one definition. Job data holds identifiers only, never media or secrets;
 * workers load what they need, scoped to the job's organisation.
 */
export const jobDefinitions = {
  /** Measure an uploaded audio or video file with ffprobe. */
  "media-probe": {
    data: z.object({ organisationId: z.uuid(), fileId: z.uuid() }),
    options: { retryLimit: 4, retryDelay: 15, retryBackoff: true, expireInSeconds: 10 * 60 },
  },
  /** Package and encrypt a measured file's HLS renditions for protected streaming. */
  "media-proxy": {
    data: z.object({ organisationId: z.uuid(), fileId: z.uuid() }),
    options: { retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 4 * 60 * 60 },
  },
  /** Analyse a file's audio: waveform peaks, loudness and spectrograms, per channel. */
  "media-analysis": {
    data: z.object({ organisationId: z.uuid(), fileId: z.uuid() }),
    options: { retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 2 * 60 * 60 },
  },
  /** Draw a document or picture as pages for protected viewing (#29). */
  "document-render": {
    data: z.object({ organisationId: z.uuid(), fileId: z.uuid() }),
    options: { retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 60 * 60 },
  },
  /** Work out where the same music sits in two files, usually successive versions (#33). */
  "media-align": {
    data: z.object({ organisationId: z.uuid(), alignmentId: z.uuid() }),
    options: { retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 60 * 60 },
  },
  /** Compute a blob's SHA-256 after an upload, whose chunks arrived in any order. */
  "blob-checksum": {
    data: z.object({ organisationId: z.uuid(), blobId: z.uuid() }),
    options: { retryLimit: 4, retryDelay: 30, retryBackoff: true, expireInSeconds: 60 * 60 },
  },
  /** Abort uploads that were never completed, so their parts stop taking space. Hourly. */
  "uploads-expire": {
    data: z.object({}),
    options: { retryLimit: 2, expireInSeconds: 30 * 60 },
    schedule: "17 * * * *",
  },
  /**
   * Queue alignments still pending a while after their version was made: the queue was
   * down, or the process stopped, between creating the version and queueing its work.
   */
  "alignments-sweep": {
    data: z.object({}),
    options: { retryLimit: 1, expireInSeconds: 10 * 60 },
    schedule: "*/15 * * * *",
  },
  /** Send notifications by mail as they happen. Every minute; each run sends what is waiting. */
  "notifications-mail": {
    data: z.object({}),
    options: { retryLimit: 1, expireInSeconds: 5 * 60 },
    schedule: "* * * * *",
  },
  /** Send each digest that is due: hourly ones every hour, daily ones in the morning. */
  "notifications-digest": {
    data: z.object({}),
    options: { retryLimit: 1, expireInSeconds: 30 * 60 },
    schedule: "3 * * * *",
  },
  /** Remind reviewers the day before a review waiting on them is due. Hourly. */
  "reviews-remind": {
    data: z.object({}),
    options: { retryLimit: 1, expireInSeconds: 30 * 60 },
    schedule: "29 * * * *",
  },
  /** Compare storage with the database: remove what nothing uses, report what is missing. Daily. */
  "storage-reconcile": {
    data: z.object({}),
    options: { retryLimit: 1, expireInSeconds: 2 * 60 * 60 },
    schedule: "41 3 * * *",
  },
} satisfies Record<string, { data: z.ZodType; options: QueueOptions; schedule?: string }>;

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
}

export function createJobs(options: { connectionString: string; schema?: string }): Jobs {
  const boss = new PgBoss({
    connectionString: options.connectionString,
    schema: options.schema ?? "pgboss",
    application_name: "hekate-jobs",
    max: 4,
  });
  boss.on("error", (error) => console.error("Job queue error:", error));

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
      const schema = jobDefinitions[name].data;
      await boss.work(
        name,
        { localConcurrency: workOptions?.concurrency ?? 1, batchSize: 1 },
        async ([job]: Job<unknown>[]) => {
          if (!job) return;
          // Validate again on the way out: the queue is a database table, not a trusted channel.
          const data = schema.parse(job.data) as JobData<typeof name>;
          await handler(data, { id: job.id, signal: job.signal, retryCount: job.retryCount });
        },
      );
    },

    async state(name, id) {
      return (await boss.getJobById(name, id))?.state;
    },
  };
}

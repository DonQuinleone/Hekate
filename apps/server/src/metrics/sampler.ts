import { randomUUID } from "node:crypto";
import { cpus, freemem, totalmem } from "node:os";
import { type Database, schema } from "@hekate/db";
import { lt, sql } from "drizzle-orm";
import { metrics, metricsLastRead, noQueueYet } from "./index.ts";
import type { HistogramTotals } from "./registry.ts";

/**
 * The machine measured a minute at a time (#156), for the System health page: each process
 * writes a row a minute, and rows a day old go. Counts are the registry's own counters, read
 * as the difference between two minutes, so the page shows what Prometheus is told.
 */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * The value below which a share `q` of the observations fall, from a histogram's cumulative
 * buckets: linear within the bucket it lands in, as Prometheus's `histogram_quantile` works it
 * out. Past the last bound it is that bound; with nothing observed there is none.
 */
export function quantileOf(totals: HistogramTotals, q: number): number | null {
  if (totals.count === 0) return null;
  const rank = q * totals.count;
  let below = 0;
  let lower = 0;
  for (const [i, bound] of totals.bounds.entries()) {
    const reached = totals.counts[i] ?? 0;
    if (reached >= rank) {
      const inBucket = reached - below;
      return inBucket === 0 ? bound : lower + ((bound - lower) * (rank - below)) / inBucket;
    }
    below = reached;
    lower = bound;
  }
  return totals.bounds.at(-1) ?? null;
}

/** What the registry and the processors had counted at one moment. */
export interface Reading {
  requests: number;
  errors: number;
  durations: HistogramTotals;
  uploadBytes: number;
  /** Every processor's time, idle and in all, in milliseconds. */
  cpu: { idle: number; total: number };
  cores: number;
}

export function readNow(): Reading {
  const processors = cpus();
  const cpu = { idle: 0, total: 0 };
  for (const { times } of processors) {
    cpu.idle += times.idle;
    cpu.total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return {
    requests: metrics.httpRequests.total(),
    errors: metrics.httpErrors.total(),
    durations: metrics.httpDuration.totals(),
    uploadBytes: metrics.uploadsBytes.total(),
    cpu,
    cores: processors.length,
  };
}

/** What happened between two readings. */
export function between(before: Reading, after: Reading) {
  const rise = (a: number, b: number) => Math.max(0, b - a);
  const durations: HistogramTotals = {
    bounds: after.durations.bounds,
    counts: after.durations.counts.map((n, i) => rise(before.durations.counts[i] ?? 0, n)),
    count: rise(before.durations.count, after.durations.count),
  };
  const total = rise(before.cpu.total, after.cpu.total);
  return {
    requests: rise(before.requests, after.requests),
    errors: rise(before.errors, after.errors),
    p95Seconds: quantileOf(durations, 0.95),
    uploadBytes: rise(before.uploadBytes, after.uploadBytes),
    cpu: total === 0 ? 0 : 1 - rise(before.cpu.idle, after.cpu.idle) / total,
  };
}

/** Jobs waiting in every queue; none before the queue's tables are made. */
async function jobsWaiting(db: Database): Promise<number> {
  const [row] = await db
    .execute<{ n: string }>(
      sql`select count(*)::text as n from pgboss.job where state in ('created', 'retry')`,
    )
    .catch((error: unknown) => {
      if (noQueueYet(error)) return [{ n: "0" }];
      throw error;
    });
  return Number(row?.n ?? 0);
}

export interface Sampler {
  /** This process, as the samples name it: an id picked as it started, never its host. */
  replica: string;
  /** The processors over the last minute measured; null before the first. */
  cpu(): { share: number; cores: number } | null;
  /** Measure the minute just ended, and forget samples a day old. */
  tick(): Promise<void>;
  /** Something else to do each minute, after the sample: counting the services' uptime (#183). */
  also(task: () => Promise<void>): void;
  /** Tick at each minute's turn until stopped. */
  start(): () => void;
}

export function createSampler(db: Database, options: { now?: () => number } = {}): Sampler {
  const now = options.now ?? Date.now;
  const replica = randomUUID();
  let last = readNow();
  let latest: { share: number; cores: number } | null = null;
  const tasks: (() => Promise<void>)[] = [];
  const sampler: Sampler = {
    replica,
    cpu: () => latest,
    also(task) {
      tasks.push(task);
    },
    async tick() {
      const reading = readNow();
      const minute = between(last, reading);
      last = reading;
      latest = { share: minute.cpu, cores: reading.cores };
      // The minute just ended: a timer fires late, never early.
      const at = Math.floor(now() / MINUTE) * MINUTE - MINUTE;
      await db
        .insert(schema.healthSamples)
        .values({
          replica,
          at: new Date(at),
          requests: minute.requests,
          errors: minute.errors,
          p95Seconds: minute.p95Seconds,
          jobsWaiting: await jobsWaiting(db),
          lanes: metrics.workerLanes.total(),
          lanesBusy: metrics.workerLanesBusy.total(),
          uploadBytes: minute.uploadBytes,
          cpu: minute.cpu,
          cores: reading.cores,
          memoryUsed: totalmem() - freemem(),
          memoryTotal: totalmem(),
          metricsReadAt: metricsLastRead(),
        })
        .onConflictDoNothing();
      await db
        .delete(schema.healthSamples)
        .where(lt(schema.healthSamples.at, new Date(now() - DAY)));
      for (const task of tasks)
        await task().catch((error: unknown) => console.warn(`Could not count a minute: ${error}`));
    },
    start() {
      let interval: NodeJS.Timeout | undefined;
      const tick = () =>
        sampler.tick().catch((error: unknown) => console.warn(`Could not measure: ${error}`));
      // At the minute's turn, so each row is one whole minute.
      const first = setTimeout(
        () => {
          last = readNow();
          interval = setInterval(tick, MINUTE);
          interval.unref();
        },
        MINUTE - (now() % MINUTE),
      );
      first.unref();
      return () => {
        clearTimeout(first);
        clearInterval(interval);
      };
    },
  };
  return sampler;
}

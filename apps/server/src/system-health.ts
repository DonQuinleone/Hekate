import { statfs } from "node:fs/promises";
import { freemem, totalmem } from "node:os";
import { type Database, schema } from "@hekate/db";
import {
  type HealthAmount,
  type HealthChecks,
  type HealthMinute,
  type HealthRange,
  type HealthService,
  healthSeries,
  type SystemHealth,
} from "@hekate/shared";
import { countDistinct, gte, max, sql } from "drizzle-orm";
import { metrics, registry } from "./metrics/index.ts";
import type { Sampler } from "./metrics/sampler.ts";
import { toolVersions } from "./system-info.ts";

const HOUR = 60 * 60_000;

export interface SystemHealthDeps {
  checks: () => Promise<HealthChecks>;
  /** This process's sampler, for its processors' last minute; none in tests. */
  sampler?: Sampler;
  /** The disk to measure: local storage's, or the working directory's where there is none. */
  diskPath: string;
  now?: () => Date;
}

/** Used and total bytes of the file system holding a path; null when it cannot be read. */
async function diskOf(path: string): Promise<HealthAmount | null> {
  try {
    const fs = await statfs(path);
    const total = fs.blocks * fs.bsize;
    return { used: total - fs.bavail * fs.bsize, total };
  } catch {
    return null;
  }
}

/** The database's connections, size and release; nulls when it cannot be read. */
async function databaseOf(db: Database) {
  try {
    const [row] = await db.execute<{
      used: string;
      max: string;
      bytes: string;
      version: string;
    }>(
      sql`select (select count(*) from pg_stat_activity)::text as used,
                 current_setting('max_connections') as max,
                 pg_database_size(current_database())::text as bytes,
                 current_setting('server_version') as version`,
    );
    if (!row) return null;
    return {
      connections: { used: Number(row.used), total: Number(row.max) },
      bytes: Number(row.bytes),
      version: row.version.split(" ")[0] ?? row.version,
    };
  } catch {
    return null;
  }
}

/** Every replica's minutes since a moment, added together minute by minute. */
async function minutesSince(db: Database, since: Date): Promise<HealthMinute[]> {
  const s = schema.healthSamples;
  const rows = await db
    .select({
      at: s.at,
      requests: sql<string>`sum(${s.requests})::text`,
      errors: sql<string>`sum(${s.errors})::text`,
      p95Seconds: max(s.p95Seconds),
      jobsWaiting: max(s.jobsWaiting),
      lanes: sql<string>`sum(${s.lanes})::text`,
      lanesBusy: sql<string>`sum(${s.lanesBusy})::text`,
      uploadBytes: sql<string>`sum(${s.uploadBytes})::text`,
    })
    .from(s)
    .where(gte(s.at, since))
    .groupBy(s.at)
    .orderBy(s.at);
  return rows.map((r) => ({
    at: r.at.toISOString(),
    requests: Number(r.requests),
    errors: Number(r.errors),
    p95Seconds: r.p95Seconds,
    jobsWaiting: r.jobsWaiting ?? 0,
    lanes: Number(r.lanes),
    lanesBusy: Number(r.lanesBusy),
    uploadBytes: Number(r.uploadBytes),
  }));
}

/** The System health page (#156): the machine now, a range's minutes, services and metrics. */
export async function systemHealth(
  db: Database,
  range: HealthRange,
  deps: SystemHealthDeps,
): Promise<SystemHealth> {
  const at = deps.now?.() ?? new Date();
  const span = range === "1h" ? HOUR : 24 * HOUR;
  const s = schema.healthSamples;
  const [minutes, database, disk, checks, tools, [replicas]] = await Promise.all([
    minutesSince(db, new Date(at.getTime() - span)),
    databaseOf(db),
    diskOf(deps.diskPath),
    deps.checks(),
    toolVersions(),
    // Replicas that measured a minute lately: those running now.
    db
      .select({ n: countDistinct(s.replica) })
      .from(s)
      .where(gte(s.at, new Date(at.getTime() - 3 * 60_000))),
  ]);
  const lastHour = minutes.filter((m) => new Date(m.at).getTime() >= at.getTime() - HOUR);
  const p95s = lastHour.flatMap((m) => (m.p95Seconds === null ? [] : [m.p95Seconds]));
  const lanes = {
    used: metrics.workerLanesBusy.total(),
    total: metrics.workerLanes.total(),
  };
  const services: HealthService[] = [
    {
      name: "api",
      state: "ok",
      p95Seconds: p95s.length ? Math.max(...p95s) : null,
      replicas: Math.max(1, replicas?.n ?? 0),
    },
    {
      name: "database",
      state: checks.database,
      version: database?.version ?? null,
      bytes: database?.bytes ?? null,
      connections: database?.connections ?? null,
    },
    { name: "worker", state: checks.worker, ffmpeg: tools.ffmpeg, lanes },
    { name: "mail", state: checks.mail },
  ];
  return {
    now: {
      at: at.toISOString(),
      cpu: deps.sampler?.cpu() ?? null,
      memory: { used: totalmem() - freemem(), total: totalmem() },
      disk,
      connections: database?.connections ?? null,
      lanes,
    },
    range,
    series: healthSeries(minutes, range, at),
    services,
    metrics: registry.catalogue(),
  };
}

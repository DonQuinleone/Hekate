import { statfs } from "node:fs/promises";
import { freemem, totalmem } from "node:os";
import { type Database, schema } from "@hekate/db";
import {
  type HealthAmount,
  type HealthBackend,
  type HealthChecks,
  type HealthMinute,
  type HealthRange,
  type HealthService,
  type HealthStorage,
  healthSeries,
  type SystemHealth,
} from "@hekate/shared";
import type { Backends } from "@hekate/storage";
import { and, count, countDistinct, desc, gte, isNotNull, isNull, max, sql } from "drizzle-orm";
import { CHECK_MS, stateOf } from "./health-checks.ts";
import { jobDefinitions } from "./jobs.ts";
import { metrics, registry } from "./metrics/index.ts";
import type { Sampler } from "./metrics/sampler.ts";
import { toolVersions } from "./system-info.ts";

const HOUR = 60 * 60_000;
/** How long a reconciliation job may run before the queue gives up on it. */
const RECONCILE_JOB_MS = jobDefinitions["storage-reconcile"].options.expireInSeconds * 1000;

export interface SystemHealthDeps {
  checks: () => Promise<HealthChecks>;
  /** This process's sampler, for its processors' last minute; none in tests. */
  sampler?: Sampler;
  /** The disk to measure: local storage's, or the working directory's where there is none. */
  diskPath: string;
  backends: Backends;
  /** Each backend's driver and where it keeps its objects, as configured. */
  described: { name: string; driver: "local" | "s3"; where: string }[];
  /** Earlier master keys still configured (MASTER_KEYS_PREVIOUS). */
  previousMasterKeys: number;
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

/**
 * Storage, instance-wide (#156): every backend with what it holds and whether it answers, the
 * master key, and what reconciliation found. Operators only, so it reads across workspaces.
 */
async function storageOf(db: Database, deps: SystemHealthDeps, at: Date): Promise<HealthStorage> {
  const { blobs, organisationKeys, storageFindings, storageReconciliations } = schema;
  const runs = storageReconciliations;
  const instanceWide = isNull(runs.scopeOrganisationId);
  const [stored, [keys], [last], [running], open] = await Promise.all([
    db
      .select({
        backend: blobs.backend,
        bytes: sql<string>`coalesce(sum(${blobs.byteSize}), 0)::text`,
      })
      .from(blobs)
      .groupBy(blobs.backend),
    db.select({ n: count() }).from(organisationKeys),
    // The last run that finished: one that failed is never finished, so it is not shown as one.
    db
      .select()
      .from(runs)
      .where(and(instanceWide, isNotNull(runs.finishedAt)))
      .orderBy(desc(runs.startedAt))
      .limit(1),
    // A run under way: unfinished, and younger than the job's two hours. An older one failed.
    db
      .select({ startedAt: runs.startedAt })
      .from(runs)
      .where(
        and(
          instanceWide,
          isNull(runs.finishedAt),
          gte(runs.startedAt, new Date(at.getTime() - RECONCILE_JOB_MS)),
        ),
      )
      .orderBy(desc(runs.startedAt))
      .limit(1),
    db
      .select({ kind: storageFindings.kind, n: count() })
      .from(storageFindings)
      .where(isNull(storageFindings.resolvedAt))
      .groupBy(storageFindings.kind),
  ]);
  const bytes = new Map(stored.map((r) => [r.backend, Number(r.bytes)]));
  const found = new Map(open.map((r) => [r.kind, r.n]));
  const backends = await Promise.all(
    deps.backends.names().map(async (name): Promise<HealthBackend> => {
      const described = deps.described.find((d) => d.name === name);
      const driver = described?.driver ?? "local";
      const where = described?.where ?? "";
      return {
        name,
        driver,
        where,
        isDefault: name === deps.backends.defaultBackend,
        state: await stateOf(() => deps.backends.get(name).check(), CHECK_MS),
        storedBytes: bytes.get(name) ?? 0,
        disk: driver === "local" && where ? await diskOf(where) : null,
      };
    }),
  );
  return {
    backends,
    masterKey: { workspaceKeys: keys?.n ?? 0, previous: deps.previousMasterKeys },
    reconciliation: {
      last: last?.finishedAt
        ? {
            startedAt: last.startedAt.toISOString(),
            finishedAt: last.finishedAt.toISOString(),
            removing: last.removing,
          }
        : null,
      runningSince: running?.startedAt.toISOString() ?? null,
      open: {
        orphanObjects: found.get("orphan_object") ?? 0,
        unreferencedBlobs: found.get("unreferenced_blob") ?? 0,
        missingObjects: found.get("missing_object") ?? 0,
      },
    },
  };
}

/** The System health page (#156): the machine now, a range's minutes, services and metrics. */
export async function systemHealth(
  db: Database,
  range: HealthRange,
  deps: SystemHealthDeps,
): Promise<SystemHealth> {
  const at = deps.now?.() ?? new Date();
  const span = range === "1h" ? HOUR : 24 * HOUR;
  // From a minute's turn, as the chart's points are: the range's first minute is in it.
  const minute = Math.floor(at.getTime() / 60_000) * 60_000;
  const s = schema.healthSamples;
  const [minutes, database, disk, checks, tools, [replicas], storage] = await Promise.all([
    minutesSince(db, new Date(minute - span)),
    databaseOf(db),
    diskOf(deps.diskPath),
    deps.checks(),
    toolVersions(),
    // Replicas that measured a minute lately: those running now.
    db
      .select({ n: countDistinct(s.replica) })
      .from(s)
      .where(gte(s.at, new Date(at.getTime() - 3 * 60_000))),
    storageOf(db, deps, at),
  ]);
  const lastHour = minutes.filter((m) => new Date(m.at).getTime() >= minute - HOUR);
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
    storage,
    metrics: registry.catalogue(),
  };
}

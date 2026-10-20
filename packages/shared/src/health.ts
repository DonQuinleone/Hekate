import { z } from "zod";

/**
 * Readiness and liveness (#156), for Compose, Kubernetes and the image's HEALTHCHECK. Each
 * check is a state and no more: the endpoints are public, so they name no host, bucket or
 * address.
 */

export type CheckState = "ok" | "failed" | "stale" | "off";

export interface HealthChecks {
  /** PostgreSQL answers. */
  database: CheckState;
  /** Every storage backend can be written to. */
  storage: CheckState;
  /** A worker has finished a job lately; "stale" when none has (none may be running). */
  worker: CheckState;
  /** The SMTP server answers; "off" when mail goes to the log. */
  mail: CheckState;
}

export interface Readiness {
  status: "ready" | "not_ready";
  version: string;
  checks: HealthChecks;
}

/**
 * Ready to serve when the database and storage are: nothing works without them. A worker or
 * mail that is down is reported, but keeps no request from being served, so a load balancer
 * does not take every replica out at once for want of mail.
 */
export function readiness(version: string, checks: HealthChecks): Readiness {
  const serves = checks.database === "ok" && checks.storage === "ok";
  return { status: serves ? "ready" : "not_ready", version, checks };
}

/**
 * The System health page (#156): the machine now, the last hour or day from the minutes each
 * process records, the services, and every metric exported for Prometheus.
 */
export const healthRanges = ["1h", "24h"] as const;
export type HealthRange = (typeof healthRanges)[number];
export const healthQuery = z.object({ range: z.enum(healthRanges).default("24h") });

/** One minute measured, every replica's together. */
export interface HealthMinute {
  at: string;
  requests: number;
  errors: number;
  /** The slowest replica's 95th percentile for the minute; null when nothing was asked. */
  p95Seconds: number | null;
  jobsWaiting: number;
  lanes: number;
  lanesBusy: number;
  uploadBytes: number;
}

/** A chart's points, oldest first; null where nothing was measured (no process running). */
export interface HealthSeries {
  /** Minutes in each point. */
  step: number;
  requestsPerMinute: (number | null)[];
  p95Ms: (number | null)[];
  /** Server errors as a percentage of requests. */
  errorRate: (number | null)[];
  jobsWaiting: (number | null)[];
  lanesBusy: (number | null)[];
  /** The most lanes any point had, the busy chart's ceiling. */
  lanes: number;
  uploadBytesPerHour: (number | null)[];
}

const rangeMinutes: Record<HealthRange, { minutes: number; step: number }> = {
  "1h": { minutes: 60, step: 1 },
  "24h": { minutes: 24 * 60, step: 15 },
};

const MINUTE = 60_000;
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

/**
 * The minutes of a range as chart points: a minute a point for the hour, a quarter of an hour
 * a point for the day. Rates are per minute measured, so a point a process was down for part
 * of reads true; a point with no minute at all is a gap, not a zero.
 */
export function healthSeries(minutes: HealthMinute[], range: HealthRange, now: Date): HealthSeries {
  const { minutes: span, step } = rangeMinutes[range];
  const points = span / step;
  const end = Math.floor(now.getTime() / MINUTE) * MINUTE;
  const start = end - span * MINUTE;
  const bins: HealthMinute[][] = Array.from({ length: points }, () => []);
  for (const m of minutes) {
    const i = Math.floor((new Date(m.at).getTime() - start) / (step * MINUTE));
    if (i >= 0 && i < points) bins[i]?.push(m);
  }
  const each = <T>(read: (bin: HealthMinute[]) => T) =>
    bins.map((bin) => (bin.length === 0 ? null : read(bin)));
  const sum = (bin: HealthMinute[], read: (m: HealthMinute) => number) =>
    bin.reduce((total, m) => total + read(m), 0);
  return {
    step,
    requestsPerMinute: each((bin) => sum(bin, (m) => m.requests) / bin.length),
    p95Ms: bins.map((bin) => {
      const known = bin.flatMap((m) => (m.p95Seconds === null ? [] : [m.p95Seconds]));
      return known.length === 0 ? null : Math.max(...known) * 1000;
    }),
    errorRate: each((bin) => {
      const requests = sum(bin, (m) => m.requests);
      return requests === 0 ? 0 : (sum(bin, (m) => m.errors) / requests) * 100;
    }),
    jobsWaiting: each((bin) => mean(bin.map((m) => m.jobsWaiting))),
    lanesBusy: each((bin) => mean(bin.map((m) => m.lanesBusy))),
    lanes: Math.max(0, ...minutes.map((m) => m.lanes)),
    uploadBytesPerHour: each((bin) => (sum(bin, (m) => m.uploadBytes) / bin.length) * 60),
  };
}

/** A share of a whole, measured now. */
export interface HealthAmount {
  used: number;
  total: number;
}

export interface HealthNow {
  /** When the figures were read. */
  at: string;
  /** The machine's processors over the last minute measured; null before the first. */
  cpu: { share: number; cores: number } | null;
  memory: HealthAmount | null;
  /** The disk holding local storage, or the working directory where there is none. */
  disk: HealthAmount | null;
  connections: HealthAmount | null;
  lanes: HealthAmount;
}

export type HealthService =
  | {
      name: "api";
      state: CheckState;
      /** The worst minute's 95th percentile in the last hour. */
      p95Seconds: number | null;
      replicas: number;
    }
  | {
      name: "database";
      state: CheckState;
      version: string | null;
      bytes: number | null;
      connections: HealthAmount | null;
    }
  | { name: "worker"; state: CheckState; ffmpeg: string | null; lanes: HealthAmount }
  | { name: "mail"; state: CheckState };

export interface MetricEntry {
  name: string;
  type: "counter" | "gauge" | "histogram";
  help: string;
  labels: string[];
}

/** A storage backend as the page shows it: where it is, what it holds, whether it answers. */
export interface HealthBackend {
  name: string;
  driver: "local" | "s3";
  /** Its path, or its bucket (and region). Operators only. */
  where: string;
  /** New objects go here unless a workspace or project chooses another. */
  isDefault: boolean;
  state: CheckState;
  /** Bytes stored there, before encryption. */
  storedBytes: number;
  /** The file system holding a local backend; none for S3, which has no size to fill. */
  disk: HealthAmount | null;
}

export interface HealthStorage {
  backends: HealthBackend[];
  masterKey: {
    /** Workspace keys it wraps. */
    workspaceKeys: number;
    /** Earlier master keys still configured (MASTER_KEYS_PREVIOUS). */
    previous: number;
  };
  reconciliation: {
    /** The last instance-wide run; null before the first. */
    last: { startedAt: string; finishedAt: string | null; removing: boolean } | null;
    /** What runs found and nothing has settled yet. */
    open: { orphanObjects: number; unreferencedBlobs: number; missingObjects: number };
  };
}

export interface SystemHealth {
  now: HealthNow;
  range: HealthRange;
  series: HealthSeries;
  services: HealthService[];
  storage: HealthStorage;
  metrics: MetricEntry[];
}

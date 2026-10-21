import { createHash, timingSafeEqual } from "node:crypto";
import type { Database } from "@hekate/db";
import { sql } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import { version } from "../version.ts";
import { createRegistry, type Registry } from "./registry.ts";

/**
 * What Hekate tells Prometheus (#70), at `/metrics` behind a bearer token (METRICS_TOKEN).
 * One registry per process: each replica is scraped on its own, as Prometheus expects.
 * Workspaces are named by their id, never their name, so a scrape carries no personal data.
 */
export const registry: Registry = createRegistry();

export const metrics = {
  buildInfo: registry.gauge("hekate_build_info", "The running version; always 1.", ["version"]),
  httpRequests: registry.counter(
    "hekate_http_requests_total",
    "API requests answered, by route pattern, method and status.",
    ["route", "method", "status"],
  ),
  httpDuration: registry.histogram(
    "hekate_http_request_duration_seconds",
    "How long API requests took to answer, by route pattern.",
    ["route"],
  ),
  httpErrors: registry.counter(
    "hekate_http_errors_total",
    "API requests that ended in a server error (5xx), by route pattern; each has an error reference in the log.",
    ["route"],
  ),
  jobsWaiting: registry.gauge("hekate_jobs_waiting", "Jobs waiting to run, by queue.", ["queue"]),
  jobsActive: registry.gauge("hekate_jobs_active", "Jobs running now, by queue.", ["queue"]),
  jobsFailed: registry.counter(
    "hekate_jobs_failed_total",
    "Job attempts that failed in this process, by queue; a job retries before it is marked failed.",
    ["queue"],
  ),
  jobDuration: registry.histogram(
    "hekate_job_duration_seconds",
    "How long job attempts took in this process, by queue and outcome.",
    ["queue", "outcome"],
  ),
  workerLanes: registry.gauge(
    "hekate_worker_lanes",
    "Jobs this process may run at once, every queue's together.",
  ),
  workerLanesBusy: registry.gauge("hekate_worker_lanes_busy", "Jobs this process is running now."),
  uploadsBytes: registry.counter(
    "hekate_uploads_bytes_total",
    "Bytes of uploads completed, by workspace.",
    ["workspace"],
  ),
  uploadsRefused: registry.counter(
    "hekate_uploads_refused_total",
    "New versions refused by a project's upload rules, by workspace and rule.",
    ["workspace", "rule"],
  ),
  storageBytes: registry.gauge(
    "hekate_storage_bytes",
    "Bytes stored, by storage backend and workspace.",
    ["backend", "workspace"],
  ),
  mediaKeys: registry.counter(
    "hekate_media_keys_issued_total",
    "Stream keys issued to players, by workspace.",
    ["workspace"],
  ),
  pageRenders: registry.counter(
    "hekate_page_renders_total",
    "Pages and pictures drawn for a viewer, by workspace.",
    ["workspace"],
  ),
  downloads: registry.counter(
    "hekate_downloads_total",
    "Downloads (marked originals and proxies), by workspace.",
    ["workspace"],
  ),
  databaseUp: registry.gauge(
    "hekate_database_up",
    "Whether the database answered a query during the scrape (1) or not (0).",
  ),
  mailSent: registry.counter("hekate_mail_sent_total", "Messages handed to the mail server."),
  mailFailed: registry.counter(
    "hekate_mail_failed_total",
    "Messages the mail server would not take.",
  ),
  signIns: registry.counter("hekate_signins_total", "Sign-ins that succeeded, by method.", [
    "method",
  ]),
  signInsRefused: registry.counter(
    "hekate_signins_refused_total",
    "Sign-ins that were refused, by method.",
    ["method"],
  ),
};
metrics.buildInfo.set({ version }, 1);
// A process that works no queue has no lanes, which a dashboard should read as zero.
metrics.workerLanes.set({}, 0);
metrics.workerLanesBusy.set({}, 0);

/** The access log's actions that are also counted here. */
const counted: Record<string, (workspace: string) => void> = {
  "stream.key": (workspace) => metrics.mediaKeys.inc({ workspace }),
  "page.render": (workspace) => metrics.pageRenders.inc({ workspace }),
  download: (workspace) => metrics.downloads.inc({ workspace }),
  "account.directory_sign_in": () => metrics.signIns.inc({ method: "directory" }),
  "account.sso_sign_in": () => metrics.signIns.inc({ method: "sso" }),
};

/** Count an access-log event, where it is one Prometheus is told about. */
export function countAccess(action: string, organisationId: string) {
  counted[action]?.(organisationId);
}

/**
 * The route pattern a request was answered by (`/api/files/:id`), never its path, so the
 * number of series stays small; "unmatched" for a request no route answered.
 */
export function routeOf(c: Context): string {
  const matched = matchedRoutes(c);
  const wildcard = (path: string) => path.endsWith("*");
  const answered = matched[c.req.routeIndex];
  if (answered && !wildcard(answered.path)) return answered.path;
  // Refused by middleware (no session, say) before its route ran: still that route's request.
  const route = matched.filter((r) => !wildcard(r.path)).at(-1);
  if (route) return route.path;
  // A handler for a whole subtree, such as sign-in's; middleware and the web app's catch-all
  // answer no route of their own.
  if (answered && answered.method !== "ALL" && answered.path !== "*") return answered.path;
  return "unmatched";
}

/** Counts and times every API request. */
export const countRequests: MiddlewareHandler = async (c, next) => {
  const started = performance.now();
  try {
    await next();
  } finally {
    const route = routeOf(c);
    const status = c.res.status;
    metrics.httpRequests.inc({ route, method: c.req.method, status: String(status) });
    metrics.httpDuration.observe({ route }, (performance.now() - started) / 1000);
    if (status >= 500) metrics.httpErrors.inc({ route });
  }
};

/** Gauges read from the database at each scrape. */
export function collectFromDatabase(db: Database) {
  registry.onCollect(async () => {
    try {
      await db.execute(sql`select 1`);
      metrics.databaseUp.set({}, 1);
    } catch {
      metrics.databaseUp.set({}, 0);
      return;
    }
    const stored = await db.execute<{ backend: string; workspace: string; bytes: string }>(
      sql`select backend, organisation_id as workspace, coalesce(sum(byte_size), 0)::text as bytes
          from blobs group by backend, organisation_id`,
    );
    metrics.storageBytes.reset();
    for (const row of stored) {
      metrics.storageBytes.set(
        { backend: row.backend, workspace: row.workspace },
        Number(row.bytes),
      );
    }
  });
}

/** The queue's tables are not made yet; the driver's error is the query error's cause. */
export const noQueueYet = (error: unknown) =>
  /does not exist/.test(String(error instanceof Error ? (error.cause ?? error) : error));

/**
 * Queue depths from pg-boss's own table, read at each scrape. Every queue named is there,
 * at zero when it is idle, so a dashboard reads zero rather than no data.
 */
export function collectQueues(db: Database, queues: readonly string[]) {
  registry.onCollect(async () => {
    metrics.jobsWaiting.reset();
    metrics.jobsActive.reset();
    for (const queue of queues) {
      metrics.jobsWaiting.set({ queue }, 0);
      metrics.jobsActive.set({ queue }, 0);
    }
    const rows = await db
      .execute<{ queue: string; state: string; n: string }>(
        sql`select name as queue, state::text as state, count(*)::text as n from pgboss.job
            where state in ('created', 'retry', 'active') group by name, state`,
      )
      .catch((error: unknown) => {
        // Before the queue's tables are made there is nothing waiting.
        if (noQueueYet(error)) return [];
        throw error;
      });
    const waiting = new Map<string, number>();
    for (const row of rows) {
      if (row.state === "active") metrics.jobsActive.set({ queue: row.queue }, Number(row.n));
      else waiting.set(row.queue, (waiting.get(row.queue) ?? 0) + Number(row.n));
    }
    for (const [queue, n] of waiting) metrics.jobsWaiting.set({ queue }, n);
  });
}

/** A mailer that counts what it sends, and what the mail server would not take. */
export function countedMailer<M extends { send(message: never): Promise<void> }>(mailer: M): M {
  return {
    ...mailer,
    async send(message: never) {
      try {
        await mailer.send(message);
        metrics.mailSent.inc();
      } catch (error) {
        metrics.mailFailed.inc();
        throw error;
      }
    },
  };
}

/** Equal tokens, compared in constant time. */
export function sameToken(given: string, expected: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

// When a scraper last read this process's metrics (#165).
let lastRead: Date | null = null;
export const metricsLastRead = () => lastRead;

/**
 * `GET /metrics`: everything above in the text format, for a scraper that sends the token as
 * a bearer. Without a token configured there is nothing here at all.
 */
export function metricsHandler(token: string | undefined): MiddlewareHandler {
  return async (c) => {
    if (!token) return c.json({ error: { code: "not_found", message: "Not found" } }, 404);
    const header = c.req.header("authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (!given || !sameToken(given, token)) {
      c.header("WWW-Authenticate", 'Bearer realm="metrics"');
      return c.json({ error: { code: "unauthorised", message: "A metrics token is needed" } }, 401);
    }
    const body = await registry.render();
    // Only once the scrape is answered: a read that failed is not one.
    lastRead = new Date();
    return c.body(body, 200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    });
  };
}

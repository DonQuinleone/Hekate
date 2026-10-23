import { type Database, schema } from "@hekate/db";
import {
  type CheckState,
  type HealthChecks,
  type Incident,
  type IncidentSpan,
  type ServiceDayRecord,
  type StatusNow,
  type StatusPage,
  type StatusService,
  serviceDays,
  serviceStateNow,
  statusServices,
  UPTIME_DAYS,
  worstState,
} from "@hekate/shared";
import { desc, eq, gte, inArray, isNull, lt, max, or, sql } from "drizzle-orm";

const { incidents, incidentUpdates, users } = schema;

const MINUTE = 60_000;
const DAY = 86_400_000;
/** How long the measured days are kept: the page's 90, and a little over. */
const KEEP_DAYS = UPTIME_DAYS + 10;
/** How long a page read is kept in memory: the page is public, and asked often while down. */
const CACHE_MS = 15_000;

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A service's state as System health checks it; the API is up whenever anything answers. */
export function checkOf(checks: HealthChecks, service: StatusService): CheckState {
  return service === "api" ? "ok" : checks[service];
}

/** The services the page lists: those the instance has (no mail when it goes to the log). */
export const listedServices = (checks: HealthChecks): StatusService[] =>
  statusServices.filter((s) => checkOf(checks, s) !== "off");

type IncidentRecord = typeof incidents.$inferSelect;

/**
 * Counts one minute of each service (#183): every replica checks each minute, and the first
 * to record a minute counts it, so a minute counts once however many run. A minute the
 * database cannot be written in is not counted: an outage that stops the instance measuring
 * is posted as an incident.
 */
export async function recordServiceMinute(db: Database, checks: HealthChecks, at: Date) {
  const minute = new Date(Math.floor(at.getTime() / MINUTE) * MINUTE);
  const day = dayOf(minute.getTime());
  const rows = listedServices(checks).map((service) => ({
    day,
    service,
    minutes: 1,
    down: checkOf(checks, service) === "ok" ? 0 : 1,
    lastMinute: minute,
  }));
  if (rows.length === 0) return;
  const t = schema.serviceDays;
  const later = sql`excluded.last_minute > ${t.lastMinute}`;
  await db
    .insert(t)
    .values(rows)
    .onConflictDoUpdate({
      target: [t.day, t.service],
      set: {
        minutes: sql`${t.minutes} + case when ${later} then 1 else 0 end`,
        down: sql`${t.down} + case when ${later} then excluded.down else 0 end`,
        lastMinute: sql`greatest(${t.lastMinute}, excluded.last_minute)`,
      },
    });
  await db.delete(t).where(lt(t.day, dayOf(minute.getTime() - KEEP_DAYS * DAY)));
}

/** Incidents with their updates, newest update first; the authors' names only when asked. */
export async function withUpdates(
  db: Database,
  rows: IncidentRecord[],
  names = false,
): Promise<Incident[]> {
  if (rows.length === 0) return [];
  const updates = await db
    .select({
      id: incidentUpdates.id,
      incidentId: incidentUpdates.incidentId,
      state: incidentUpdates.state,
      body: incidentUpdates.body,
      createdAt: incidentUpdates.createdAt,
      author: users.name,
    })
    .from(incidentUpdates)
    .leftJoin(users, eq(users.id, incidentUpdates.createdBy))
    .where(
      inArray(
        incidentUpdates.incidentId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(desc(incidentUpdates.createdAt), desc(incidentUpdates.id));
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    impact: r.impact,
    services: r.services,
    state: r.state,
    startedAt: r.startedAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    updatedAt: r.updatedAt.toISOString(),
    updates: updates
      .filter((u) => u.incidentId === r.id)
      .map((u) => ({
        id: u.id,
        state: u.state,
        body: u.body,
        createdAt: u.createdAt.toISOString(),
        ...(names ? { author: u.author ?? null } : {}),
      })),
  }));
}

const spanOf = (i: Incident): IncidentSpan => ({
  title: i.title,
  impact: i.impact,
  services: i.services,
  startedAt: i.startedAt,
  resolvedAt: i.resolvedAt,
});

/** Incidents open now, or resolved since a moment, newest first. */
async function incidentsSince(db: Database, since: Date) {
  return db
    .select()
    .from(incidents)
    .where(or(isNull(incidents.resolvedAt), gte(incidents.resolvedAt, since)))
    .orderBy(desc(incidents.startedAt), desc(incidents.id));
}

/** What the page reads: the services now and over 90 days, and the incidents. */
export async function readStatusPage(
  db: Database,
  checks: HealthChecks,
  now: Date,
): Promise<StatusPage> {
  const today = Math.floor(now.getTime() / DAY) * DAY;
  const from = today - (UPTIME_DAYS - 1) * DAY;
  const [records, rows] = await Promise.all([
    db
      .select()
      .from(schema.serviceDays)
      .where(gte(schema.serviceDays.day, dayOf(from))),
    incidentsSince(db, new Date(from)),
  ]);
  const all = await withUpdates(db, rows);
  const open = all.filter((i) => !i.resolvedAt);
  const measured: ServiceDayRecord[] = records.map((r) => ({
    day: r.day,
    service: r.service,
    minutes: r.minutes,
    down: r.down,
  }));
  const spans = all.map(spanOf);
  const services = listedServices(checks).map((name) => ({
    name,
    state: serviceStateNow(name, checkOf(checks, name), open),
    ...serviceDays(name, measured, spans, now),
  }));
  return {
    at: now.toISOString(),
    complete: true,
    state: worstState(services.map((s) => s.state)),
    services,
    open,
    past: all.filter((i) => i.resolvedAt),
  };
}

/**
 * The page when the database cannot be read: what was just checked, and no history, so the
 * page still says something is down when it matters most.
 */
export function measuredOnly(checks: HealthChecks, now: Date): StatusPage {
  const services = listedServices(checks).map((name) => ({
    name,
    state: serviceStateNow(name, checkOf(checks, name), []),
    ...serviceDays(name, [], [], now),
  }));
  return {
    at: now.toISOString(),
    complete: false,
    state: worstState(services.map((s) => s.state)),
    services,
    open: [],
    past: [],
  };
}

/** What the help menu, the Support page and the desk's tile show. */
export async function readStatusNow(db: Database, checks: HealthChecks): Promise<StatusNow> {
  const [rows, [last]] = await Promise.all([
    db
      .select()
      .from(incidents)
      .where(isNull(incidents.resolvedAt))
      .orderBy(desc(incidents.startedAt), desc(incidents.id)),
    db.select({ at: max(incidents.startedAt) }).from(incidents),
  ]);
  const services = listedServices(checks);
  return {
    state: worstState(services.map((s) => serviceStateNow(s, checkOf(checks, s), rows))),
    open: rows.map((r) => ({
      id: r.id,
      title: r.title,
      impact: r.impact,
      state: r.state,
      services: r.services,
      updatedAt: r.updatedAt.toISOString(),
    })),
    lastIncidentAt: last?.at ? new Date(last.at).toISOString() : null,
  };
}

/** The status page as the server keeps it: read through a short cache, forgotten on a change. */
export interface Status {
  page(): Promise<StatusPage>;
  now(): Promise<StatusNow>;
  /** Count this minute of each service. */
  record(): Promise<void>;
  /** Read afresh next time: an incident changed here. Other replicas follow within the cache. */
  forget(): void;
}

export function createStatus(
  db: Database,
  checks: () => Promise<HealthChecks>,
  clock: () => Date = () => new Date(),
): Status {
  let page: { at: number; value: Promise<StatusPage> } | null = null;
  let summary: { at: number; value: Promise<StatusNow> } | null = null;
  const fresh = (kept: { at: number } | null) =>
    kept !== null && clock().getTime() - kept.at < CACHE_MS;
  return {
    page() {
      if (!page || !fresh(page)) {
        const value = checks().then((c) =>
          readStatusPage(db, c, clock()).catch(() => measuredOnly(c, clock())),
        );
        page = { at: clock().getTime(), value };
        // A failed read is not kept.
        value.catch(() => {
          if (page?.value === value) page = null;
        });
      }
      return page.value;
    },
    now() {
      if (!summary || !fresh(summary)) {
        const value = checks().then((c) => readStatusNow(db, c));
        summary = { at: clock().getTime(), value };
        value.catch(() => {
          if (summary?.value === value) summary = null;
        });
      }
      return summary.value;
    },
    async record() {
      await recordServiceMinute(db, await checks(), clock());
    },
    forget() {
      page = null;
      summary = null;
    },
  };
}

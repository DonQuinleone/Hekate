import { z } from "zod";
import type { CheckState } from "./health.ts";

/**
 * The status page (#183): the instance's services as System health checks them (#156), their
 * uptime over 90 days, and the incidents its operators post from the support desk, each with
 * updates through to its resolution. Served by the instance at `/status`, readable signed out.
 */

/** The services the page lists: those System health checks, in words anyone can read. */
export const statusServices = ["api", "database", "storage", "worker", "mail"] as const;
export type StatusService = (typeof statusServices)[number];

export const statusServiceNames: Record<StatusService, string> = {
  api: "App and API",
  database: "Database",
  storage: "Storage",
  worker: "Processing",
  mail: "Mail",
};

export const statusServiceHints: Record<StatusService, string> = {
  api: "Signing in, every page and the API",
  database: "Projects, comments, reviews and everything but the files",
  storage: "Uploads, playback and downloads",
  worker: "Measuring uploads, renditions, waveforms and checks",
  mail: "Invitations, notifications and review requests",
};

/** How badly an incident touches what it names, least first. */
export const incidentImpacts = ["degraded", "partial", "major"] as const;
export type IncidentImpact = (typeof incidentImpacts)[number];

export const incidentImpactNames: Record<IncidentImpact, string> = {
  degraded: "Degraded performance",
  partial: "Partial outage",
  major: "Major outage",
};

/** Where an incident stands, in the words status pages use. */
export const incidentStates = ["investigating", "identified", "monitoring", "resolved"] as const;
export type IncidentState = (typeof incidentStates)[number];

export const incidentStateNames: Record<IncidentState, string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
};

/** A service now, or a day of it: running, or as badly touched as its worst incident. */
export type ServiceState = "operational" | IncidentImpact;
const order: ServiceState[] = ["operational", ...incidentImpacts];

export const serviceStateNames: Record<ServiceState, string> = {
  operational: "Operational",
  ...incidentImpactNames,
};

/** The worse of some states; operational for none. */
export const worstState = (states: ServiceState[]): ServiceState =>
  states.reduce<ServiceState>(
    (worst, s) => (order.indexOf(s) > order.indexOf(worst) ? s : worst),
    "operational",
  );

/** What the page says at its top, from the worst service. */
export const overallLine: Record<ServiceState, string> = {
  operational: "Every service is running",
  degraded: "Some services are slow",
  partial: "Some services are failing",
  major: "Services are down",
};

/** A check as the page reads it: failing is down; a worker that finished nothing is slow. */
export function checkedState(check: CheckState): ServiceState {
  if (check === "failed") return "major";
  if (check === "stale") return "degraded";
  return "operational";
}

/** An incident as the uptime and the day bars need it. */
export interface IncidentSpan {
  title: string;
  impact: IncidentImpact;
  services: StatusService[];
  startedAt: string;
  resolvedAt: string | null;
}

/** A service now: the worse of what was measured and what its open incidents say. */
export function serviceStateNow(
  service: StatusService,
  check: CheckState,
  open: Pick<IncidentSpan, "impact" | "services">[],
): ServiceState {
  return worstState([
    checkedState(check),
    ...open.filter((i) => i.services.includes(service)).map((i) => i.impact),
  ]);
}

/** A service's day as measured: minutes checked, and those it was not answering. */
export interface ServiceDayRecord {
  /** `YYYY-MM-DD`, in UTC. */
  day: string;
  service: StatusService;
  minutes: number;
  down: number;
}

/** One of the 90 bars. */
export interface StatusDay {
  day: string;
  /** None before the instance measured anything, and for days still to come. */
  state: ServiceState | "none";
  /** Minutes counted as down: measured, or under an outage posted for it. */
  downMinutes: number;
  /** The incidents that touched it, by title. */
  incidents: string[];
}

export const UPTIME_DAYS = 90;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/**
 * How much of an incident's time counts as down: all of a major outage, under a third of a
 * partial one (some things fail, most work), none of slowness.
 */
export const impactWeight: Record<IncidentImpact, number> = {
  degraded: 0,
  partial: 0.3,
  major: 1,
};

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export type WeightedSpan = { from: number; to: number; weight: number };

/**
 * How much of the timeline some span covers, each stretch counted once at the greatest weight
 * of the spans over it: two incidents over the same hour are one hour down, not two.
 */
export function weightedCover(spans: WeightedSpan[]): number {
  const edges = [...new Set(spans.flatMap((s) => [s.from, s.to]))].sort((a, b) => a - b);
  let covered = 0;
  for (let k = 0; k < edges.length - 1; k++) {
    const from = edges[k] as number;
    const to = edges[k + 1] as number;
    let weight = 0;
    for (const s of spans) if (s.from <= from && s.to >= to) weight = Math.max(weight, s.weight);
    covered += (to - from) * weight;
  }
  return covered;
}

/**
 * A service's 90 days and its uptime over them. Each day's down minutes are the more of those
 * measured failing and those an incident naming it says were down (weighted by its impact),
 * so an outage of the whole instance, which nothing inside it could measure, counts once an
 * operator posts it. Unmeasured time outside any incident counts as up, as on any status page;
 * days before the first measure are left out of the uptime and drawn as none.
 */
export function serviceDays(
  service: StatusService,
  records: ServiceDayRecord[],
  incidents: IncidentSpan[],
  now: Date,
  days = UPTIME_DAYS,
): { uptime: number | null; days: StatusDay[] } {
  const nowMs = now.getTime();
  const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const mine = incidents.filter((i) => i.services.includes(service));
  const measured = new Map(records.filter((r) => r.service === service).map((r) => [r.day, r]));
  const firsts = [
    ...[...measured.values()].filter((r) => r.minutes > 0).map((r) => Date.parse(r.day)),
    ...mine.map((i) => Math.floor(Date.parse(i.startedAt) / DAY_MS) * DAY_MS),
  ];
  const first = firsts.length ? Math.min(...firsts) : null;
  let total = 0;
  let down = 0;
  const bars: StatusDay[] = [];
  for (let n = days - 1; n >= 0; n--) {
    const start = today - n * DAY_MS;
    const day = dayOf(start);
    if (first === null || start < first) {
      bars.push({ day, state: "none", downMinutes: 0, incidents: [] });
      continue;
    }
    const end = Math.min(start + DAY_MS, nowMs);
    const length = Math.max(0, (end - start) / MINUTE_MS);
    const record = measured.get(day);
    const measuredDown = record?.down ?? 0;
    const touching: IncidentSpan[] = [];
    const spans: WeightedSpan[] = [];
    for (const i of mine) {
      const began = Date.parse(i.startedAt);
      const ended = i.resolvedAt ? Date.parse(i.resolvedAt) : nowMs;
      if (began >= end || ended <= start) continue;
      touching.push(i);
      spans.push({
        from: Math.max(start, began),
        to: Math.min(end, ended),
        weight: impactWeight[i.impact],
      });
    }
    const posted = weightedCover(spans) / MINUTE_MS;
    const lost = Math.min(length, Math.max(measuredDown, posted));
    total += length;
    down += lost;
    const fromMeasure: ServiceState =
      measuredDown >= 60 ? "major" : measuredDown > 0 ? "partial" : "operational";
    bars.push({
      day,
      state: worstState([fromMeasure, ...touching.map((i) => i.impact)]),
      downMinutes: Math.round(lost),
      incidents: touching.map((i) => i.title),
    });
  }
  return { uptime: total > 0 ? Math.max(0, 1 - down / total) : null, days: bars };
}

/** An uptime as the page prints it: never 100% with any minute down, never rounded up to it. */
export function formatUptime(uptime: number | null): string {
  if (uptime === null) return "No data yet";
  if (uptime >= 1) return "100%";
  const floored = Math.floor(uptime * 10_000) / 100;
  return `${Math.min(99.99, floored).toFixed(2)}%`;
}

/** Whole days since a moment, for "no incidents in 41 days". */
export const daysSince = (at: string, now: Date) =>
  Math.max(0, Math.floor((now.getTime() - Date.parse(at)) / DAY_MS));

const body = z
  .string()
  .trim()
  .min(1, "Say what is happening")
  .max(5000, "An update can be at most 5,000 characters");

const services = z
  .array(z.enum(statusServices))
  .min(1, "Choose what it touches")
  .max(statusServices.length)
  .transform((list) => statusServices.filter((s) => list.includes(s)));

/** Not yet: an incident is posted as it happens, or after the fact, never ahead of it. */
const moment = z.iso.datetime({ offset: true });

/**
 * A new incident: what is wrong, what it touches and how badly, and the first update. One
 * posted after the fact says when it began, and when it ended if it is already resolved.
 */
export const incidentInput = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, "Say what is wrong, in a line")
      .max(140, "A title can be at most 140 characters"),
    impact: z.enum(incidentImpacts),
    services,
    state: z.enum(incidentStates).default("investigating"),
    body,
    startedAt: moment.optional(),
    resolvedAt: moment.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.resolvedAt && value.state !== "resolved")
      ctx.addIssue({
        code: "custom",
        path: ["resolvedAt"],
        message: "Only a resolved incident has an end",
      });
    if (
      value.startedAt &&
      value.resolvedAt &&
      Date.parse(value.resolvedAt) < Date.parse(value.startedAt)
    )
      ctx.addIssue({
        code: "custom",
        path: ["resolvedAt"],
        message: "It cannot end before it began",
      });
  });
export type IncidentInput = z.input<typeof incidentInput>;

/** An update: where it stands now and what is known, with what it touches if that changed. */
export const incidentUpdateInput = z.object({
  state: z.enum(incidentStates),
  body,
  impact: z.enum(incidentImpacts).optional(),
  services: services.optional(),
});
export type IncidentUpdateInput = z.input<typeof incidentUpdateInput>;

/** How far back an incident may be posted: the page shows no further. */
export const INCIDENT_BACKDATE_DAYS = UPTIME_DAYS;

/** Why a moment cannot be an incident's start or end, or null when it can. */
export function incidentMomentProblem(at: string, now: Date): string | null {
  const ms = Date.parse(at);
  if (ms > now.getTime() + MINUTE_MS) return "It cannot be in the future";
  if (ms < now.getTime() - INCIDENT_BACKDATE_DAYS * DAY_MS)
    return `It can be at most ${INCIDENT_BACKDATE_DAYS} days ago`;
  return null;
}

export interface IncidentUpdate {
  id: string;
  state: IncidentState;
  body: string;
  createdAt: string;
  /** The operator who wrote it: on the desk only, never on the public page. */
  author?: string | null;
}

export interface Incident {
  id: string;
  title: string;
  impact: IncidentImpact;
  services: StatusService[];
  state: IncidentState;
  startedAt: string;
  resolvedAt: string | null;
  updatedAt: string;
  /** Newest first. */
  updates: IncidentUpdate[];
}

export interface StatusServiceRow {
  name: StatusService;
  state: ServiceState;
  uptime: number | null;
  days: StatusDay[];
}

/** The status page: the services now and over 90 days, and the incidents. */
export interface StatusPage {
  at: string;
  /** False when the database could not be read: only the checks just made are shown. */
  complete: boolean;
  state: ServiceState;
  services: StatusServiceRow[];
  /** Incidents not yet resolved, newest first. */
  open: Incident[];
  /** Resolved within the 90 days, newest first. */
  past: Incident[];
}

/** What the help menu, the Support page and the desk's tile show: the state and what is open. */
export interface StatusNow {
  state: ServiceState;
  open: Pick<Incident, "id" | "title" | "impact" | "state" | "services" | "updatedAt">[];
  /** When the last incident began, for "no incidents in 41 days"; null when there was none. */
  lastIncidentAt: string | null;
}

/**
 * The status page (#183): the services System health checks, their 90 days, and the incidents
 * the operators post from the support desk. Days run from 90 days before the prototype's clock
 * to its day, 14 October 2026.
 */

export type ServiceState = "operational" | "degraded" | "partial" | "major";
export type DayState = ServiceState | "none";
export type IncidentState = "investigating" | "identified" | "monitoring" | "resolved";

export const impactNames: Record<Exclude<ServiceState, "operational">, string> = {
  degraded: "Degraded performance",
  partial: "Partial outage",
  major: "Major outage",
};

export const serviceStateNames: Record<ServiceState, string> = {
  operational: "Operational",
  ...impactNames,
};

export const incidentStateNames: Record<IncidentState, string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
};

export const overallLine: Record<ServiceState, string> = {
  operational: "Every service is running",
  degraded: "Some services are slow",
  partial: "Some services are failing",
  major: "Services are down",
};

export interface IncidentUpdate {
  state: IncidentState;
  at: string;
  text: string;
  /** The operator who wrote it: on the desk only, never on the public page. */
  by: string;
}

export interface StatusIncident {
  id: string;
  title: string;
  impact: Exclude<ServiceState, "operational">;
  services: string[];
  state: IncidentState;
  started: string;
  resolved?: string;
  /** Newest first. */
  updates: IncidentUpdate[];
}

export interface StatusService {
  id: string;
  name: string;
  hint: string;
  uptime: string;
  /** 90 days, oldest first. */
  days: { day: string; state: DayState; note: string }[];
}

/** Ninety days to the prototype's day, with what happened on some of them. */
function daysWith(marks: Record<number, [DayState, string]>, from = 0) {
  const end = Date.UTC(2026, 9, 14);
  return Array.from({ length: 90 }, (_, i) => {
    const at = new Date(end - (89 - i) * 86_400_000);
    const day = at.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    const [state, note] =
      i < from ? (["none", "not measured"] as const) : (marks[i] ?? ["operational", "no downtime"]);
    return { day, state, note: `${day} · ${note}` };
  });
}

export const statusServices: StatusService[] = [
  {
    id: "api",
    name: "App and API",
    hint: "Signing in, every page and the API",
    uptime: "99.98%",
    days: daysWith({ 31: ["partial", "18 min down · Signing in fails for some"] }),
  },
  {
    id: "database",
    name: "Database",
    hint: "Projects, comments, reviews and everything but the files",
    uptime: "100%",
    days: daysWith({}),
  },
  {
    id: "storage",
    name: "Storage",
    hint: "Uploads, playback and downloads",
    uptime: "99.95%",
    days: daysWith({ 48: ["partial", "30 min down · Uploads stop at 99%"] }),
  },
  {
    id: "worker",
    name: "Processing",
    hint: "Measuring uploads, renditions, waveforms and checks",
    uptime: "99.95%",
    days: daysWith({ 48: ["partial", "30 min down · Uploads stop at 99%"] }),
  },
  {
    id: "mail",
    name: "Mail",
    hint: "Invitations, notifications and review requests",
    uptime: "100%",
    days: daysWith({ 4: ["degraded", "no downtime · Mail is delayed"] }),
  },
];

/** A fresh instance: nothing measured before today. */
export const freshServices: StatusService[] = statusServices.map((s) => ({
  ...s,
  uptime: "100%",
  days: daysWith({}, 89),
}));

export const statusServiceName = (id: string) =>
  statusServices.find((s) => s.id === id)?.name ?? id;

/** The incident open while the switcher shows a failed state. */
export const openIncident: StatusIncident = {
  id: "inc-4",
  title: "Playback is slow to start",
  impact: "degraded",
  services: ["storage"],
  state: "identified",
  started: "14 Oct, 20:12",
  updates: [
    {
      state: "identified",
      at: "14 Oct, 20:41",
      text: "The storage provider is answering slowly in one region. Files play once started; we are moving reads to the other region.",
      by: "Alex Rivera",
    },
    {
      state: "investigating",
      at: "14 Oct, 20:12",
      text: "Some files take up to half a minute to start playing. Uploads and comments are not affected.",
      by: "Alex Rivera",
    },
  ],
};

export const pastIncidents: StatusIncident[] = [
  {
    id: "inc-3",
    title: "Uploads stop at 99%",
    impact: "partial",
    services: ["storage", "worker"],
    state: "resolved",
    started: "3 Sept, 14:02",
    resolved: "3 Sept, 14:32",
    updates: [
      {
        state: "resolved",
        at: "3 Sept, 14:32",
        text: "Every upload since 14:02 is in and measured. A full disk on the worker held them back; it has more room now.",
        by: "Tomas Varga",
      },
      {
        state: "investigating",
        at: "3 Sept, 14:09",
        text: "Uploads reach 99% and stop. Nothing sent is lost; they finish once this is fixed.",
        by: "Tomas Varga",
      },
    ],
  },
  {
    id: "inc-2",
    title: "Signing in fails for some",
    impact: "partial",
    services: ["api"],
    state: "resolved",
    started: "17 Aug, 09:20",
    resolved: "17 Aug, 09:38",
    updates: [
      {
        state: "resolved",
        at: "17 Aug, 09:38",
        text: "Single sign-on works again: the directory's certificate had been renewed without telling us.",
        by: "Alex Rivera",
      },
    ],
  },
  {
    id: "inc-1",
    title: "Mail is delayed",
    impact: "degraded",
    services: ["mail"],
    state: "resolved",
    started: "21 Jul, 11:00",
    resolved: "21 Jul, 13:15",
    updates: [
      {
        state: "resolved",
        at: "21 Jul, 13:15",
        text: "The mail provider has caught up; every notification held back has gone out.",
        by: "Alex Rivera",
      },
    ],
  },
];

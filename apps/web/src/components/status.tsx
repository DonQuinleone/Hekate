import {
  daysSince,
  formatUptime,
  type Incident,
  incidentImpactNames,
  incidentStateNames,
  overallLine,
  type ServiceState,
  type StatusDay,
  type StatusNow,
  type StatusServiceRow,
  serviceStateNames,
  statusServiceHints,
  statusServiceNames,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Row } from "~/components/settings";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/cn";
import { ago } from "~/lib/comments";
import { formatDates } from "~/lib/locale";
import { statusNowQuery } from "~/lib/status";

/**
 * The status page's parts (#183), shared by the page itself and the operators' desk. States
 * are told apart by fill, from quiet ink to the signal at full strength, never by a traffic
 * light: running is ink, slowness a ring of signal, a partial outage half signal, an outage
 * the signal itself.
 */

const dayFormat = formatDates({ day: "numeric", month: "short", year: "numeric" });
const timeFormat = formatDates({
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** A service's state as a dot. */
export function StateDot({ state, className }: { state: ServiceState; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-[9px] shrink-0 rounded-full",
        state === "operational" && "bg-ink",
        state === "degraded" && "border-[1.5px] border-signal",
        state === "partial" && "bg-signal/55",
        state === "major" && "bg-signal",
        className,
      )}
    />
  );
}

const barClass: Record<StatusDay["state"], string> = {
  none: "bg-hairline",
  operational: "bg-ink-3/45",
  degraded: "bg-signal/35",
  partial: "bg-signal/65",
  major: "bg-signal",
};

/** What a day's bar says when pointed at. */
export function dayLine(d: StatusDay): string {
  const day = dayFormat.format(new Date(`${d.day}T12:00:00Z`));
  if (d.state === "none") return `${day}: not measured`;
  const down =
    d.downMinutes === 0
      ? "no downtime"
      : d.downMinutes < 60
        ? `${d.downMinutes} min down`
        : `${Math.round((d.downMinutes / 60) * 10) / 10} h down`;
  return [day, down, ...d.incidents].join(" · ");
}

/** A service: its name, its state now, and its 90 days as bars over its uptime. */
export function ServiceUptime({ service }: { service: StatusServiceRow }) {
  return (
    <div className="flex flex-col gap-2.5 px-4 py-row-loose">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[14px] text-ink">{statusServiceNames[service.name]}</div>
          <div className="mt-0.5 text-[13px] text-ink-3">{statusServiceHints[service.name]}</div>
        </div>
        <span className="flex shrink-0 items-center gap-2 text-[13px] text-ink-2">
          <StateDot state={service.state} />
          {serviceStateNames[service.state]}
        </span>
      </div>
      <div
        role="img"
        aria-label={`${statusServiceNames[service.name]}: ${formatUptime(service.uptime)} uptime over 90 days`}
        className="flex h-7 items-stretch gap-px"
      >
        {service.days.map((d) => (
          <span
            key={d.day}
            title={dayLine(d)}
            className={cn("min-w-0 flex-1 rounded-[1px]", barClass[d.state])}
          />
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 text-[12px] text-ink-3">
        <span>90 days ago</span>
        <span className="tabular text-ink-2">{formatUptime(service.uptime)} uptime</span>
        <span>Today</span>
      </div>
    </div>
  );
}

/** The bars' key, under the services. */
export function UptimeKey() {
  const items: [StatusDay["state"], string][] = [
    ["operational", "Running"],
    ["degraded", "Slow"],
    ["partial", "Partial outage"],
    ["major", "Outage"],
    ["none", "Not measured"],
  ];
  return (
    <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[12px] text-ink-3">
      {items.map(([state, label]) => (
        <li key={state} className="flex items-center gap-1.5">
          <span aria-hidden="true" className={cn("h-3 w-1.5 rounded-[1px]", barClass[state])} />
          {label}
        </li>
      ))}
    </ul>
  );
}

/** What a quiet status says: how long since the last incident, or what was measured. */
export function calmLine(now: Pick<StatusNow, "state" | "lastIncidentAt">): string {
  if (now.state !== "operational") return overallLine[now.state];
  if (!now.lastIncidentAt) return "No incidents posted";
  const days = daysSince(now.lastIncidentAt, new Date());
  if (days === 0) return "An incident earlier today, now resolved";
  if (days === 1) return "No incidents since yesterday";
  return `No incidents in ${days} days`;
}

/** How long an incident lasted, or has lasted so far. */
export function lasted(i: Pick<Incident, "startedAt" | "resolvedAt">, now = Date.now()): string {
  const minutes = Math.max(
    1,
    Math.round(
      ((i.resolvedAt ? Date.parse(i.resolvedAt) : now) - Date.parse(i.startedAt)) / 60_000,
    ),
  );
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${Math.round(hours * 10) / 10} h`;
  return `${Math.round(hours / 24)} days`;
}

/** What an incident touches and how badly, in a line. */
export function incidentLine(i: Pick<Incident, "impact" | "services">): string {
  return `${incidentImpactNames[i.impact]} · ${i.services.map((s) => statusServiceNames[s]).join(", ")}`;
}

/** When an incident began and ended, in a line. */
export function incidentSpan(i: Pick<Incident, "startedAt" | "resolvedAt">): string {
  const began = timeFormat.format(new Date(i.startedAt));
  return i.resolvedAt
    ? `${began} to ${timeFormat.format(new Date(i.resolvedAt))} · ${lasted(i)}`
    : `Since ${began} · ${lasted(i)} so far`;
}

/** An incident's updates, newest first: where it stood, what was said, and when. */
export function IncidentUpdates({ incident }: { incident: Incident }) {
  return (
    <ol className="m-0 flex list-none flex-col gap-3 p-0">
      {incident.updates.map((u) => (
        <li key={u.id} className="grid gap-x-4 gap-y-0.5 @md/app:grid-cols-[112px_minmax(0,1fr)]">
          <span className="text-[13px] font-medium text-ink">{incidentStateNames[u.state]}</span>
          <div className="min-w-0">
            <p className="m-0 text-[14px] whitespace-pre-line [overflow-wrap:anywhere] text-ink-2">
              {u.body}
            </p>
            <p className="tabular m-0 mt-0.5 text-[12px] text-ink-3">
              {timeFormat.format(new Date(u.createdAt))}
              {u.author ? ` · ${u.author}` : ""}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** An incident as a panel: its title, what it touches, and its updates. */
export function IncidentPanel({ incident }: { incident: Incident }) {
  return (
    <article
      id={`incident-${incident.id}`}
      className="flex flex-col gap-4 rounded-panel-lg border border-line bg-raised/25 p-4 shadow-1"
    >
      <header className="flex items-start gap-3">
        <StateDot
          state={incident.resolvedAt ? "operational" : incident.impact}
          className="mt-1.5"
        />
        <div className="min-w-0 flex-1">
          <h3 className="m-0 text-[15px] font-medium [overflow-wrap:anywhere] text-ink">
            {incident.title}
          </h3>
          <p className="m-0 mt-0.5 text-[13px] text-ink-3">
            {incidentLine(incident)} · {incidentSpan(incident)}
          </p>
        </div>
      </header>
      <IncidentUpdates incident={incident} />
    </article>
  );
}

/**
 * Where people look for help (#183): the status page's rows on the Support page. Each open
 * incident as its own row, so what is wrong is read before a ticket is written; otherwise one
 * quiet row saying how long it has been.
 */
export function StatusRows({ url, hint }: { url: string; hint?: string }) {
  const { data } = useQuery(statusNowQuery);
  const open = data?.open ?? [];
  const link = (
    <Button variant="ghost" size="md" asChild>
      <a href={url} target="_blank" rel="noopener noreferrer">
        Open
      </a>
    </Button>
  );
  if (open.length > 0)
    return open.map((i) => (
      <Row
        key={i.id}
        name={
          <span className="flex items-center gap-2">
            <StateDot state={i.impact} />
            <span className="min-w-0 [overflow-wrap:anywhere]">{i.title}</span>
          </span>
        }
        hint={`${incidentImpactNames[i.impact]} · ${incidentStateNames[i.state]} · updated ${ago(i.updatedAt)}`}
        inline
      >
        {link}
      </Row>
    ));
  const calm = data ? calmLine(data) : "Reading the status";
  return (
    <Row
      name={
        <span className="flex items-center gap-2">
          <StateDot state={data?.state ?? "operational"} />
          Status
        </span>
      }
      hint={hint ? `${calm}. ${hint}` : calm}
      inline
    >
      {link}
    </Row>
  );
}

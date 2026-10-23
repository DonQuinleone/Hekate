import type { DayState, ServiceState, StatusIncident, StatusService } from "~/data/status";
import {
  impactNames,
  incidentStateNames,
  serviceStateNames,
  statusServiceName,
} from "~/data/status";
import { cn } from "~/lib/cn";

/**
 * The status page's parts (#183). States are told apart by fill, from quiet ink to the signal at
 * full strength, never by a traffic light: running is ink, slowness a ring of signal, a partial
 * outage half signal, an outage the signal itself.
 */
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

const barClass: Record<DayState, string> = {
  none: "bg-hairline",
  operational: "bg-ink-3/45",
  degraded: "bg-signal/35",
  partial: "bg-signal/65",
  major: "bg-signal",
};

/** A service: its name, its state now, and its 90 days as bars over its uptime. */
export function ServiceUptime({ service, state }: { service: StatusService; state: ServiceState }) {
  return (
    <div className="flex flex-col gap-2.5 px-4 py-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[14px] text-ink">{service.name}</div>
          <div className="mt-0.5 text-[13px] text-ink-3">{service.hint}</div>
        </div>
        <span className="flex shrink-0 items-center gap-2 text-[13px] text-ink-2">
          <StateDot state={state} />
          {serviceStateNames[state]}
        </span>
      </div>
      <div
        role="img"
        aria-label={`${service.name}: ${service.uptime} uptime over 90 days`}
        className="flex h-7 items-stretch gap-px"
      >
        {service.days.map((d) => (
          <span
            key={d.day}
            title={d.note}
            className={cn("min-w-0 flex-1 rounded-[1px]", barClass[d.state])}
          />
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 text-[12px] text-ink-3">
        <span>90 days ago</span>
        <span className="tabular text-ink-2">{service.uptime} uptime</span>
        <span>Today</span>
      </div>
    </div>
  );
}

export function UptimeKey() {
  const items: [DayState, string][] = [
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

export const incidentLine = (i: StatusIncident) =>
  `${impactNames[i.impact]} · ${i.services.map(statusServiceName).join(", ")}`;

export const incidentSpan = (i: StatusIncident) =>
  i.resolved ? `${i.started} to ${i.resolved}` : `Since ${i.started}`;

/** An incident's updates, newest first; the desk names who wrote each, the public page never. */
export function IncidentUpdates({
  incident,
  authors,
}: {
  incident: StatusIncident;
  authors?: boolean;
}) {
  return (
    <ol className="m-0 flex list-none flex-col gap-3 p-0">
      {incident.updates.map((u) => (
        <li
          key={u.at + u.state}
          className="grid gap-x-4 gap-y-0.5 @md/app:grid-cols-[112px_minmax(0,1fr)]"
        >
          <span className="text-[13px] font-medium text-ink">{incidentStateNames[u.state]}</span>
          <div className="min-w-0">
            <p className="m-0 text-[14px] text-ink-2">{u.text}</p>
            <p className="tabular m-0 mt-0.5 text-[12px] text-ink-3">
              {u.at}
              {authors ? ` · ${u.by}` : ""}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function IncidentPanel({ incident }: { incident: StatusIncident }) {
  return (
    <article className="flex flex-col gap-4 rounded-panel-lg border border-line bg-raised/25 p-4 shadow-1">
      <header className="flex items-start gap-3">
        <StateDot state={incident.resolved ? "operational" : incident.impact} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <h3 className="m-0 text-[15px] font-medium text-ink">{incident.title}</h3>
          <p className="m-0 mt-0.5 text-[13px] text-ink-3">
            {incidentLine(incident)} · {incidentSpan(incident)}
          </p>
        </div>
      </header>
      <IncidentUpdates incident={incident} />
    </article>
  );
}

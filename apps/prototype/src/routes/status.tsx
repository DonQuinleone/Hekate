import { Lockup } from "~/components/brand";
import { IncidentPanel, ServiceUptime, StateDot, UptimeKey } from "~/components/incidents";
import { freshServices, openIncident, overallLine, pastIncidents, statusServices } from "~/data";
import { useViewer } from "~/viewer/context";
import { Loading } from "~/viewer/state-gate";

/**
 * `/status` (#183, decision 227): the instance's own status page, for anyone, signed in or not.
 * What is happening first, then each service over 90 days with its uptime, then what happened
 * before. Operators post its incidents from the instance's Support section. The switcher's
 * failed state shows an incident open; empty, an instance that has measured nothing yet.
 */
export function StatusPage() {
  const { settings } = useViewer();
  const state = settings.state;
  const open = state === "failed" ? [openIncident] : [];
  const services = state === "empty" ? freshServices : statusServices;
  const past = state === "empty" ? [] : pastIncidents;
  const overall = open.length > 0 ? (open[0]?.impact ?? "operational") : "operational";
  return (
    <div className="h-full overflow-y-auto">
      <main className="mx-auto flex w-full max-w-[760px] flex-col gap-10 px-4 py-10 @3xl/app:py-16">
        <header className="flex items-center gap-3">
          <Lockup size={20} />
          <span aria-hidden="true" className="h-4 w-px bg-line" />
          <h1 className="m-0 text-[15px] font-medium text-ink-2">Status</h1>
          <span className="tabular ml-auto truncate text-[13px] text-ink-3">
            review.endlesshall.example
          </span>
        </header>
        {state === "loading" ? (
          <Loading rows={5} />
        ) : (
          <>
            <section className="flex flex-col gap-1 rounded-panel-lg border border-line bg-raised/25 p-5 shadow-1">
              <p className="m-0 flex items-center gap-2.5 text-[18px] font-medium tracking-[-0.01em] text-ink">
                <StateDot state={overall} />
                {overallLine[overall]}
              </p>
              <p className="m-0 text-[13px] text-ink-3">
                Checked at 21:00; read again each minute.
              </p>
            </section>
            {open.length > 0 && (
              <section className="flex flex-col gap-3">
                <h2 className="m-0 text-[16px] font-medium text-ink">Happening now</h2>
                {open.map((i) => (
                  <IncidentPanel key={i.id} incident={i} />
                ))}
              </section>
            )}
            <section className="flex flex-col gap-3">
              <div>
                <h2 className="m-0 text-[16px] font-medium text-ink">Services</h2>
                <p className="m-0 mt-0.5 text-[13px] text-ink-3">
                  Each checked every minute; uptime over the last 90 days.
                </p>
              </div>
              <div className="flex flex-col divide-y divide-line rounded-panel-lg border border-line bg-raised/25 shadow-1">
                {services.map((s) => (
                  <ServiceUptime
                    key={s.id}
                    service={s}
                    state={
                      open.some((i) => i.services.includes(s.id))
                        ? openIncident.impact
                        : "operational"
                    }
                  />
                ))}
              </div>
              <UptimeKey />
            </section>
            <section className="flex flex-col gap-3">
              <h2 className="m-0 text-[16px] font-medium text-ink">Past incidents</h2>
              {past.length === 0 ? (
                <p className="m-0 text-[13px] text-ink-3">None in the last 90 days.</p>
              ) : (
                past.map((i) => <IncidentPanel key={i.id} incident={i} />)
              )}
            </section>
          </>
        )}
        <footer className="text-[12px] text-ink-3">Times are shown in your time zone.</footer>
      </main>
    </div>
  );
}

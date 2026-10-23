import { overallLine } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Mark, Wordmark } from "~/components/brand";
import { IncidentPanel, ServiceUptime, StateDot, UptimeKey } from "~/components/status";
import { formatDates } from "~/lib/locale";
import { statusPageQuery } from "~/lib/status";

const checkedFormat = formatDates({ hour: "2-digit", minute: "2-digit" });

/**
 * `/status` (#183): the instance's status page, for anyone, signed in or not (decision 227).
 * What is happening first, then each service over 90 days, then what happened before.
 */
export function StatusPage() {
  const { data, error } = useQuery(statusPageQuery);
  return (
    <div className="h-full overflow-y-auto">
      <main className="mx-auto flex w-full max-w-[760px] flex-col gap-10 px-4 py-10 @3xl/app:py-16">
        <header className="flex items-center gap-3">
          <span className="flex items-center gap-2 text-ink">
            <Mark size={22} aria-hidden="true" />
            <Wordmark height={18} />
          </span>
          <span aria-hidden="true" className="h-4 w-px bg-line" />
          <h1 className="m-0 text-[15px] font-medium text-ink-2">Status</h1>
          <span className="tabular ml-auto truncate text-[13px] text-ink-3">
            {window.location.host}
          </span>
        </header>
        {error ? (
          <section className="rounded-panel-lg border border-line bg-raised/25 p-5">
            <p className="m-0 flex items-center gap-2.5 text-[16px] text-ink">
              <StateDot state="major" />
              The status could not be read
            </p>
            <p className="m-0 mt-1 text-[13px] text-ink-3">
              The instance is not answering. Try again in a minute.
            </p>
          </section>
        ) : !data ? (
          <p className="m-0 text-[13px] text-ink-3">Reading the status</p>
        ) : (
          <>
            <section
              aria-live="polite"
              className="flex flex-col gap-1 rounded-panel-lg border border-line bg-raised/25 p-5 shadow-1"
            >
              <p className="m-0 flex items-center gap-2.5 text-[18px] font-medium tracking-[-0.01em] text-ink">
                <StateDot state={data.state} />
                {overallLine[data.state]}
              </p>
              <p className="m-0 text-[13px] text-ink-3">
                Checked at {checkedFormat.format(new Date(data.at))}; read again each minute.
              </p>
              {!data.complete && (
                <p className="m-0 mt-2 text-[13px] text-ink-2">
                  Its history could not be read, as the database is not answering: what you see was
                  checked just now.
                </p>
              )}
            </section>
            {data.open.length > 0 && (
              <section className="flex flex-col gap-3">
                <h2 className="m-0 text-[16px] font-medium text-ink">Happening now</h2>
                {data.open.map((i) => (
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
                {data.services.map((s) => (
                  <ServiceUptime key={s.name} service={s} />
                ))}
              </div>
              <UptimeKey />
            </section>
            <section className="flex flex-col gap-3">
              <h2 className="m-0 text-[16px] font-medium text-ink">Past incidents</h2>
              {data.past.length === 0 ? (
                <p className="m-0 text-[13px] text-ink-3">None in the last 90 days.</p>
              ) : (
                data.past.map((i) => <IncidentPanel key={i.id} incident={i} />)
              )}
            </section>
          </>
        )}
        <footer className="text-[12px] text-ink-3">Times are shown in your time zone.</footer>
      </main>
    </div>
  );
}

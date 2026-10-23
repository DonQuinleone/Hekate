import { formatMoney, type MonthKey, monthKeyOf, monthsBack } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Icon } from "~/components/icons";
import { formatDates } from "~/lib/locale";
import { instanceReportsQuery } from "~/lib/queries";
import { TileGrid } from "./billing";
import { Spark } from "./charts";
import { Row, Section } from "./settings";
import { Button } from "./ui/button";
import { Select } from "./ui/input";

/**
 * The Billing section's Reports tab (#180): what the plans are worth a month and a year,
 * churn, the average, the last twelve months collected, where the revenue comes from, and the
 * books as CSV for the accountant.
 */

const monthName = formatDates({ month: "short", year: "numeric", timeZone: "UTC" });
const nameOf = (month: MonthKey) => monthName.format(new Date(`${month}-01T00:00:00Z`));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The periods an export may cover, as months, both included. */
function periods(now = new Date()) {
  const year = now.getUTCFullYear();
  const twelve = monthsBack(now, 12);
  return {
    twelve: { label: "The last twelve months", from: twelve[0] ?? "", to: monthKeyOf(now) },
    year: { label: `${year} so far`, from: `${year}-01`, to: monthKeyOf(now) },
    last: { label: String(year - 1), from: `${year - 1}-01`, to: `${year - 1}-12` },
  } as const;
}

export function Reports() {
  const { data, error } = useQuery(instanceReportsQuery);
  const [period, setPeriod] = useState<"twelve" | "year" | "last">("twelve");
  if (error) return <p className="m-0 text-[13px] text-signal">{error.message}</p>;
  if (!data) return null;
  const money = (amount: number) => formatMoney(amount, data.currency);
  const chosen = periods()[period];
  const exportUrl = (kind: "invoices" | "recognition") =>
    `/api/instance/billing/exports/${kind}?${new URLSearchParams({ from: chosen.from, to: chosen.to })}`;
  const { churn } = data;
  return (
    <>
      <TileGrid
        tiles={[
          {
            label: "MRR",
            value: money(data.mrr),
            hint: `${plural(data.paying, "workspace")} paying`,
          },
          { label: "ARR", value: money(data.arr), hint: "annualised" },
          {
            label: "Churn",
            value:
              churn.rate === null
                ? "None"
                : `${(churn.rate * 100).toFixed(churn.rate === 0 ? 0 : 1)}%`,
            hint: `${plural(churn.lost, "plan")} ended in 90 days`,
          },
          {
            label: "Average per workspace",
            value: data.average === null ? "None" : money(data.average),
            hint: "a month each",
          },
        ]}
      />
      {data.otherCurrencies.length > 0 && (
        <p className="m-0 text-[13px] text-ink-3">
          In {data.currency}, the instance's currency. Plans in {data.otherCurrencies.join(" and ")}{" "}
          are left out of these figures.
        </p>
      )}
      <div className="grid gap-px overflow-hidden rounded-panel-lg border border-line bg-line @3xl/app:grid-cols-2">
        <Spark
          label="Collected"
          points={data.months.map((m) => m.collected)}
          format={money}
          when={(i) => nameOf(data.months[i]?.month ?? monthKeyOf(new Date()))}
          hint={`${data.currency} paid each month, the last twelve`}
        />
        <Spark
          label="Workspaces that paid"
          points={data.months.map((m) => m.workspaces)}
          format={(n) => String(n)}
          when={(i) => nameOf(data.months[i]?.month ?? monthKeyOf(new Date()))}
          hint="each month, the last twelve"
        />
      </div>
      <Section
        title="By plan"
        intro="Where the monthly revenue comes from, at list price; plans by agreement at what they paid."
      >
        {data.byPlan.length === 0 ? (
          <Row name="No plans yet" hint="Add a plan, and what it brings in shows here." />
        ) : (
          data.byPlan.map((p) => (
            <Row key={p.planId} name={p.name} hint={plural(p.workspaces, "workspace")} inline>
              <span className="flex w-36 items-center gap-3 @3xl/app:w-64">
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised">
                  <span
                    className="block h-full rounded-full bg-node-review"
                    style={{ width: `${Math.round(p.share * 100)}%` }}
                  />
                </span>
                <span className="tabular w-16 shrink-0 text-right text-[13px] text-ink-2">
                  {money(p.amount)}
                </span>
              </span>
            </Row>
          ))
        )}
      </Section>
      <Section
        title="Exports"
        intro="For the accountant, as CSV. Each export is recorded with the instance's events."
        action={
          <Select
            aria-label="Period"
            value={period}
            onChange={(e) => setPeriod(e.target.value as typeof period)}
            className="w-52"
          >
            {Object.entries(periods()).map(([value, p]) => (
              <option key={value} value={value}>
                {p.label}
              </option>
            ))}
          </Select>
        }
      >
        <Row
          name="Invoices"
          hint="Every invoice issued in the period, by hand and through the gateway."
        >
          <Button variant="secondary" size="md" asChild>
            <a href={exportUrl("invoices")} download>
              <Icon name="download" size={14} />
              CSV
            </a>
          </Button>
        </Row>
        <Row
          name="Revenue recognition"
          hint="What each month earned, by workspace and plan: each payment spread over the months it pays for."
        >
          <Button variant="secondary" size="md" asChild>
            <a href={exportUrl("recognition")} download>
              <Icon name="download" size={14} />
              CSV
            </a>
          </Button>
        </Row>
      </Section>
    </>
  );
}

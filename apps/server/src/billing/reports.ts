import { type Database, schema } from "@hekate/db";
import {
  type BillingReports,
  churnRate,
  currencyPlaces,
  type MonthKey,
  monthKeyOf,
  monthlyAmount,
  monthsBack,
  recognise,
} from "@hekate/shared";
import { and, asc, eq, gte, inArray, isNull, lt, lte, or } from "drizzle-orm";
import { csvLine } from "../logs.ts";
import { priceOf } from "./billing.ts";

const { organisations, workspacePlans, plans, invoices } = schema;

type Reader = Pick<Database, "select">;

/**
 * The instance's Billing reports (#180), in the instance's currency: what plans are worth a
 * month (MRR) and a year, churn, the average, the last twelve months collected, and where the
 * revenue comes from. The operators' view, so across workspaces deliberately.
 */

const DAY = 86_400_000;
const paying = ["active", "past_due"] as const;

export async function billingReports(
  db: Reader,
  currency: string,
  now = new Date(),
): Promise<BillingReports> {
  const months = monthsBack(now, 12);
  const firstMonth = monthStart(months[0] ?? monthKeyOf(now));
  const [onPlans, offered, [lost], paid] = await Promise.all([
    db
      .select({ organisationId: workspacePlans.organisationId, plan: plans })
      .from(workspacePlans)
      .innerJoin(plans, eq(plans.id, workspacePlans.planId))
      // Across workspaces deliberately: the instance's figures.
      .where(inArray(workspacePlans.status, [...paying])),
    db.select().from(plans).where(isNull(plans.retiredAt)),
    db
      .select({ organisationId: workspacePlans.organisationId })
      .from(workspacePlans)
      .innerJoin(plans, eq(plans.id, workspacePlans.planId))
      // Those whose plan ended lately, in this currency or by agreement.
      .where(
        and(
          eq(workspacePlans.status, "cancelled"),
          gte(workspacePlans.updatedAt, new Date(now.getTime() - 90 * DAY)),
          or(isNull(plans.priceAmount), eq(plans.currency, currency)),
        ),
      )
      .then((rows) => [rows.length]),
    db
      .select({
        organisationId: invoices.organisationId,
        source: invoices.source,
        amountPaid: invoices.amountPaid,
        paidAt: invoices.paidAt,
      })
      .from(invoices)
      // Across workspaces deliberately, as above.
      .where(
        and(
          eq(invoices.status, "paid"),
          eq(invoices.currency, currency),
          gte(invoices.paidAt, firstMonth),
        ),
      ),
  ]);
  // Each plan by agreement is worth what its workspaces paid by hand in the last twelve months,
  // as a month's share; each priced one its list price.
  const byHandOf = new Map<string, number>();
  for (const p of paid)
    if (p.source === "manual")
      byHandOf.set(p.organisationId, (byHandOf.get(p.organisationId) ?? 0) + p.amountPaid);
  const byPlan = new Map<string, { name: string; workspaces: number; amount: number }>();
  for (const p of offered)
    if (!p.priceAmount || p.currency === currency)
      byPlan.set(p.id, { name: p.name, workspaces: 0, amount: 0 });
  const otherCurrencies = new Set<string>();
  for (const { organisationId, plan } of onPlans) {
    const price = priceOf(plan);
    if (price && price.currency !== currency) {
      otherCurrencies.add(price.currency);
      continue;
    }
    const line = byPlan.get(plan.id) ?? { name: plan.name, workspaces: 0, amount: 0 };
    line.workspaces += 1;
    line.amount += price
      ? monthlyAmount(price)
      : Math.round((byHandOf.get(organisationId) ?? 0) / 12);
    byPlan.set(plan.id, line);
  }
  const lines = [...byPlan].map(([planId, l]) => ({ planId, ...l }));
  const mrr = lines.reduce((sum, l) => sum + l.amount, 0);
  const payingCount = lines.reduce((sum, l) => sum + l.workspaces, 0);
  const collected = new Map<MonthKey, { collected: number; workspaces: Set<string> }>(
    months.map((m) => [m, { collected: 0, workspaces: new Set() }]),
  );
  for (const p of paid) {
    if (!p.paidAt) continue;
    const month = collected.get(monthKeyOf(p.paidAt));
    if (!month) continue;
    month.collected += p.amountPaid;
    month.workspaces.add(p.organisationId);
  }
  return {
    currency,
    mrr,
    arr: mrr * 12,
    paying: payingCount,
    average: payingCount > 0 ? Math.round(mrr / payingCount) : null,
    churn: { lost: lost ?? 0, rate: churnRate(lost ?? 0, payingCount) },
    months: months.map((month) => {
      const m = collected.get(month);
      return { month, collected: m?.collected ?? 0, workspaces: m?.workspaces.size ?? 0 };
    }),
    byPlan: lines
      .map((l) => ({ ...l, share: mrr > 0 ? l.amount / mrr : 0 }))
      .sort(
        (a, b) =>
          b.amount - a.amount || b.workspaces - a.workspaces || a.name.localeCompare(b.name),
      ),
    otherCurrencies: [...otherCurrencies].sort(),
  };
}

/** The first moment of a month, in UTC. */
const monthStart = (month: string) => new Date(`${month}-01T00:00:00Z`);

/** The first moment after a month. */
const monthEnd = (month: string) => {
  const start = monthStart(month);
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
};

/** An amount in minor units, written as an accountant reads it: `49.00`, `4900` for yen. */
const decimal = (amount: number, currency: string) => {
  const places = currencyPlaces(currency);
  return (amount / 10 ** places).toFixed(places);
};

const isoDay = (at: Date | null) => at?.toISOString().slice(0, 10) ?? "";

const PAGE = 500;

/** Every invoice issued in the months asked, oldest first, as CSV. */
export async function* invoicesCsv(
  db: Reader,
  period: { from: string; to: string },
): AsyncGenerator<string> {
  yield csvLine([
    "number",
    "workspace",
    "source",
    "status",
    "currency",
    "amount_due",
    "amount_paid",
    "issued",
    "due",
    "paid",
    "period_start",
    "period_end",
    "description",
  ]);
  for (let offset = 0; ; offset += PAGE) {
    const rows = await db
      .select({ invoice: invoices, workspace: organisations.name })
      .from(invoices)
      .innerJoin(organisations, eq(organisations.id, invoices.organisationId))
      // Across workspaces deliberately: the instance's books.
      .where(
        and(
          gte(invoices.issuedAt, monthStart(period.from)),
          lt(invoices.issuedAt, monthEnd(period.to)),
        ),
      )
      .orderBy(asc(invoices.issuedAt), asc(invoices.id))
      .limit(PAGE)
      .offset(offset);
    for (const { invoice: i, workspace } of rows)
      yield csvLine([
        i.number,
        workspace,
        i.source,
        i.status,
        i.currency,
        decimal(i.amountDue, i.currency),
        decimal(i.amountPaid, i.currency),
        isoDay(i.issuedAt),
        isoDay(i.dueAt),
        isoDay(i.paidAt),
        isoDay(i.periodStart),
        isoDay(i.periodEnd),
        i.description,
      ]);
    if (rows.length < PAGE) return;
  }
}

/**
 * What was earned each month of those asked, by workspace and plan, as CSV: each paid
 * invoice spread over the months it pays for, by days (`recognise`). The plan is the one the
 * workspace is on now; invoices do not record one.
 */
export async function* recognitionCsv(
  db: Reader,
  period: { from: string; to: string },
): AsyncGenerator<string> {
  yield csvLine(["month", "workspace", "plan", "currency", "amount"]);
  const from = monthStart(period.from);
  const to = monthEnd(period.to);
  const rows = await db
    .select({
      organisationId: invoices.organisationId,
      workspace: organisations.name,
      plan: plans.name,
      currency: invoices.currency,
      amountPaid: invoices.amountPaid,
      paidAt: invoices.paidAt,
      periodStart: invoices.periodStart,
      periodEnd: invoices.periodEnd,
    })
    .from(invoices)
    .innerJoin(organisations, eq(organisations.id, invoices.organisationId))
    .leftJoin(workspacePlans, eq(workspacePlans.organisationId, invoices.organisationId))
    .leftJoin(plans, eq(plans.id, workspacePlans.planId))
    // Across workspaces deliberately, as above: paid, and paying for some of the months asked.
    .where(
      and(
        eq(invoices.status, "paid"),
        lte(invoices.paidAt, to),
        or(
          gte(invoices.periodEnd, from),
          and(isNull(invoices.periodEnd), gte(invoices.paidAt, from)),
        ),
      ),
    );
  const earned = new Map<
    string,
    { month: string; workspace: string; plan: string; currency: string; amount: number }
  >();
  for (const r of rows) {
    if (!r.paidAt) continue;
    for (const share of recognise({ ...r, paidAt: r.paidAt })) {
      if (share.month < period.from || share.month > period.to) continue;
      const key = `${share.month}|${r.organisationId}|${r.currency}`;
      const line = earned.get(key) ?? {
        month: share.month,
        workspace: r.workspace,
        plan: r.plan ?? "",
        currency: r.currency,
        amount: 0,
      };
      line.amount += share.amount;
      earned.set(key, line);
    }
  }
  const lines = [...earned.values()].sort(
    (a, b) => a.month.localeCompare(b.month) || a.workspace.localeCompare(b.workspace),
  );
  for (const l of lines)
    yield csvLine([l.month, l.workspace, l.plan, l.currency, decimal(l.amount, l.currency)]);
}

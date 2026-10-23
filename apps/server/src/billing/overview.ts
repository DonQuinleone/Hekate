import { type Database, inOrg, schema } from "@hekate/db";
import {
  type BillingOverview,
  type BillingWorkspaceRow,
  DUNNING_REASON,
  monthlyAmount,
  type WorkspacePlanStatus,
} from "@hekate/shared";
import { and, asc, count, eq, gte, isNotNull, isNull, lt } from "drizzle-orm";
import { CodedException, NotFound } from "../errors.ts";
import { assignPlan } from "../plans.ts";
import { type BillingDeps, keepInvoice, priceOf, settle } from "./billing.ts";
import type { Gateway, InvoiceFacts } from "./gateway.ts";

const { organisations, workspacePlans, plans, billingAccounts, invoices, gatewayEvents } = schema;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Reader = Pick<Database, "select" | "selectDistinctOn">;

/**
 * The instance's Billing overview (#180): what the workspaces pay, who is on trial, who owes,
 * and every workspace's plan and next invoice. The operators' view, so across workspaces
 * deliberately.
 */

/** The most workspaces the overview lists. */
const LISTED = 500;

export async function billingOverview(
  db: Reader,
  gateway: Gateway | null,
  now = new Date(),
): Promise<BillingOverview> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [rows, late, [failed], payout] = await Promise.all([
    db
      .select({
        id: organisations.id,
        name: organisations.name,
        suspendedReason: organisations.suspendedReason,
        plan: plans,
        status: workspacePlans.status,
        trialEndsAt: workspacePlans.trialEndsAt,
        renewsAt: workspacePlans.renewsAt,
        cancelsAt: workspacePlans.cancelsAt,
        subscriptionId: billingAccounts.subscriptionId,
        pastDueSince: billingAccounts.pastDueSince,
      })
      .from(organisations)
      .leftJoin(workspacePlans, eq(workspacePlans.organisationId, organisations.id))
      .leftJoin(plans, eq(plans.id, workspacePlans.planId))
      .leftJoin(billingAccounts, eq(billingAccounts.organisationId, organisations.id))
      // Across workspaces deliberately: the operators' view of every one.
      .orderBy(asc(organisations.name))
      .limit(LISTED),
    // Each workspace's oldest invoice past its due date and still open.
    db
      .selectDistinctOn([invoices.organisationId], {
        organisationId: invoices.organisationId,
        number: invoices.number,
        dueAt: invoices.dueAt,
      })
      .from(invoices)
      // Across workspaces deliberately, as above.
      .where(and(eq(invoices.status, "open"), isNotNull(invoices.dueAt), lt(invoices.dueAt, now)))
      .orderBy(asc(invoices.organisationId), asc(invoices.dueAt)),
    db
      .select({ n: count() })
      .from(gatewayEvents)
      .where(
        and(
          eq(gatewayEvents.type, "invoice.payment_failed"),
          gte(gatewayEvents.occurredAt, monthStart),
        ),
      ),
    // Read as the page opens; the page still shows without it.
    gateway
      ? gateway.nextPayout().catch((error: unknown) => {
          console.error("The gateway's next payout could not be read", error);
          return null;
        })
      : null,
  ]);
  const overdueOf = new Map(late.map((l) => [l.organisationId, l]));
  const workspaces: BillingWorkspaceRow[] = rows.map((r) => {
    const owed = overdueOf.get(r.id);
    return {
      id: r.id,
      name: r.name,
      plan: r.plan ? { id: r.plan.id, name: r.plan.name } : null,
      status: (r.plan && r.status) || null,
      price: r.plan ? priceOf(r.plan) : null,
      trialEndsAt: r.trialEndsAt?.toISOString() ?? null,
      renewsAt: r.renewsAt?.toISOString() ?? null,
      cancelsAt: r.cancelsAt?.toISOString() ?? null,
      subscribed: Boolean(r.subscriptionId),
      pastDueSince: r.pastDueSince?.toISOString() ?? null,
      overdue: owed?.dueAt ? { number: owed.number, dueAt: owed.dueAt.toISOString() } : null,
      dunningSuspended: r.suspendedReason === DUNNING_REASON,
    };
  });
  return {
    gateway: gateway?.kind ?? null,
    ...totals(workspaces),
    failedPayments: failed?.n ?? 0,
    nextPayout: payout ? { ...payout, arrivesAt: payout.arrivesAt.toISOString() } : null,
    workspaces: workspaces.sort((a, b) => attention(a) - attention(b)),
  };
}

const paying = new Set<WorkspacePlanStatus | null>(["active", "past_due"]);

/** Since when a workspace has owed, or null. */
const owingSince = (w: BillingWorkspaceRow) => w.pastDueSince ?? w.overdue?.dueAt ?? null;

/** The overview's figures, from its rows. */
export function totals(
  workspaces: BillingWorkspaceRow[],
): Pick<BillingOverview, "revenue" | "paying" | "custom" | "trials" | "overdue"> {
  const revenue = new Map<string, { amount: number; workspaces: number }>();
  let payingCount = 0;
  let custom = 0;
  for (const w of workspaces) {
    if (!w.plan || !paying.has(w.status)) continue;
    payingCount += 1;
    if (!w.price) {
      custom += 1;
      continue;
    }
    const sum = revenue.get(w.price.currency) ?? { amount: 0, workspaces: 0 };
    sum.amount += monthlyAmount(w.price);
    sum.workspaces += 1;
    revenue.set(w.price.currency, sum);
  }
  const trials = workspaces.filter((w) => w.status === "trial");
  const owing = workspaces
    .map((w) => ({ name: w.name, since: owingSince(w) }))
    .filter((w): w is { name: string; since: string } => w.since !== null)
    .sort((a, b) => a.since.localeCompare(b.since));
  const ends = trials
    .map((t) => t.trialEndsAt)
    .filter((t): t is string => t !== null)
    .sort();
  return {
    revenue: [...revenue]
      .map(([currency, sum]) => ({ currency, ...sum }))
      .sort((a, b) => b.workspaces - a.workspaces || b.amount - a.amount),
    paying: payingCount,
    custom,
    trials: { count: trials.length, soonestEnd: ends[0] ?? null },
    overdue: { count: owing.length, longest: owing[0] ?? null },
  };
}

/** Who needs an operator first: those owing, then those on trial, then the rest. */
const attention = (w: BillingWorkspaceRow) =>
  w.dunningSuspended || owingSince(w) ? 0 : w.status === "trial" ? 1 : 2;

/**
 * Waive what a workspace owes (#180): its open invoices are voided (at the gateway for its
 * own), dunning ends, and a workspace dunning suspended opens again. One an operator suspended
 * stays as they left it. Says how many invoices were voided, and whether it opened again.
 */
export async function waive(
  deps: BillingDeps,
  organisationId: string,
): Promise<{ voided: number; reinstated: boolean }> {
  const { db, gateway } = deps;
  const open = await db
    .select()
    .from(invoices)
    .where(inOrg(invoices, organisationId, eq(invoices.status, "open")));
  const [account] = await db
    .select()
    .from(billingAccounts)
    .where(inOrg(billingAccounts, organisationId));
  const [org] = await db
    .select({ reason: organisations.suspendedReason })
    .from(organisations)
    .where(eq(organisations.id, organisationId));
  if (!org) throw new NotFound("Workspace");
  if (open.length === 0 && !account?.pastDueSince && org.reason !== DUNNING_REASON)
    throw new CodedException(409, "nothing_owed", "This workspace owes nothing.");
  const fromGateway = open.filter((i) => i.source === "stripe" && i.gatewayId);
  if (fromGateway.length > 0 && !gateway)
    throw new CodedException(
      409,
      "billing_unavailable",
      "Its invoices are the gateway's, and the gateway is not connected (HEKATE_BILLING).",
    );
  // The gateway's first: once they are void there, nothing can collect them.
  const voided: InvoiceFacts[] = [];
  for (const i of fromGateway) {
    const now = gateway && i.gatewayId ? await gateway.voidInvoice(i.gatewayId) : null;
    if (now) voided.push(now);
  }
  return db.transaction(async (tx: Tx) => {
    // Held as the webhooks hold it, so an event at the same moment waits.
    await tx
      .select({ id: billingAccounts.id })
      .from(billingAccounts)
      .where(inOrg(billingAccounts, organisationId))
      .for("update");
    for (const facts of voided) await keepInvoice(tx, organisationId, facts);
    const byHand = await tx
      .update(invoices)
      .set({ status: "void", updatedAt: new Date() })
      .where(
        inOrg(invoices, organisationId, eq(invoices.source, "manual"), eq(invoices.status, "open")),
      )
      .returning({ id: invoices.id });
    // Dunning ends, and its suspension with it, whatever step it had reached.
    const reinstated = await reopenIfDunned(tx, organisationId);
    await settle(tx, organisationId);
    return { voided: voided.filter((v) => v.status === "void").length + byHand.length, reinstated };
  });
}

/** A workspace dunning suspended opens again, whatever step dunning had reached. */
async function reopenIfDunned(tx: Tx, organisationId: string) {
  const reopened = await tx
    .update(organisations)
    .set({ suspendedAt: null, suspendedReason: null, updatedAt: new Date() })
    .where(
      and(
        eq(organisations.id, organisationId),
        eq(organisations.suspendedReason, DUNNING_REASON),
        isNull(organisations.deleteAfter),
      ),
    )
    .returning({ id: organisations.id });
  return reopened.length > 0;
}

/**
 * An operator puts a workspace on a plan (#180). One paying through the gateway is moved on its
 * subscription too, so the gateway bills the plan it is on; it cannot be put on a plan by
 * agreement, or none, while its subscription runs.
 */
export async function planByOperator(
  deps: Pick<BillingDeps, "gateway">,
  tx: Tx,
  organisationId: string,
  input: Parameters<typeof assignPlan>[2],
) {
  const [account] = await tx
    .select()
    .from(billingAccounts)
    .where(inOrg(billingAccounts, organisationId))
    .for("update");
  if (account?.subscriptionId && deps.gateway) {
    const [plan] = input.planId
      ? await tx.select().from(plans).where(eq(plans.id, input.planId))
      : [];
    const price = plan ? priceOf(plan) : null;
    if (!plan || !price)
      throw new CodedException(
        409,
        "subscribed",
        "It pays for its plan through the gateway: choose a priced plan, or cancel its subscription first.",
      );
    if (plan.retiredAt) throw new CodedException(409, "plan_retired", "That plan is retired.");
    await deps.gateway.changePlan({
      subscriptionId: account.subscriptionId,
      plan: { id: plan.id, name: plan.name, price },
      discount: null,
    });
  }
  return assignPlan(tx, organisationId, input);
}

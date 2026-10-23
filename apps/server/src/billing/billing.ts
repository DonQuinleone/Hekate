import { type Database, inOrg, schema } from "@hekate/db";
import {
  dunningDue,
  dunningSteps,
  formatMoney,
  type Invoice,
  type InvoiceStatus,
  type WorkspacePlan,
} from "@hekate/shared";
import { and, asc, desc, eq, isNotNull, isNull, lt } from "drizzle-orm";
import { longDate } from "../email/templates.ts";
import { CodedException, NotFound } from "../errors.ts";
import { type Mailer, sendEmail } from "../mail.ts";
import { assignPlan, workspacePlanOf } from "../plans.ts";
import { recordInstanceEvent } from "../routes/instance.ts";
import type { Fact, Gateway, GatewayEvent, InvoiceFacts } from "./gateway.ts";

const { billingAccounts, invoices, gatewayEvents, workspacePlans, plans, organisations, members } =
  schema;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Reader = Pick<Database, "select">;

/**
 * Billing (#178): checking out, the webhooks that follow, the invoices they carry and dunning.
 * The gateway says what happened; this decides what it means for the workspace: its plan and
 * limits (#177), its invoices, and, a payment missed, its warnings and its suspension.
 */

export interface BillingDeps {
  db: Database;
  gateway: Gateway | null;
  mailer: Mailer;
  publicUrl: string;
}

/** Why a workspace dunning suspended is suspended, and how it is told apart from an operator's. */
export const DUNNING_REASON =
  "A payment is 21 days overdue. The workspace opens again as soon as it is paid.";

const billingUrl = (publicUrl: string) => new URL("/settings/billing", publicUrl).toString();

const invoiceOf = (row: typeof invoices.$inferSelect): Invoice => ({
  id: row.id,
  source: row.source,
  number: row.number,
  status: row.status,
  currency: row.currency,
  amountDue: row.amountDue,
  amountPaid: row.amountPaid,
  periodStart: row.periodStart?.toISOString() ?? null,
  periodEnd: row.periodEnd?.toISOString() ?? null,
  issuedAt: row.issuedAt.toISOString(),
  dueAt: row.dueAt?.toISOString() ?? null,
  paidAt: row.paidAt?.toISOString() ?? null,
  url: row.url,
});

/** A workspace's invoices, newest first. */
export async function invoicesOf(db: Reader, organisationId: string): Promise<Invoice[]> {
  const rows = await db
    .select()
    .from(invoices)
    .where(inOrg(invoices, organisationId))
    .orderBy(desc(invoices.issuedAt))
    .limit(100);
  return rows.map(invoiceOf);
}

/** What the workspace's billing settings show: its plan, what it may choose, its invoices. */
export async function billingOf(
  db: Reader,
  organisationId: string,
  gateway: Gateway | null,
): Promise<{
  gateway: Gateway["kind"] | null;
  plan: WorkspacePlan;
  plans: { id: string; key: string; name: string; price: PlanPrice }[];
  subscribed: boolean;
  pastDueSince: string | null;
  invoices: Invoice[];
}> {
  const [plan, offered, [account], list] = await Promise.all([
    workspacePlanOf(db, organisationId, true),
    db
      .select()
      .from(plans)
      .where(and(eq(plans.hidden, false), isNull(plans.retiredAt), isNotNull(plans.priceAmount)))
      .orderBy(asc(plans.position), asc(plans.name)),
    db.select().from(billingAccounts).where(inOrg(billingAccounts, organisationId)),
    invoicesOf(db, organisationId),
  ]);
  return {
    gateway: gateway?.kind ?? null,
    plan,
    plans: offered.flatMap((p) => {
      const price = priceOf(p);
      return price ? [{ id: p.id, key: p.key, name: p.name, price }] : [];
    }),
    subscribed: Boolean(account?.subscriptionId),
    pastDueSince: account?.pastDueSince?.toISOString() ?? null,
    invoices: list,
  };
}

type PlanPrice = { amount: number; currency: string; interval: "month" | "year" };
const priceOf = (p: typeof plans.$inferSelect): PlanPrice | null =>
  p.priceAmount === null || !p.interval
    ? null
    : { amount: p.priceAmount, currency: p.currency, interval: p.interval };

const unavailable = () =>
  new CodedException(
    409,
    "billing_unavailable",
    "Plans are not paid for here: the instance takes no payments (HEKATE_BILLING).",
  );

/**
 * Change the workspace's plan: the first time through the gateway's checkout, whose page the
 * owner is sent to; with a subscription already, on that subscription, at once.
 */
export async function changePlan(
  deps: BillingDeps,
  input: { organisationId: string; userId: string; planId: string },
): Promise<{ url: string | null }> {
  const { db, gateway } = deps;
  if (!gateway) throw unavailable();
  const [plan] = await db.select().from(plans).where(eq(plans.id, input.planId));
  // A hidden plan is the operators' to give; a retired one nobody's.
  if (!plan || plan.hidden || plan.retiredAt) throw new NotFound("Plan");
  const price = priceOf(plan);
  if (!price)
    throw new CodedException(
      409,
      "plan_by_agreement",
      "That plan is by agreement: ask the instance's operators.",
    );
  const priced = { id: plan.id, name: plan.name, price };
  const [account] = await db
    .select()
    .from(billingAccounts)
    .where(inOrg(billingAccounts, input.organisationId));
  if (account?.subscriptionId) {
    await gateway.changePlan({ subscriptionId: account.subscriptionId, plan: priced });
    // The gateway's webhook confirms it, and puts the workspace on the plan.
    return { url: null };
  }
  const customerId = account?.customerId ?? (await customerFor(deps, input));
  const current = await workspacePlanOf(db, input.organisationId, true);
  const url = billingUrl(deps.publicUrl);
  return {
    url: await gateway.checkout({
      organisationId: input.organisationId,
      customerId,
      plan: priced,
      trialEnd:
        current.status === "trial" && current.trialEndsAt ? new Date(current.trialEndsAt) : null,
      successUrl: `${url}?checkout=done`,
      cancelUrl: url,
    }),
  };
}

/** The workspace's customer at the gateway, made now and kept. */
async function customerFor(deps: BillingDeps, input: { organisationId: string; userId: string }) {
  const { db, gateway } = deps;
  if (!gateway) throw unavailable();
  const [who] = await db
    .select({ name: organisations.name, email: schema.users.email })
    .from(organisations)
    .innerJoin(members, eq(members.organisationId, organisations.id))
    .innerJoin(schema.users, eq(schema.users.id, members.userId))
    .where(and(eq(organisations.id, input.organisationId), eq(members.userId, input.userId)));
  if (!who) throw new NotFound("Workspace");
  const customerId = await gateway.createCustomer({
    organisationId: input.organisationId,
    name: who.name,
    email: who.email,
  });
  // The gateway makes one customer per workspace however often it is asked, so a second
  // request at once finds the row the first wrote.
  await db
    .insert(billingAccounts)
    .values({ organisationId: input.organisationId, gateway: gateway.kind, customerId })
    .onConflictDoNothing();
  return customerId;
}

/** The gateway's page for the workspace's card and billing details. */
export async function portalFor(deps: BillingDeps, organisationId: string): Promise<string> {
  if (!deps.gateway) throw unavailable();
  const [account] = await deps.db
    .select()
    .from(billingAccounts)
    .where(inOrg(billingAccounts, organisationId));
  if (!account)
    throw new CodedException(409, "not_a_customer", "Choose a plan first: nothing is paid yet.");
  return deps.gateway.portal({
    customerId: account.customerId,
    returnUrl: billingUrl(deps.publicUrl),
  });
}

/**
 * Take an event from the gateway, once: the first delivery is recorded and acted on, and a
 * second of the same event answers as the first did. One that failed part-way is tried again on
 * its next delivery, and `again` takes one already taken a second time (#159's replay).
 */
export async function takeGatewayEvent(
  deps: BillingDeps,
  gateway: Gateway["kind"],
  event: GatewayEvent,
  options: { again?: boolean } = {},
): Promise<{ taken: boolean; result: string }> {
  const { db } = deps;
  const [made] = await db
    .insert(gatewayEvents)
    .values({
      gateway,
      eventId: event.id,
      type: event.type,
      payload: event.payload,
      occurredAt: event.occurredAt,
    })
    .onConflictDoNothing()
    .returning({ id: gatewayEvents.id });
  const [row] = made
    ? [made]
    : await db
        .select({ id: gatewayEvents.id })
        .from(gatewayEvents)
        .where(and(eq(gatewayEvents.gateway, gateway), eq(gatewayEvents.eventId, event.id)));
  if (!row) throw new Error("The gateway event was neither written nor found");
  try {
    // Held while it is acted on, so the same event sent twice at once is taken once.
    return await db.transaction(async (tx) => {
      const [held] = await tx
        .select({ takenAt: gatewayEvents.takenAt, result: gatewayEvents.result })
        .from(gatewayEvents)
        .where(eq(gatewayEvents.id, row.id))
        .for("update");
      if (held?.takenAt && !options.again) return { taken: false, result: held.result ?? "taken" };
      const outcome = await act(tx, event.fact, event.occurredAt);
      await tx
        .update(gatewayEvents)
        .set({ ...outcome, takenAt: new Date() })
        .where(eq(gatewayEvents.id, row.id));
      return { taken: true, result: outcome.result };
    });
  } catch (error) {
    await db
      .update(gatewayEvents)
      .set({ result: `failed: ${error instanceof Error ? error.message : String(error)}` })
      .where(eq(gatewayEvents.id, row.id));
    throw error;
  }
}

interface Outcome {
  organisationId: string | null;
  summary: string | null;
  amount: number | null;
  currency: string | null;
  result: string;
}

/** The workspace a gateway's customer is, looked up by the customer the gateway names. */
async function accountOfCustomer(tx: Tx, customerId: string) {
  const [account] = await tx
    .select()
    .from(billingAccounts)
    // Deliberately by customer alone: the gateway names its customer, not a workspace.
    .where(eq(billingAccounts.customerId, customerId))
    .for("update");
  return account ?? null;
}

async function act(tx: Tx, fact: Fact, at: Date): Promise<Outcome> {
  const none = { organisationId: null, summary: null, amount: null, currency: null };
  switch (fact.kind) {
    case "checkout": {
      const account = await accountOfCustomer(tx, fact.customerId);
      // Only the workspace whose customer checked out: the reference alone proves nothing.
      if (account?.organisationId !== fact.organisationId)
        return { ...none, result: "ignored: not this workspace's customer" };
      await tx
        .update(billingAccounts)
        .set({ subscriptionId: fact.subscriptionId, updatedAt: new Date() })
        .where(inOrg(billingAccounts, account.organisationId));
      return {
        ...none,
        organisationId: account.organisationId,
        summary: "Checkout",
        result: "taken",
      };
    }
    case "subscription": {
      const account = await accountOfCustomer(tx, fact.customerId);
      if (!account) return { ...none, result: "ignored: no workspace is this customer" };
      const organisationId = account.organisationId;
      const [plan] = fact.planId
        ? await tx.select().from(plans).where(eq(plans.id, fact.planId))
        : [];
      const base = {
        organisationId,
        summary: plan?.name ?? null,
        amount: fact.amount,
        currency: fact.currency,
      };
      // Stripe may send a subscription's events out of order: an older one changes nothing.
      if (account.subscriptionEventAt && at < account.subscriptionEventAt)
        return { ...base, result: "ignored: older than the last" };
      await tx
        .update(billingAccounts)
        .set({ subscriptionEventAt: at })
        .where(inOrg(billingAccounts, organisationId));
      if (fact.ended) {
        // An old subscription ending, once the workspace has another, changes nothing.
        if (account.subscriptionId && account.subscriptionId !== fact.subscriptionId)
          return { ...base, result: "ignored: not the workspace's subscription" };
        await tx
          .update(billingAccounts)
          .set({ subscriptionId: null, updatedAt: new Date() })
          .where(inOrg(billingAccounts, organisationId));
      } else if (account.subscriptionId !== fact.subscriptionId)
        await tx
          .update(billingAccounts)
          .set({ subscriptionId: fact.subscriptionId, updatedAt: new Date() })
          .where(inOrg(billingAccounts, organisationId));
      if (!fact.status) return { ...base, result: "taken" };
      const dates = {
        trialEndsAt: fact.trialEndsAt?.toISOString() ?? null,
        renewsAt: fact.ended ? null : (fact.renewsAt?.toISOString() ?? null),
      };
      if (plan)
        await assignPlan(
          tx,
          organisationId,
          { planId: plan.id, status: fact.status, ...dates },
          { retired: true },
        );
      else
        await tx
          .update(workspacePlans)
          .set({
            status: fact.status,
            trialEndsAt: fact.trialEndsAt,
            renewsAt: fact.ended ? null : fact.renewsAt,
            updatedAt: new Date(),
          })
          .where(inOrg(workspacePlans, organisationId));
      if (fact.status === "past_due") await markPastDue(tx, organisationId, at);
      else if (fact.status === "active" || fact.status === "trial")
        await settle(tx, organisationId);
      return { ...base, result: "taken" };
    }
    case "invoice": {
      const account = await accountOfCustomer(tx, fact.customerId);
      if (!account) return { ...none, result: "ignored: no workspace is this customer" };
      const organisationId = account.organisationId;
      await keepInvoice(tx, organisationId, fact.invoice);
      if (fact.outcome === "failed") await markPastDue(tx, organisationId, at);
      else if (fact.outcome === "paid") await settle(tx, organisationId);
      return {
        organisationId,
        summary: fact.invoice.number,
        amount: fact.outcome === "paid" ? fact.invoice.amountPaid : fact.invoice.amountDue,
        currency: fact.invoice.currency,
        result: "taken",
      };
    }
    case "payout":
      return { ...none, amount: fact.amount, currency: fact.currency, result: "taken" };
    case "other":
      return { ...none, result: "ignored" };
  }
}

/** How far along an invoice is: one never moves back, whatever order its events arrive in. */
const rank: Record<InvoiceStatus, number> = {
  draft: 0,
  open: 1,
  uncollectible: 2,
  paid: 3,
  void: 3,
};

async function keepInvoice(tx: Tx, organisationId: string, facts: InvoiceFacts) {
  const [held] = await tx
    .select()
    .from(invoices)
    .where(inOrg(invoices, organisationId, eq(invoices.gatewayId, facts.gatewayId)))
    .for("update");
  const values = { ...facts, updatedAt: new Date() };
  if (!held) {
    await tx
      .insert(invoices)
      .values({ organisationId, source: "stripe", ...values })
      .onConflictDoNothing();
    return;
  }
  const behind = rank[facts.status] < rank[held.status];
  await tx
    .update(invoices)
    .set(
      behind
        ? // An older event: only what it adds.
          { number: held.number ?? facts.number, url: held.url ?? facts.url, updatedAt: new Date() }
        : values,
    )
    .where(inOrg(invoices, organisationId, eq(invoices.id, held.id)));
}

/** A payment failed: dunning counts from the first failure, however many follow. */
async function markPastDue(tx: Tx, organisationId: string, at: Date) {
  await tx
    .update(billingAccounts)
    .set({ pastDueSince: at, updatedAt: new Date() })
    .where(inOrg(billingAccounts, organisationId, isNull(billingAccounts.pastDueSince)));
  await tx
    .update(workspacePlans)
    .set({ status: "past_due", updatedAt: new Date() })
    .where(inOrg(workspacePlans, organisationId));
}

/**
 * A payment went through: dunning is over, and a workspace it suspended opens again. One an
 * operator suspended, or set to be deleted, stays as the operator left it.
 */
async function settle(tx: Tx, organisationId: string) {
  const [before] = await tx
    .select({ stage: billingAccounts.dunningStage })
    .from(billingAccounts)
    .where(inOrg(billingAccounts, organisationId));
  await tx
    .update(billingAccounts)
    .set({ pastDueSince: null, dunningStage: 0, updatedAt: new Date() })
    .where(inOrg(billingAccounts, organisationId));
  await tx
    .update(workspacePlans)
    .set({ status: "active", updatedAt: new Date() })
    .where(inOrg(workspacePlans, organisationId, eq(workspacePlans.status, "past_due")));
  if ((before?.stage ?? 0) < dunningSteps.length) return;
  const [reopened] = await tx
    .update(organisations)
    .set({ suspendedAt: null, suspendedReason: null, updatedAt: new Date() })
    .where(
      and(
        eq(organisations.id, organisationId),
        eq(organisations.suspendedReason, DUNNING_REASON),
        isNull(organisations.deleteAfter),
      ),
    )
    .returning({ name: organisations.name });
  if (reopened)
    await recordInstanceEvent(tx, {
      actorId: null,
      action: "workspace.reinstated",
      target: reopened.name,
      details: { organisationId, by: "billing" },
    });
}

/**
 * Dunning, hourly: each workspace whose payment failed is warned at 7 and 14 days and
 * suspended at 21, until a payment goes through. Each step is taken once, claimed in the
 * database first, so two workers never both send it. Returns the steps taken.
 */
export async function runDunning(deps: BillingDeps, now = new Date()): Promise<number> {
  const { db } = deps;
  const due = await db
    .select({
      organisationId: billingAccounts.organisationId,
      pastDueSince: billingAccounts.pastDueSince,
      stage: billingAccounts.dunningStage,
    })
    .from(billingAccounts)
    // Across workspaces deliberately: the job looks after every one.
    .where(
      and(
        isNotNull(billingAccounts.pastDueSince),
        lt(billingAccounts.dunningStage, dunningSteps.length),
      ),
    );
  let taken = 0;
  for (const account of due) {
    if (!account.pastDueSince) continue;
    const step = dunningDue(account.pastDueSince, now, account.stage);
    if (step === null) continue;
    const since = account.pastDueSince;
    const suspends = dunningSteps[step - 1]?.action === "suspend";
    const claimed = await db.transaction(async (tx) => {
      const [claim] = await tx
        .update(billingAccounts)
        .set({ dunningStage: step, updatedAt: new Date() })
        .where(
          inOrg(
            billingAccounts,
            account.organisationId,
            lt(billingAccounts.dunningStage, step),
            isNotNull(billingAccounts.pastDueSince),
          ),
        )
        .returning({ id: billingAccounts.id });
      if (!claim) return false;
      if (suspends) {
        const [suspended] = await tx
          .update(organisations)
          .set({ suspendedAt: now, suspendedReason: DUNNING_REASON, updatedAt: new Date() })
          .where(
            and(eq(organisations.id, account.organisationId), isNull(organisations.suspendedAt)),
          )
          .returning({ name: organisations.name });
        if (suspended)
          await recordInstanceEvent(tx, {
            actorId: null,
            action: "workspace.suspended",
            target: suspended.name,
            details: {
              organisationId: account.organisationId,
              reason: DUNNING_REASON,
              by: "billing",
            },
          });
      }
      return true;
    });
    if (!claimed) continue;
    taken += 1;
    await tellOwners(deps, account.organisationId, since, step).catch((error) =>
      console.error(`Dunning mail for workspace ${account.organisationId} failed`, error),
    );
  }
  return taken;
}

/** The owners are told each step: what is owed, by when, and that nothing is deleted. */
async function tellOwners(deps: BillingDeps, organisationId: string, since: Date, step: number) {
  const { db } = deps;
  const owners = await db
    .select({ email: schema.users.email, workspace: organisations.name })
    .from(members)
    .innerJoin(schema.users, eq(schema.users.id, members.userId))
    .innerJoin(organisations, eq(organisations.id, members.organisationId))
    .where(inOrg(members, organisationId, eq(members.role, "owner")));
  const [open] = await db
    .select()
    .from(invoices)
    .where(inOrg(invoices, organisationId, eq(invoices.status, "open")))
    .orderBy(desc(invoices.issuedAt))
    .limit(1);
  const suspendAt = new Date(since.getTime() + 21 * 86_400_000);
  const owed = open ? ` of ${formatMoney(open.amountDue - open.amountPaid, open.currency)}` : "";
  const suspended = dunningSteps[step - 1]?.action === "suspend";
  for (const owner of owners) {
    const subject = suspended
      ? `${owner.workspace} is suspended until its payment is made`
      : `${owner.workspace}: a payment${owed} is overdue`;
    await sendEmail(
      deps.mailer,
      owner.email,
      {
        workspace: owner.workspace,
        subject,
        heading: suspended
          ? `${owner.workspace} is suspended: a payment${owed} is 21 days overdue`
          : `A payment${owed} for ${owner.workspace} failed on ${longDate(since)}`,
        body: suspended
          ? [
              "Its members cannot open it until the payment is made. It opens again as soon as it is.",
              "Nothing in it has been deleted.",
            ]
          : [
              `Pay it, or change the card it is taken from, before ${longDate(suspendAt)}. If it is still owed then, the workspace is suspended until it is paid.`,
              "Nothing in the workspace is deleted.",
            ],
        action: { label: "Pay the invoice", url: open?.url ?? billingUrl(deps.publicUrl) },
        foot: "You get this because you own this workspace.",
      },
      organisationId,
    );
  }
}

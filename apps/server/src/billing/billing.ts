import { type Database, inOrg, schema } from "@hekate/db";
import {
  type BillingRules,
  DUNNING_REASON,
  DUNNING_STEPS,
  type DunningRule,
  defaultBillingRules,
  dunningDue,
  dunningReasons,
  dunningStepsOf,
  formatMoney,
  type Invoice,
  type InvoiceStatus,
  type PlanChoice,
  suspendsAt,
  type WorkspaceBilling,
} from "@hekate/shared";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { longDate } from "../email/templates.ts";
import { CodedException, NotFound } from "../errors.ts";
import { recordInstanceEvent } from "../instance-events.ts";
import { type Mailer, sendEmail } from "../mail.ts";
import { assignPlan, workspacePlanOf } from "../plans.ts";
import { workspaceUsageOf } from "../usage.ts";
import type { Fact, Gateway, GatewayEvent, InvoiceFacts } from "./gateway.ts";
import { assertApplies, discountOf, findPromo, releaseHeld, takeHeld, useOf } from "./promos.ts";

const {
  billingAccounts,
  gatewayCustomers,
  invoices,
  gatewayEvents,
  workspacePlans,
  plans,
  organisations,
  members,
} = schema;

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
  /** The instance's billing rules (#180), as its settings hold them now; the defaults if unset. */
  rules?: () => Promise<BillingRules>;
}

/** The rules billing runs by now. */
export const rulesOf = (deps: Pick<BillingDeps, "rules">) =>
  deps.rules ? deps.rules() : Promise.resolve(defaultBillingRules);

export { DUNNING_REASON };

const billingUrl = (publicUrl: string) => new URL("/settings/billing", publicUrl).toString();

const invoiceOf = (row: typeof invoices.$inferSelect): Invoice => ({
  id: row.id,
  source: row.source,
  number: row.number,
  description: row.description,
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
  pdfUrl: row.pdfUrl,
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
  rule: DunningRule = defaultBillingRules.dunning,
): Promise<WorkspaceBilling> {
  const [plan, offered, [account], list, usage] = await Promise.all([
    workspacePlanOf(db, organisationId, true),
    db
      .select()
      .from(plans)
      .where(and(eq(plans.hidden, false), isNull(plans.retiredAt), isNotNull(plans.priceAmount)))
      .orderBy(asc(plans.position), asc(plans.name)),
    db.select().from(billingAccounts).where(inOrg(billingAccounts, organisationId)),
    invoicesOf(db, organisationId),
    workspaceUsageOf(db, organisationId),
  ]);
  // The plan it is on, priced, whether or not it is still offered.
  const [held] = plan.plan ? await db.select().from(plans).where(eq(plans.id, plan.plan.id)) : [];
  // The gateway's copy, read as the page opens; the page still shows without it.
  const customer =
    gateway && account
      ? await gateway.customer(account.customerId).catch((error: unknown) => {
          console.error(`The gateway's details for workspace ${organisationId} failed`, error);
          return null;
        })
      : null;
  return {
    gateway: gateway?.kind ?? null,
    plan,
    current: held ? { ...lineOf(held), price: priceOf(held) } : null,
    plans: offered.flatMap((p) => {
      const price = priceOf(p);
      return price ? [{ ...lineOf(p), price }] : [];
    }),
    subscribed: Boolean(account?.subscriptionId),
    pastDueSince: account?.pastDueSince?.toISOString() ?? null,
    suspendsAt: account?.pastDueSince ? suspendsAt(account.pastDueSince, rule).toISOString() : null,
    invoices: list,
    usage,
    customer,
  };
}

/** A plan as the workspace chooses it: what it gives, beside its price. */
const lineOf = (p: typeof plans.$inferSelect): Omit<PlanChoice, "price"> => ({
  id: p.id,
  key: p.key,
  name: p.name,
  storageQuota: p.storageQuota,
  memberLimit: p.memberLimit,
  projectLimit: p.projectLimit,
  features: p.features,
});

/**
 * Cancel the workspace's subscription at the end of the period it has paid for, or keep it
 * after all (#179). The gateway's webhook confirms it, and the date it ends.
 */
export async function cancelAtPeriodEnd(
  deps: BillingDeps,
  organisationId: string,
  cancel: boolean,
): Promise<void> {
  if (!deps.gateway) throw unavailable();
  const [account] = await deps.db
    .select()
    .from(billingAccounts)
    .where(inOrg(billingAccounts, organisationId));
  if (!account?.subscriptionId)
    throw new CodedException(409, "not_subscribed", "There is no subscription to cancel.");
  await deps.gateway.cancelAtPeriodEnd(account.subscriptionId, cancel);
}

type PlanPrice = { amount: number; currency: string; interval: "month" | "year" };
export const priceOf = (p: typeof plans.$inferSelect): PlanPrice | null =>
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
  input: { organisationId: string; userId: string; planId: string; promoCode?: string },
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
  const [held] = await db
    .select({ id: billingAccounts.id })
    .from(billingAccounts)
    .where(inOrg(billingAccounts, input.organisationId));
  if (!held) await customerFor(deps, input);
  // One change at a time for a workspace: two owners, or a retry, cannot start two checkouts.
  return db.transaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(billingAccounts)
      .where(inOrg(billingAccounts, input.organisationId))
      .for("update");
    if (!account) throw new NotFound("Workspace");
    // The code, held for the change, so its last use cannot go twice.
    const promo = input.promoCode ? await findPromo(tx, input.promoCode) : null;
    if (account.subscriptionId) {
      if (promo) assertApplies(promo, plan.id, price.currency);
      await gateway.changePlan({
        subscriptionId: account.subscriptionId,
        plan: priced,
        discount: promo ? discountOf(promo) : null,
      });
      if (promo)
        await useOf(tx, promo, {
          organisationId: input.organisationId,
          planId: plan.id,
          checkoutId: null,
        });
      // The gateway's webhook confirms it, and puts the workspace on the plan.
      return { url: null };
    }
    if (account.checkoutId) {
      // The checkout already open, for the same plan and code and with time left, is given
      // again; any other is closed first, and the code it held given back, so only one can
      // ever be paid.
      const left = (account.checkoutExpiresAt?.getTime() ?? 0) - Date.now();
      const same =
        account.checkoutPlanId === plan.id && account.checkoutPromoId === (promo?.id ?? null);
      if (same && account.checkoutUrl && left > 10 * 60_000) return { url: account.checkoutUrl };
      if ((await gateway.closeCheckout(account.checkoutId)) === "complete")
        throw new CodedException(
          409,
          "checkout_finishing",
          "A checkout for this workspace has just been paid: its plan arrives in a moment.",
        );
      await releaseHeld(tx, account.checkoutId);
    }
    // Asked again now the old checkout's use is given back.
    const code = promo && input.promoCode ? await findPromo(tx, input.promoCode) : null;
    if (code) assertApplies(code, plan.id, price.currency);
    const current = await workspacePlanOf(tx, input.organisationId, true);
    const url = billingUrl(deps.publicUrl);
    const session = await gateway.checkout({
      organisationId: input.organisationId,
      customerId: account.customerId,
      plan: priced,
      trialEnd:
        current.status === "trial" && current.trialEndsAt ? new Date(current.trialEndsAt) : null,
      discount: code ? discountOf(code) : null,
      successUrl: `${url}?checkout=done`,
      cancelUrl: url,
    });
    if (code)
      await useOf(tx, code, {
        organisationId: input.organisationId,
        planId: plan.id,
        checkoutId: session.id,
      });
    await tx
      .update(billingAccounts)
      .set({
        checkoutId: session.id,
        checkoutPlanId: plan.id,
        checkoutPromoId: code?.id ?? null,
        checkoutUrl: session.url,
        checkoutExpiresAt: session.expiresAt,
        updatedAt: new Date(),
      })
      .where(inOrg(billingAccounts, input.organisationId));
    return { url: session.url };
  });
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
  // request at once finds the rows the first wrote.
  await db.transaction(async (tx) => {
    await tx
      .insert(gatewayCustomers)
      .values({ gateway: gateway.kind, customerId, organisationId: input.organisationId })
      .onConflictDoNothing();
    await tx
      .insert(billingAccounts)
      .values({ organisationId: input.organisationId, gateway: gateway.kind, customerId })
      .onConflictDoNothing();
  });
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
      const outcome = await act(tx, deps.gateway, gateway, event.fact, event.occurredAt);
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

/**
 * Take an event from the Gateway log again (#159's replay), as it was kept: what it means is
 * read afresh, against the subscription or invoice as the gateway holds it now, so taking an
 * old event again never undoes what came after it.
 */
export async function retakeGatewayEvent(
  deps: BillingDeps,
  id: string,
): Promise<{ type: string; organisationId: string | null; result: string }> {
  const gateway = deps.gateway;
  if (!gateway) throw unavailable();
  const [row] = await deps.db.select().from(gatewayEvents).where(eq(gatewayEvents.id, id));
  if (!row) throw new NotFound("Gateway event");
  if (row.gateway !== gateway.kind)
    throw new CodedException(409, "other_gateway", `That event came from ${row.gateway}.`);
  const { result } = await takeGatewayEvent(
    deps,
    gateway.kind,
    {
      id: row.eventId,
      type: row.type,
      occurredAt: row.occurredAt,
      payload: row.payload,
      fact: gateway.factOf(row.payload),
    },
    { again: true },
  );
  const [after] = await deps.db
    .select({ organisationId: gatewayEvents.organisationId })
    .from(gatewayEvents)
    .where(eq(gatewayEvents.id, id));
  return { type: row.type, organisationId: after?.organisationId ?? null, result };
}

interface Outcome {
  organisationId: string | null;
  summary: string | null;
  amount: number | null;
  currency: string | null;
  result: string;
}

/**
 * The billing account of the workspace a gateway's customer is, held for the change. The
 * workspace is found by the gateway and customer the event names, in the one table kept for
 * that, and the account asked of that workspace alone.
 */
async function accountOf(tx: Tx, gateway: Gateway["kind"], customerId: string) {
  const [link] = await tx
    .select({ organisationId: gatewayCustomers.organisationId })
    .from(gatewayCustomers)
    .where(and(eq(gatewayCustomers.gateway, gateway), eq(gatewayCustomers.customerId, customerId)));
  if (!link) return null;
  const [account] = await tx
    .select()
    .from(billingAccounts)
    .where(
      inOrg(
        billingAccounts,
        link.organisationId,
        eq(billingAccounts.gateway, gateway),
        eq(billingAccounts.customerId, customerId),
      ),
    )
    .for("update");
  return account ?? null;
}

async function act(
  tx: Tx,
  connected: Gateway | null,
  gateway: Gateway["kind"],
  fact: Fact,
  at: Date,
): Promise<Outcome> {
  const none = { organisationId: null, summary: null, amount: null, currency: null };
  switch (fact.kind) {
    case "checkout": {
      const account = await accountOf(tx, gateway, fact.customerId);
      // Only the workspace whose customer checked out: the reference alone proves nothing.
      if (account?.organisationId !== fact.organisationId)
        return { ...none, result: "ignored: not this workspace's customer" };
      await tx
        .update(billingAccounts)
        .set({
          subscriptionId: fact.subscriptionId,
          checkoutId: null,
          checkoutPlanId: null,
          checkoutPromoId: null,
          checkoutUrl: null,
          checkoutExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(inOrg(billingAccounts, account.organisationId));
      // The code it held, if any, is now the workspace's.
      await takeHeld(tx, fact.checkoutId);
      return {
        ...none,
        organisationId: account.organisationId,
        summary: "Checkout",
        result: "taken",
      };
    }
    case "subscription": {
      const account = await accountOf(tx, gateway, fact.customerId);
      if (!account) return { ...none, result: "ignored: no workspace is this customer" };
      const organisationId = account.organisationId;
      // Stripe sends a subscription's events in any order: what counts is how it stands stands,
      // asked with the account held, so two at once cannot leave the older standing.
      const stands = (connected && (await connected.subscription(fact.subscriptionId))) || fact;
      const [plan] = stands.planId
        ? await tx.select().from(plans).where(eq(plans.id, stands.planId))
        : [];
      const base = {
        organisationId,
        summary: plan?.name ?? null,
        amount: stands.amount,
        currency: stands.currency,
      };
      if (stands.ended) {
        // An old subscription ending, once the workspace has another, changes nothing.
        if (account.subscriptionId && account.subscriptionId !== stands.subscriptionId)
          return { ...base, result: "ignored: not the workspace's subscription" };
        await tx
          .update(billingAccounts)
          .set({ subscriptionId: null, updatedAt: new Date() })
          .where(inOrg(billingAccounts, organisationId));
      } else if (account.subscriptionId !== stands.subscriptionId)
        await tx
          .update(billingAccounts)
          .set({ subscriptionId: stands.subscriptionId, updatedAt: new Date() })
          .where(inOrg(billingAccounts, organisationId));
      if (!stands.status) return { ...base, result: "taken" };
      const dates = {
        trialEndsAt: stands.trialEndsAt?.toISOString() ?? null,
        renewsAt: stands.ended ? null : (stands.renewsAt?.toISOString() ?? null),
      };
      if (plan)
        await assignPlan(
          tx,
          organisationId,
          { planId: plan.id, status: stands.status, ...dates },
          { retired: true },
        );
      else
        await tx
          .update(workspacePlans)
          .set({
            status: stands.status,
            trialEndsAt: stands.trialEndsAt,
            renewsAt: stands.ended ? null : stands.renewsAt,
            updatedAt: new Date(),
          })
          .where(inOrg(workspacePlans, organisationId));
      // Cancelled at the end of its period: when it ends, for the page to say (#179).
      await tx
        .update(workspacePlans)
        .set({ cancelsAt: stands.cancelsAt })
        .where(inOrg(workspacePlans, organisationId));
      if (stands.status === "past_due") await markPastDue(tx, organisationId, at);
      else if (stands.status === "active" || stands.status === "trial")
        await settle(tx, organisationId);
      return { ...base, result: "taken" };
    }
    case "invoice": {
      const account = await accountOf(tx, gateway, fact.customerId);
      if (!account) return { ...none, result: "ignored: no workspace is this customer" };
      const organisationId = account.organisationId;
      // As it stands now, as a subscription is: an event late or taken again cannot undo what
      // came after it, nor mark a workspace that has paid since as owing.
      // Once the gateway no longer has it (a draft deleted), the event's own word stands.
      const invoice =
        (connected && (await connected.invoice(fact.invoice.gatewayId))) || fact.invoice;
      await keepInvoice(tx, organisationId, invoice);
      const outcome = invoice.status === "paid" ? "paid" : fact.outcome;
      // Only the workspace's own subscription's invoices start or end dunning: not one made by
      // hand in the gateway, nor an old subscription's.
      const ours =
        account.subscriptionId !== null && invoice.subscriptionId === account.subscriptionId;
      if (ours && outcome === "failed") await markPastDue(tx, organisationId, at);
      else if (ours && outcome === "paid") await settle(tx, organisationId);
      return {
        organisationId,
        summary: invoice.number,
        amount: outcome === "paid" ? invoice.amountPaid : invoice.amountDue,
        currency: invoice.currency,
        result: "taken",
      };
    }
    case "checkout_expired": {
      // Lapsed unpaid: the code it held is given back.
      const organisationId = await releaseHeld(tx, fact.checkoutId);
      return { ...none, organisationId, summary: "Checkout lapsed", result: "taken" };
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

export async function keepInvoice(tx: Tx, organisationId: string, facts: InvoiceFacts) {
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
export async function settle(tx: Tx, organisationId: string) {
  const [before] = await tx
    .select({ stage: billingAccounts.dunningStage })
    .from(billingAccounts)
    .where(inOrg(billingAccounts, organisationId));
  await tx
    .update(billingAccounts)
    .set({ pastDueSince: null, dunningStage: 0, noticedStage: 0, updatedAt: new Date() })
    .where(inOrg(billingAccounts, organisationId));
  await tx
    .update(workspacePlans)
    .set({ status: "active", updatedAt: new Date() })
    .where(inOrg(workspacePlans, organisationId, eq(workspacePlans.status, "past_due")));
  if ((before?.stage ?? 0) < DUNNING_STEPS) return;
  const [reopened] = await tx
    .update(organisations)
    .set({ suspendedAt: null, suspendedReason: null, updatedAt: new Date() })
    .where(
      and(
        eq(organisations.id, organisationId),
        inArray(organisations.suspendedReason, [...dunningReasons]),
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
 * Dunning, hourly: each workspace whose payment failed is warned twice and then suspended, on
 * the days the instance's rules set (7, 14 and 21 unless changed), until a payment goes through. A step is claimed in the database before it is
 * taken, so it is taken once; its owners are told after, and told again each hour until the
 * mail goes. Only while the gateway that would settle it is on: with billing off, or another
 * gateway, nothing advances. Returns the steps taken.
 */
export async function runDunning(deps: BillingDeps, now = new Date()): Promise<number> {
  const { db, gateway } = deps;
  if (!gateway) return 0;
  const { dunning } = await rulesOf(deps);
  const due = await db
    .select({
      organisationId: billingAccounts.organisationId,
      pastDueSince: billingAccounts.pastDueSince,
      stage: billingAccounts.dunningStage,
      noticed: billingAccounts.noticedStage,
    })
    .from(billingAccounts)
    // Across workspaces deliberately: the job looks after every one.
    .where(
      and(
        eq(billingAccounts.gateway, gateway.kind),
        isNotNull(billingAccounts.pastDueSince),
        or(
          lt(billingAccounts.dunningStage, DUNNING_STEPS),
          lt(billingAccounts.noticedStage, billingAccounts.dunningStage),
        ),
      ),
    );
  let taken = 0;
  for (const account of due) {
    if (!account.pastDueSince) continue;
    const since = account.pastDueSince;
    let stage = account.stage;
    const step = dunningDue(since, now, stage, dunning);
    if (step !== null && (await takeStep(db, account.organisationId, step, now))) {
      stage = step;
      taken += 1;
    }
    if (account.noticed >= stage) continue;
    try {
      await tellOwners(deps, account.organisationId, since, stage, dunning);
      await db
        .update(billingAccounts)
        .set({ noticedStage: stage, updatedAt: new Date() })
        .where(
          inOrg(
            billingAccounts,
            account.organisationId,
            eq(billingAccounts.dunningStage, stage),
            isNotNull(billingAccounts.pastDueSince),
          ),
        );
    } catch (error) {
      console.error(
        `Dunning mail for workspace ${account.organisationId} failed; it is sent again next hour`,
        error,
      );
    }
  }
  return taken;
}

/** Claim a dunning step and take it: a suspension, at the last. False if it was taken already. */
async function takeStep(db: Database, organisationId: string, step: number, now: Date) {
  return db.transaction(async (tx) => {
    const [claim] = await tx
      .update(billingAccounts)
      .set({ dunningStage: step, updatedAt: new Date() })
      .where(
        inOrg(
          billingAccounts,
          organisationId,
          lt(billingAccounts.dunningStage, step),
          isNotNull(billingAccounts.pastDueSince),
        ),
      )
      .returning({ id: billingAccounts.id });
    if (!claim) return false;
    if (step < DUNNING_STEPS) return true;
    const [suspended] = await tx
      .update(organisations)
      .set({ suspendedAt: now, suspendedReason: DUNNING_REASON, updatedAt: new Date() })
      .where(and(eq(organisations.id, organisationId), isNull(organisations.suspendedAt)))
      .returning({ name: organisations.name });
    if (suspended)
      await recordInstanceEvent(tx, {
        actorId: null,
        action: "workspace.suspended",
        target: suspended.name,
        details: { organisationId, reason: DUNNING_REASON, by: "billing" },
      });
    return true;
  });
}

/** The owners are told each step: what is owed, by when, and that nothing is deleted. */
async function tellOwners(
  deps: BillingDeps,
  organisationId: string,
  since: Date,
  step: number,
  rule: DunningRule,
) {
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
  const suspendAt = new Date(since.getTime() + rule.suspend * 86_400_000);
  const owed = open ? ` of ${formatMoney(open.amountDue - open.amountPaid, open.currency)}` : "";
  const suspended = dunningStepsOf(rule)[step - 1]?.action === "suspend";
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
          ? `${owner.workspace} is suspended: a payment${owed} is ${rule.suspend} days overdue`
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

/**
 * An invoice by hand (#178), for a plan by agreement: numbered in the instance's own series
 * (`HK-0001`), open until an operator marks it paid or void. It is sent outside Hekate, and
 * dunning leaves it to the operators.
 */
export async function invoiceByHand(
  db: Database,
  organisationId: string,
  input: {
    amount: number;
    currency: string;
    description: string;
    periodStart: string | null;
    periodEnd: string | null;
    dueAt: string | null;
  },
): Promise<Invoice> {
  return db.transaction(async (tx) => {
    // One number at a time, so two at once cannot take the same.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hekate:manual-invoices'))`);
    const [counted] = await tx
      .select({ n: count() })
      .from(invoices)
      // Across workspaces deliberately: the series is the instance's.
      .where(eq(invoices.source, "manual"));
    const [made] = await tx
      .insert(invoices)
      .values({
        organisationId,
        source: "manual",
        number: `HK-${String((counted?.n ?? 0) + 1).padStart(4, "0")}`,
        description: input.description,
        status: "open",
        currency: input.currency,
        amountDue: input.amount,
        periodStart: input.periodStart ? new Date(input.periodStart) : null,
        periodEnd: input.periodEnd ? new Date(input.periodEnd) : null,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
        issuedAt: new Date(),
      })
      .returning();
    if (!made) throw new Error("The invoice was not written");
    return invoiceOf(made);
  });
}

/** Settle an open invoice by hand: paid in full, or void. Only one made by hand. */
export async function settleByHand(
  db: Pick<Database, "update">,
  organisationId: string,
  invoiceId: string,
  outcome: "paid" | "void",
): Promise<Invoice> {
  const [done] = await db
    .update(invoices)
    .set({
      status: outcome,
      ...(outcome === "paid" ? { amountPaid: sql`${invoices.amountDue}`, paidAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where(
      inOrg(
        invoices,
        organisationId,
        eq(invoices.id, invoiceId),
        eq(invoices.source, "manual"),
        eq(invoices.status, "open"),
      ),
    )
    .returning();
  if (!done)
    throw new CodedException(
      409,
      "not_open",
      "Only an open invoice made by hand can be settled here.",
    );
  return invoiceOf(done);
}

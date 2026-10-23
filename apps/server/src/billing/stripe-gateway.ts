import type { InvoiceStatus, WorkspacePlanStatus } from "@hekate/shared";
import type { Fact, Gateway, InvoiceFacts, PricedPlan } from "./gateway.ts";
import { type Stripe, StripeError, type StripeEvent, verifyStripeEvent } from "./stripe.ts";

/**
 * Stripe as Hekate's gateway (#178): Checkout for a first payment, the subscription changed in
 * place after that, the customer portal for the card, and its webhooks read into facts. Prices
 * are given with each subscription, against one product per plan whose id Hekate chooses, so
 * nothing about a plan has to be copied into Stripe first.
 */
export function stripeGateway(options: {
  stripe: Stripe;
  webhookSecret: string;
  /** Stripe Tax: tax worked out from the customer's address, collected at checkout. */
  tax: boolean;
}): Gateway {
  const { stripe } = options;
  /** The plan's product, made the first time it is sold and renamed with the plan. */
  const product = async (plan: PricedPlan) => {
    const id = `hekate_${plan.id.replaceAll("-", "")}`;
    const fields = { name: `Hekate ${plan.name}`, metadata: { planId: plan.id } };
    try {
      await stripe.request("POST", "/v1/products", { id, ...fields });
    } catch (error) {
      if (!(error instanceof StripeError) || error.code !== "resource_already_exists") throw error;
      await stripe.request("POST", `/v1/products/${id}`, fields);
    }
    return id;
  };
  const priceData = async (plan: PricedPlan) => ({
    currency: plan.price.currency.toLowerCase(),
    unit_amount: plan.price.amount,
    recurring: { interval: plan.price.interval },
    product: await product(plan),
  });
  return {
    kind: "stripe",
    async createCustomer({ organisationId, name, email }) {
      const customer = await stripe.request<{ id: string }>(
        "POST",
        "/v1/customers",
        { name, email, metadata: { organisationId } },
        // Two owners at once, or a retry, still make one customer.
        { idempotencyKey: `hekate-customer-${organisationId}` },
      );
      return customer.id;
    },
    async checkout({ organisationId, customerId, plan, trialEnd, successUrl, cancelUrl }) {
      const session = await stripe.request<{ url: string }>("POST", "/v1/checkout/sessions", {
        mode: "subscription",
        customer: customerId,
        client_reference_id: organisationId,
        line_items: [{ price_data: await priceData(plan), quantity: 1 }],
        subscription_data: {
          metadata: { organisationId, planId: plan.id },
          // A trial already running ends when it would have; Stripe needs two days' notice.
          trial_end:
            trialEnd && trialEnd.getTime() > Date.now() + 2 * 86_400_000
              ? Math.floor(trialEnd.getTime() / 1000)
              : undefined,
        },
        ...(options.tax
          ? {
              automatic_tax: { enabled: true },
              billing_address_collection: "required",
              customer_update: { address: "auto", name: "auto" },
              tax_id_collection: { enabled: true },
            }
          : {}),
        success_url: successUrl,
        cancel_url: cancelUrl,
      });
      return session.url;
    },
    async changePlan({ subscriptionId, plan }) {
      const subscription = await stripe.request<{ items: { data: { id: string }[] } }>(
        "GET",
        `/v1/subscriptions/${subscriptionId}`,
      );
      const item = subscription.items.data[0];
      if (!item) throw new Error("The subscription has nothing on it");
      await stripe.request("POST", `/v1/subscriptions/${subscriptionId}`, {
        items: [{ id: item.id, price_data: await priceData(plan) }],
        metadata: { planId: plan.id },
        proration_behavior: "create_prorations",
      });
    },
    async portal({ customerId, returnUrl }) {
      const session = await stripe.request<{ url: string }>("POST", "/v1/billing_portal/sessions", {
        customer: customerId,
        return_url: returnUrl,
      });
      return session.url;
    },
    read(body, header) {
      const event = verifyStripeEvent(body, header("stripe-signature"), options.webhookSecret);
      return {
        id: event.id,
        type: event.type,
        occurredAt: new Date(event.created * 1000),
        payload: event,
        fact: stripeFact(event),
      };
    },
  };
}

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const time = (v: unknown) => {
  const n = num(v);
  return n === null ? null : new Date(n * 1000);
};
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
/** A field that is an id, or an object with one (when Stripe expanded it). */
const idOf = (v: unknown) => str(v) ?? str(obj(v).id);
const firstOf = (list: unknown): Obj => obj((obj(list).data as unknown[] | undefined)?.[0]);

/** Where a Stripe subscription leaves the workspace's plan; null for a state that changes none. */
export function planStatusOf(status: unknown): WorkspacePlanStatus | null {
  switch (status) {
    case "trialing":
      return "trial";
    case "active":
      return "active";
    case "past_due":
    case "unpaid":
    // A trial that ended without a card.
    case "paused":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "cancelled";
    default:
      return null;
  }
}

const invoiceStatuses: InvoiceStatus[] = ["draft", "open", "paid", "void", "uncollectible"];

/** What a Stripe event means here. Pure: what it reads is what the event carries. */
export function stripeFact(event: StripeEvent): Fact {
  const o = event.data.object;
  if (event.type === "checkout.session.completed") {
    const organisationId = str(o.client_reference_id);
    const customerId = idOf(o.customer);
    const subscriptionId = idOf(o.subscription);
    if (o.mode !== "subscription" || !organisationId || !customerId || !subscriptionId)
      return { kind: "other" };
    return { kind: "checkout", organisationId, customerId, subscriptionId };
  }
  if (event.type.startsWith("customer.subscription.")) {
    const customerId = idOf(o.customer);
    const subscriptionId = str(o.id);
    if (!customerId || !subscriptionId) return { kind: "other" };
    const item = firstOf(o.items);
    const price = obj(item.price);
    const ended = event.type === "customer.subscription.deleted";
    return {
      kind: "subscription",
      customerId,
      subscriptionId,
      planId: str(obj(o.metadata).planId),
      status: ended ? "cancelled" : planStatusOf(o.status),
      trialEndsAt: time(o.trial_end),
      // Kept on the item from 2025's API versions, on the subscription before.
      renewsAt: time(item.current_period_end) ?? time(o.current_period_end),
      ended,
      amount: num(price.unit_amount),
      currency: str(price.currency)?.toUpperCase() ?? null,
    };
  }
  if (event.type.startsWith("invoice.")) {
    const customerId = idOf(o.customer);
    const gatewayId = str(o.id);
    const issuedAt = time(o.created);
    if (!customerId || !gatewayId || !issuedAt) return { kind: "other" };
    const line = obj(firstOf(o.lines).period);
    const status = invoiceStatuses.find((s) => s === o.status) ?? "open";
    const invoice: InvoiceFacts = {
      gatewayId,
      number: str(o.number),
      status,
      currency: (str(o.currency) ?? "gbp").toUpperCase(),
      amountDue: num(o.amount_due) ?? 0,
      amountPaid: num(o.amount_paid) ?? 0,
      periodStart: time(line.start) ?? time(o.period_start),
      periodEnd: time(line.end) ?? time(o.period_end),
      issuedAt,
      dueAt: time(o.due_date),
      paidAt: time(obj(o.status_transitions).paid_at),
      url: str(o.hosted_invoice_url),
    };
    const outcome =
      event.type === "invoice.paid"
        ? "paid"
        : event.type === "invoice.payment_failed"
          ? "failed"
          : null;
    return { kind: "invoice", customerId, invoice, outcome };
  }
  if (event.type.startsWith("payout.")) {
    const amount = num(o.amount);
    const currency = str(o.currency);
    if (amount === null || !currency) return { kind: "other" };
    return { kind: "payout", amount, currency: currency.toUpperCase() };
  }
  return { kind: "other" };
}

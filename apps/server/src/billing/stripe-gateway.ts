import type { InvoiceStatus, WorkspacePlanStatus } from "@hekate/shared";
import type {
  Discount,
  Fact,
  Gateway,
  InvoiceFacts,
  PricedPlan,
  SubscriptionFact,
} from "./gateway.ts";
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
  /**
   * The code's coupon, made the first time it is used. A coupon's terms never change in Stripe,
   * so its id carries them: a code whose terms are changed gets a new one, and subscriptions
   * that had the old keep what they were given.
   */
  const coupon = async (discount: Discount) => {
    const terms =
      discount.percentOff !== null
        ? `p${discount.percentOff}`
        : `a${discount.amountOff}${discount.currency?.toLowerCase()}`;
    const id = `hekate_${discount.promoId.replaceAll("-", "")}_${terms}_m${discount.months ?? "f"}`;
    try {
      await stripe.request("POST", "/v1/coupons", {
        id,
        name: discount.code,
        ...(discount.percentOff !== null
          ? { percent_off: discount.percentOff }
          : { amount_off: discount.amountOff, currency: discount.currency?.toLowerCase() }),
        ...(discount.months === null
          ? { duration: "forever" }
          : discount.months === 1
            ? { duration: "once" }
            : { duration: "repeating", duration_in_months: discount.months }),
        metadata: { promoId: discount.promoId },
      });
    } catch (error) {
      if (!(error instanceof StripeError) || error.code !== "resource_already_exists") throw error;
    }
    return id;
  };
  const invoiceAt = async (invoiceId: string) => {
    const invoice = await gone(
      stripe.request<Record<string, unknown>>("GET", `/v1/invoices/${invoiceId}`),
    );
    if (!invoice) return null;
    const facts = invoiceFacts(invoice);
    if (!facts) throw new Error(`Stripe's invoice ${invoiceId} cannot be read`);
    return facts.invoice;
  };
  const priceData = async (plan: PricedPlan) => ({
    currency: plan.price.currency.toLowerCase(),
    unit_amount: plan.price.amount,
    recurring: { interval: plan.price.interval },
    product: await product(plan),
  });
  return {
    kind: "stripe",
    tax: options.tax,
    async account() {
      const account = await gone(stripe.request<Record<string, unknown>>("GET", "/v1/account"));
      const id = str(account?.id);
      if (!account || !id) return null;
      const profile = obj(account.business_profile);
      const settings = obj(obj(account.settings).dashboard);
      return { id, name: str(profile.name) ?? str(settings.display_name) };
    },
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
    async checkout({
      organisationId,
      customerId,
      plan,
      trialEnd,
      discount,
      successUrl,
      cancelUrl,
    }) {
      const session = await stripe.request<{ id: string; url: string; expires_at: number }>(
        "POST",
        "/v1/checkout/sessions",
        {
          mode: "subscription",
          customer: customerId,
          client_reference_id: organisationId,
          line_items: [{ price_data: await priceData(plan), quantity: 1 }],
          ...(discount ? { discounts: [{ coupon: await coupon(discount) }] } : {}),
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
        },
      );
      return { id: session.id, url: session.url, expiresAt: new Date(session.expires_at * 1000) };
    },
    async closeCheckout(id) {
      const session = await stripe.request<{ status: string }>(
        "GET",
        `/v1/checkout/sessions/${id}`,
      );
      if (session.status === "complete") return "complete";
      if (session.status === "open")
        await stripe.request("POST", `/v1/checkout/sessions/${id}/expire`);
      return "closed";
    },
    async subscription(subscriptionId) {
      const subscription = await gone(
        stripe.request<Record<string, unknown>>("GET", `/v1/subscriptions/${subscriptionId}`),
      );
      if (!subscription) return null;
      const fact = subscriptionFact(subscription, subscription.status === "canceled");
      if (!fact) throw new Error(`Stripe's subscription ${subscriptionId} cannot be read`);
      return fact;
    },
    async changePlan({ subscriptionId, plan, discount }) {
      const subscription = await stripe.request<{ items: { data: { id: string }[] } }>(
        "GET",
        `/v1/subscriptions/${subscriptionId}`,
      );
      const item = subscription.items.data[0];
      if (!item) throw new Error("The subscription has nothing on it");
      await stripe.request("POST", `/v1/subscriptions/${subscriptionId}`, {
        items: [{ id: item.id, price_data: await priceData(plan) }],
        metadata: { planId: plan.id },
        ...(discount ? { discounts: [{ coupon: await coupon(discount) }] } : {}),
        proration_behavior: "create_prorations",
      });
    },
    invoice: invoiceAt,
    async voidInvoice(invoiceId) {
      const now = await invoiceAt(invoiceId);
      if (now?.status !== "open") return now;
      const voided = await stripe.request<Record<string, unknown>>(
        "POST",
        `/v1/invoices/${invoiceId}/void`,
      );
      return invoiceFacts(voided)?.invoice ?? null;
    },
    async nextPayout() {
      const { data } = await stripe.request<{ data: Record<string, unknown>[] }>(
        "GET",
        "/v1/payouts",
        { status: "pending", limit: 20 },
      );
      const [soonest] = data
        .map((p) => ({
          amount: num(p.amount),
          currency: str(p.currency),
          at: time(p.arrival_date),
        }))
        .filter((p) => p.amount !== null && p.currency && p.at)
        .sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
      return soonest?.at
        ? {
            amount: soonest.amount ?? 0,
            currency: (soonest.currency ?? "").toUpperCase(),
            arrivesAt: soonest.at,
          }
        : null;
    },
    factOf: (payload) => stripeFact(payload as StripeEvent),
    async cancelAtPeriodEnd(subscriptionId, cancel) {
      await stripe.request("POST", `/v1/subscriptions/${subscriptionId}`, {
        cancel_at_period_end: cancel,
      });
    },
    async customer(customerId) {
      const customer = await gone(
        stripe.request<Record<string, unknown>>("GET", `/v1/customers/${customerId}`, {
          expand: ["invoice_settings.default_payment_method", "tax_ids"],
        }),
      );
      if (!customer || customer.deleted) return null;
      const address = obj(customer.address);
      const card = obj(obj(obj(customer.invoice_settings).default_payment_method).card);
      const line = [
        address.line1,
        address.line2,
        address.city,
        address.postal_code,
        address.state,
        address.country,
      ]
        .map(str)
        .filter(Boolean)
        .join(", ");
      return {
        name: str(customer.name),
        email: str(customer.email),
        address: line || null,
        taxIds: ((obj(customer.tax_ids).data as unknown[] | undefined) ?? [])
          .map((t) => str(obj(t).value))
          .filter((v): v is string => v !== null),
        card:
          str(card.last4) && num(card.exp_month) !== null && num(card.exp_year) !== null
            ? {
                brand: str(card.brand) ?? "card",
                last4: str(card.last4) ?? "",
                expMonth: num(card.exp_month) ?? 0,
                expYear: num(card.exp_year) ?? 0,
              }
            : null,
      };
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

/** What Stripe holds, or null when it holds it no longer (404, `resource_missing`). */
const gone = <T>(request: Promise<T>): Promise<T | null> =>
  request.catch((error: unknown) => {
    if (error instanceof StripeError && error.status === 404) return null;
    throw error;
  });

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

/** A Stripe subscription, read here. */
function subscriptionFact(o: Obj, ended: boolean): SubscriptionFact | null {
  const customerId = idOf(o.customer);
  const subscriptionId = str(o.id);
  if (!customerId || !subscriptionId) return null;
  const item = firstOf(o.items);
  const price = obj(item.price);
  return {
    kind: "subscription",
    customerId,
    subscriptionId,
    planId: str(obj(o.metadata).planId),
    status: ended ? "cancelled" : planStatusOf(o.status),
    trialEndsAt: time(o.trial_end),
    // Kept on the item from 2025's API versions, on the subscription before.
    renewsAt: time(item.current_period_end) ?? time(o.current_period_end),
    cancelsAt: ended
      ? null
      : o.cancel_at_period_end === true
        ? (time(item.current_period_end) ?? time(o.current_period_end))
        : time(o.cancel_at),
    ended,
    amount: num(price.unit_amount),
    currency: str(price.currency)?.toUpperCase() ?? null,
  };
}

/** A Stripe invoice, read here, with the customer it is for. */
function invoiceFacts(o: Obj): { customerId: string; invoice: InvoiceFacts } | null {
  const customerId = idOf(o.customer);
  const gatewayId = str(o.id);
  const issuedAt = time(o.created);
  if (!customerId || !gatewayId || !issuedAt) return null;
  const line = obj(firstOf(o.lines).period);
  return {
    customerId,
    invoice: {
      gatewayId,
      // Under its parent from 2025's API versions, on the invoice before.
      subscriptionId:
        idOf(obj(obj(o.parent).subscription_details).subscription) ?? idOf(o.subscription),
      number: str(o.number),
      status: invoiceStatuses.find((s) => s === o.status) ?? "open",
      currency: (str(o.currency) ?? "gbp").toUpperCase(),
      amountDue: num(o.amount_due) ?? 0,
      amountPaid: num(o.amount_paid) ?? 0,
      periodStart: time(line.start) ?? time(o.period_start),
      periodEnd: time(line.end) ?? time(o.period_end),
      issuedAt,
      dueAt: time(o.due_date),
      paidAt: time(obj(o.status_transitions).paid_at),
      url: str(o.hosted_invoice_url),
      pdfUrl: str(o.invoice_pdf),
    },
  };
}

/** What a Stripe event means here. Pure: what it reads is what the event carries. */
export function stripeFact(event: StripeEvent): Fact {
  const o = event.data.object;
  if (event.type === "checkout.session.completed") {
    const checkoutId = str(o.id);
    const organisationId = str(o.client_reference_id);
    const customerId = idOf(o.customer);
    const subscriptionId = idOf(o.subscription);
    if (
      o.mode !== "subscription" ||
      !checkoutId ||
      !organisationId ||
      !customerId ||
      !subscriptionId
    )
      return { kind: "other" };
    return { kind: "checkout", checkoutId, organisationId, customerId, subscriptionId };
  }
  if (event.type === "checkout.session.expired") {
    const checkoutId = str(o.id);
    return checkoutId ? { kind: "checkout_expired", checkoutId } : { kind: "other" };
  }
  if (event.type.startsWith("customer.subscription."))
    return subscriptionFact(o, event.type === "customer.subscription.deleted") ?? { kind: "other" };
  if (event.type.startsWith("invoice.")) {
    const read = invoiceFacts(o);
    if (!read) return { kind: "other" };
    const outcome =
      event.type === "invoice.paid"
        ? "paid"
        : event.type === "invoice.payment_failed"
          ? "failed"
          : null;
    return { kind: "invoice", ...read, outcome };
  }
  if (event.type.startsWith("payout.")) {
    const amount = num(o.amount);
    const currency = str(o.currency);
    if (amount === null || !currency) return { kind: "other" };
    return { kind: "payout", amount, currency: currency.toUpperCase() };
  }
  return { kind: "other" };
}

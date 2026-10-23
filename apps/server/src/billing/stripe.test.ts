import { describe, expect, it } from "vitest";
import {
  formEncode,
  type Stripe,
  StripeError,
  type StripeEvent,
  signStripeEvent,
  stripeClient,
  Unsigned,
  verifyStripeEvent,
} from "./stripe.ts";
import { planStatusOf, stripeFact, stripeGateway } from "./stripe-gateway.ts";

const secret = "whsec_test_secret";
const event = (type: string, object: Record<string, unknown>): StripeEvent => ({
  id: `evt_${type}`,
  type,
  created: 1_792_000_000,
  livemode: false,
  data: { object },
});

describe("Stripe's API (#178)", () => {
  it("encodes nested parameters as Stripe reads them, leaving out what is empty", () => {
    const form = formEncode({
      mode: "subscription",
      line_items: [{ price_data: { currency: "gbp", unit_amount: 4900 }, quantity: 1 }],
      subscription_data: { metadata: { planId: "p" }, trial_end: undefined },
      automatic_tax: { enabled: true },
      nothing: null,
    });
    expect([...form.entries()]).toEqual([
      ["mode", "subscription"],
      ["line_items[0][price_data][currency]", "gbp"],
      ["line_items[0][price_data][unit_amount]", "4900"],
      ["line_items[0][quantity]", "1"],
      ["subscription_data[metadata][planId]", "p"],
      ["automatic_tax[enabled]", "true"],
    ]);
  });

  it("sends the key and the pinned version, and says what Stripe refused", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = stripeClient({
      secretKey: "sk_test_abc",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({ error: { message: "No such customer", code: "resource_missing" } }),
          { status: 404 },
        );
      },
    });
    const refused = await client
      .request("POST", "/v1/customers", { name: "Endless Hall Records" }, { idempotencyKey: "k" })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(StripeError);
    expect(refused).toMatchObject({ status: 404, code: "resource_missing" });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers).toMatchObject({
      authorization: "Bearer sk_test_abc",
      "stripe-version": "2025-09-30.clover",
      "idempotency-key": "k",
    });
    expect(calls[0]?.init.body).toBe("name=Endless+Hall+Records");
  });

  it("takes a webhook only when its signature holds and is fresh", () => {
    const body = JSON.stringify(event("invoice.paid", { id: "in_1" }));
    const now = Date.now();
    expect(verifyStripeEvent(body, signStripeEvent(body, secret, now), secret, now).id).toBe(
      "evt_invoice.paid",
    );
    // While a secret is rolled, Stripe signs with both: either may hold.
    const both = `${signStripeEvent(body, "whsec_old", now)},v1=${signStripeEvent(body, secret, now).split("v1=")[1]}`;
    expect(verifyStripeEvent(body, both, secret, now).type).toBe("invoice.paid");
    for (const header of [
      undefined,
      "t=1,v0=abc",
      signStripeEvent(body, "whsec_other", now),
      signStripeEvent(`${body} `, secret, now),
      signStripeEvent(body, secret, now - 10 * 60_000),
    ])
      expect(() => verifyStripeEvent(body, header, secret, now)).toThrow(Unsigned);
  });
});

describe("Stripe's events, read here (#178)", () => {
  it("reads a subscription in 2025's shape, its period on the item", () => {
    const fact = stripeFact(
      event("customer.subscription.updated", {
        id: "sub_1",
        customer: "cus_1",
        status: "trialing",
        trial_end: 1_793_000_000,
        metadata: { planId: "plan-1", organisationId: "org-1" },
        items: {
          data: [
            { current_period_end: 1_794_000_000, price: { unit_amount: 4900, currency: "gbp" } },
          ],
        },
      }),
    );
    expect(fact).toEqual({
      kind: "subscription",
      customerId: "cus_1",
      subscriptionId: "sub_1",
      planId: "plan-1",
      status: "trial",
      trialEndsAt: new Date(1_793_000_000_000),
      renewsAt: new Date(1_794_000_000_000),
      ended: false,
      amount: 4900,
      currency: "GBP",
    });
    expect(
      stripeFact(event("customer.subscription.deleted", { id: "sub_1", customer: "cus_1" })),
    ).toMatchObject({ status: "cancelled", ended: true });
  });

  it("reads an invoice, its period from its line, and what came of it", () => {
    const fact = stripeFact(
      event("invoice.payment_failed", {
        id: "in_1",
        customer: { id: "cus_1" },
        number: "INV-0401",
        status: "open",
        currency: "gbp",
        amount_due: 4900,
        amount_paid: 0,
        created: 1_792_000_000,
        lines: { data: [{ period: { start: 1_792_000_000, end: 1_794_600_000 } }] },
        hosted_invoice_url: "https://invoice.stripe.com/i/abc",
        parent: { subscription_details: { subscription: "sub_1" } },
      }),
    );
    expect(fact).toMatchObject({
      kind: "invoice",
      customerId: "cus_1",
      outcome: "failed",
      invoice: {
        gatewayId: "in_1",
        subscriptionId: "sub_1",
        number: "INV-0401",
        status: "open",
        currency: "GBP",
        amountDue: 4900,
        periodEnd: new Date(1_794_600_000_000),
        url: "https://invoice.stripe.com/i/abc",
      },
    });
  });

  it("reads a checkout only for a subscription, and anything else as nothing to do", () => {
    expect(
      stripeFact(
        event("checkout.session.completed", {
          mode: "subscription",
          client_reference_id: "org-1",
          customer: "cus_1",
          subscription: "sub_1",
        }),
      ),
    ).toEqual({
      kind: "checkout",
      organisationId: "org-1",
      customerId: "cus_1",
      subscriptionId: "sub_1",
    });
    expect(stripeFact(event("checkout.session.completed", { mode: "payment" }))).toEqual({
      kind: "other",
    });
    expect(stripeFact(event("payout.paid", { amount: 118_000, currency: "gbp" }))).toEqual({
      kind: "payout",
      amount: 118_000,
      currency: "GBP",
    });
    expect(stripeFact(event("charge.refunded", {}))).toEqual({ kind: "other" });
    expect([planStatusOf("unpaid"), planStatusOf("incomplete")]).toEqual(["past_due", null]);
  });

  it("checks out with the plan's price against its own product, and changes a plan in place", async () => {
    const calls: [string, string, Record<string, unknown>][] = [];
    const stripe: Stripe = {
      async request(method, path, params = {}) {
        calls.push([method, path, params]);
        if (path === "/v1/products")
          throw new StripeError(400, "Product already exists.", "resource_already_exists");
        if (path === "/v1/checkout/sessions")
          return {
            id: "cs_abc",
            url: "https://checkout.stripe.com/c/abc",
            expires_at: 1_792_086_400,
          } as never;
        if (method === "GET") return { items: { data: [{ id: "si_1" }] } } as never;
        return {} as never;
      },
    };
    const gateway = stripeGateway({ stripe, webhookSecret: secret, tax: true });
    const plan = {
      id: "0199a1b2-0000-7000-8000-000000000001",
      name: "Studio",
      price: { amount: 4900, currency: "GBP", interval: "month" as const },
    };
    const session = await gateway.checkout({
      organisationId: "org-1",
      customerId: "cus_1",
      plan,
      trialEnd: null,
      successUrl: "https://review.example/settings/billing?checkout=done",
      cancelUrl: "https://review.example/settings/billing",
    });
    expect(session).toEqual({
      id: "cs_abc",
      url: "https://checkout.stripe.com/c/abc",
      expiresAt: new Date(1_792_086_400_000),
    });
    const product = "hekate_0199a1b2000070008000000000000001";
    expect(calls.map(([m, p]) => `${m} ${p}`)).toEqual([
      "POST /v1/products",
      `POST /v1/products/${product}`,
      "POST /v1/checkout/sessions",
    ]);
    expect(calls[2]?.[2]).toMatchObject({
      mode: "subscription",
      customer: "cus_1",
      client_reference_id: "org-1",
      line_items: [
        {
          price_data: {
            currency: "gbp",
            unit_amount: 4900,
            recurring: { interval: "month" },
            product,
          },
        },
      ],
      subscription_data: { metadata: { organisationId: "org-1", planId: plan.id } },
      automatic_tax: { enabled: true },
    });
    calls.length = 0;
    await gateway.changePlan({ subscriptionId: "sub_1", plan });
    expect(calls.at(-1)).toEqual([
      "POST",
      "/v1/subscriptions/sub_1",
      {
        items: [{ id: "si_1", price_data: expect.objectContaining({ product }) }],
        metadata: { planId: plan.id },
        proration_behavior: "create_prorations",
      },
    ]);
  });
});

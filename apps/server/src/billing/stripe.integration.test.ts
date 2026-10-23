import { createDb, inOrg, runMigrations, schema, uuidv7 } from "@hekate/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memoryMailer } from "../mail.ts";
import { type BillingDeps, DUNNING_REASON, runDunning, takeGatewayEvent } from "./billing.ts";
import { type StripeEvent, stripeClient } from "./stripe.ts";
import { stripeFact, stripeGateway } from "./stripe-gateway.ts";

/**
 * Against Stripe's test mode itself (#178): a test clock drives a trial to conversion, then a
 * failed payment to suspension. Runs where STRIPE_TEST_SECRET_KEY holds a test-mode key and a
 * database is given; a test cannot receive webhooks, so the events are read back from Stripe's
 * event list and taken as a webhook's would be.
 */
const key = process.env.STRIPE_TEST_SECRET_KEY;
const url = process.env.DATABASE_URL;
const day = 86_400_000;

describe.runIf(key && url)("Stripe, on a test clock (#178)", () => {
  const { db, close } = createDb(url ?? "", { max: 3 });
  const stripe = stripeClient({ secretKey: key ?? "" });
  const deps: BillingDeps = {
    db,
    gateway: stripeGateway({ stripe, webhookSecret: "whsec_unused", tax: false }),
    mailer: memoryMailer(),
    publicUrl: "https://review.example",
  };
  let clock = "";
  const started = Math.floor(Date.now() / 1000) - 5;

  beforeAll(async () => {
    await runMigrations(url ?? "");
  });
  afterAll(async () => {
    // Deleting the clock deletes its customer and subscription with it.
    if (clock) await stripe.request("DELETE", `/v1/test_helpers/test_clocks/${clock}`);
    await close();
  });

  /** Move the clock on, and wait until Stripe has done all that falls due meanwhile. */
  const advance = async (to: number) => {
    await stripe.request("POST", `/v1/test_helpers/test_clocks/${clock}/advance`, {
      frozen_time: to,
    });
    for (let i = 0; i < 90; i++) {
      const state = await stripe.request<{ status: string }>(
        "GET",
        `/v1/test_helpers/test_clocks/${clock}`,
      );
      if (state.status === "ready") return;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error("The test clock did not finish advancing");
  };
  const taken = new Set<string>();
  /** Take every event about the customer not yet taken, oldest first. */
  const pump = async (customer: string) => {
    const events: StripeEvent[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await stripe.request<{ data: StripeEvent[]; has_more: boolean }>(
        "GET",
        "/v1/events",
        { "created[gte]": started, limit: 100, starting_after: after },
      );
      events.push(...page.data);
      if (!page.has_more) break;
      after = page.data.at(-1)?.id;
    }
    const ours = events
      .filter((e) => {
        const o = e.data.object;
        return o.customer === customer || o.id === customer;
      })
      .filter((e) => !taken.has(e.id))
      .sort((a, b) => a.created - b.created);
    for (const event of ours) {
      taken.add(event.id);
      await takeGatewayEvent(deps, "stripe", {
        id: event.id,
        type: event.type,
        occurredAt: new Date(event.created * 1000),
        payload: event,
        fact: stripeFact(event),
      });
    }
  };

  it(
    "converts a trial, then suspends the workspace whose payment fails",
    async () => {
      const [org] = await db
        .insert(schema.organisations)
        .values({ name: "Endless Hall Records", slug: `stripe-${uuidv7()}` })
        .returning();
      const organisationId = org?.id ?? "";
      const [plan] = await db
        .insert(schema.plans)
        .values({
          key: `studio-${uuidv7().slice(-8)}`,
          name: "Studio",
          priceAmount: 4900,
          interval: "month",
          memberLimit: 25,
          features: ["sso"],
          severities: ["low", "normal"],
        })
        .returning();
      const now = Math.floor(Date.now() / 1000);
      clock = (
        await stripe.request<{ id: string }>("POST", "/v1/test_helpers/test_clocks", {
          frozen_time: now,
          name: "Hekate billing test",
        })
      ).id;
      const customer = (
        await stripe.request<{ id: string }>("POST", "/v1/customers", {
          name: "Endless Hall Records",
          email: "billing@example.test",
          test_clock: clock,
          payment_method: "pm_card_visa",
          invoice_settings: { default_payment_method: "pm_card_visa" },
          metadata: { organisationId },
        })
      ).id;
      await db
        .insert(schema.billingAccounts)
        .values({ organisationId, gateway: "stripe", customerId: customer });
      const product = (
        await stripe.request<{ id: string }>("POST", "/v1/products", { name: "Hekate Studio" })
      ).id;
      // As Checkout would make it: the plan's price, a week's trial, the plan in its metadata.
      await stripe.request("POST", "/v1/subscriptions", {
        customer,
        items: [
          {
            price_data: {
              currency: "gbp",
              unit_amount: 4900,
              recurring: { interval: "month" },
              product,
            },
          },
        ],
        trial_period_days: 7,
        metadata: { organisationId, planId: plan?.id },
      });
      const status = async () =>
        (
          await db
            .select({ status: schema.workspacePlans.status })
            .from(schema.workspacePlans)
            .where(inOrg(schema.workspacePlans, organisationId))
        )[0]?.status;

      await pump(customer);
      expect(await status()).toBe("trial");

      // The trial ends and the card pays.
      await advance(now + (8 * day) / 1000);
      await pump(customer);
      expect(await status()).toBe("active");
      const paid = await db
        .select()
        .from(schema.invoices)
        .where(inOrg(schema.invoices, organisationId, eq(schema.invoices.status, "paid")));
      expect(paid.some((i) => i.amountPaid === 4900)).toBe(true);

      // The card fails at the next renewal.
      const failing = await stripe.request<{ id: string }>(
        "POST",
        "/v1/payment_methods/pm_card_chargeCustomerFail/attach",
        { customer },
      );
      await stripe.request("POST", `/v1/customers/${customer}`, {
        invoice_settings: { default_payment_method: failing.id },
      });
      const renewal = now + (40 * day) / 1000;
      await advance(renewal);
      await pump(customer);
      expect(await status()).toBe("past_due");
      const [account] = await db
        .select()
        .from(schema.billingAccounts)
        .where(inOrg(schema.billingAccounts, organisationId));
      expect(account?.pastDueSince).not.toBeNull();

      // Three weeks on, still unpaid: suspended, and nothing deleted.
      await runDunning(deps, new Date((account?.pastDueSince?.getTime() ?? 0) + 22 * day));
      const [after] = await db
        .select()
        .from(schema.organisations)
        .where(eq(schema.organisations.id, organisationId));
      expect(after).toMatchObject({ suspendedReason: DUNNING_REASON, deleteAfter: null });
    },
    10 * 60_000,
  );
});

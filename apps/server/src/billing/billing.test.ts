import { createDb, inOrg, runMigrations, schema, uuidv7 } from "@hekate/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memoryMailer } from "../mail.ts";
import {
  type BillingDeps,
  billingOf,
  changePlan,
  DUNNING_REASON,
  runDunning,
  takeGatewayEvent,
} from "./billing.ts";
import { type Stripe, signStripeEvent } from "./stripe.ts";
import { stripeGateway } from "./stripe-gateway.ts";

const url = process.env.DATABASE_URL;
const secret = "whsec_billing_tests";
const day = 86_400_000;

describe.runIf(url)("billing (#178)", () => {
  const { db, close } = createDb(url ?? "", { max: 3 });
  const mailer = memoryMailer();
  const calls: [string, string, Record<string, unknown>][] = [];
  const stripe: Stripe = {
    async request(method, path, params = {}) {
      calls.push([method, path, params]);
      if (path === "/v1/customers") return { id: `cus_${uuidv7().slice(-12)}` } as never;
      if (path === "/v1/checkout/sessions")
        return { url: "https://checkout.stripe.com/c/x" } as never;
      if (method === "GET") return { items: { data: [{ id: "si_1" }] } } as never;
      return {} as never;
    },
  };
  const gateway = stripeGateway({ stripe, webhookSecret: secret, tax: false });
  const deps: BillingDeps = { db, gateway, mailer, publicUrl: "https://review.example" };

  beforeAll(async () => {
    await runMigrations(url ?? "");
  });
  afterAll(async () => {
    await close();
  });

  /** A workspace with an owner, a priced plan, and the owner's id. */
  const workspace = async () => {
    const [org] = await db
      .insert(schema.organisations)
      .values({ name: "Endless Hall Records", slug: `billing-${uuidv7()}` })
      .returning();
    const userId = uuidv7();
    const email = `owner-${userId}@example.test`;
    await db.insert(schema.users).values({ id: userId, name: "Mira Solberg", email });
    await db
      .insert(schema.members)
      .values({ organisationId: org?.id ?? "", userId, role: "owner" });
    const [plan] = await db
      .insert(schema.plans)
      .values({
        key: `studio-${uuidv7().slice(-8)}`,
        name: "Studio",
        priceAmount: 4900,
        interval: "month",
        storageQuota: 1e12,
        memberLimit: 25,
        features: ["sso"],
        severities: ["low", "normal"],
      })
      .returning();
    return { id: org?.id ?? "", userId, email, planId: plan?.id ?? "" };
  };
  /** Send an event as Stripe would, through the gateway's own reading of it. */
  const send = (type: string, object: Record<string, unknown>, at = new Date(), id = uuidv7()) => {
    const body = JSON.stringify({
      id: `evt_${id}`,
      type,
      created: Math.floor(at.getTime() / 1000),
      livemode: false,
      data: { object },
    });
    const header = signStripeEvent(body, secret);
    return takeGatewayEvent(
      deps,
      "stripe",
      gateway.read(body, () => header),
    );
  };
  const subscription = (
    customer: string,
    planId: string,
    status: string,
    extra: Record<string, unknown> = {},
  ) => ({
    id: "sub_1",
    customer,
    status,
    metadata: { planId },
    items: {
      data: [{ current_period_end: 1_794_000_000, price: { unit_amount: 4900, currency: "gbp" } }],
    },
    ...extra,
  });
  // Stripe's ids are its own across every account: one invoice per customer here.
  const invoice = (customer: string, status: string, extra: Record<string, unknown> = {}) => ({
    id: `in_${customer}`,
    customer,
    number: "INV-0412",
    status,
    currency: "gbp",
    amount_due: 4900,
    amount_paid: status === "paid" ? 4900 : 0,
    created: 1_792_000_000,
    hosted_invoice_url: "https://invoice.stripe.com/i/abc",
    ...extra,
  });
  const account = async (id: string) =>
    (await db.select().from(schema.billingAccounts).where(inOrg(schema.billingAccounts, id)))[0];
  const organisation = async (id: string) =>
    (await db.select().from(schema.organisations).where(eq(schema.organisations.id, id)))[0];

  it("checks out once, as one customer, then changes the plan in place", async () => {
    const w = await workspace();
    calls.length = 0;
    const first = await changePlan(deps, {
      organisationId: w.id,
      userId: w.userId,
      planId: w.planId,
    });
    expect(first.url).toBe("https://checkout.stripe.com/c/x");
    const customer = calls.find(([, p]) => p === "/v1/customers")?.[2];
    expect(customer).toMatchObject({ name: "Endless Hall Records", email: w.email });
    const held = await account(w.id);
    expect(held?.customerId).toMatch(/^cus_/);

    // A second try before paying reuses the customer.
    calls.length = 0;
    await changePlan(deps, { organisationId: w.id, userId: w.userId, planId: w.planId });
    expect(calls.some(([, p]) => p === "/v1/customers")).toBe(false);

    // Checked out: the subscription is the workspace's, and its plan arrives with it.
    await send("checkout.session.completed", {
      mode: "subscription",
      client_reference_id: w.id,
      customer: held?.customerId,
      subscription: "sub_1",
    });
    await send(
      "customer.subscription.created",
      subscription(held?.customerId ?? "", w.planId, "active"),
    );
    const [limits] = await db
      .select({
        storageQuota: schema.organisations.storageQuota,
        memberLimit: schema.organisations.memberLimit,
      })
      .from(schema.organisations)
      .where(eq(schema.organisations.id, w.id));
    expect(limits).toEqual({ storageQuota: 1e12, memberLimit: 25 });
    const billing = await billingOf(db, w.id, gateway);
    expect(billing).toMatchObject({
      gateway: "stripe",
      subscribed: true,
      plan: { plan: { name: "Studio" }, status: "active", renewsAt: "2026-11-06T21:20:00.000Z" },
    });
    expect(billing.plans).toContainEqual(
      expect.objectContaining({
        id: w.planId,
        price: { amount: 4900, currency: "GBP", interval: "month" },
      }),
    );

    // Now subscribed, a change goes to the subscription, not to another checkout.
    calls.length = 0;
    expect(
      await changePlan(deps, { organisationId: w.id, userId: w.userId, planId: w.planId }),
    ).toEqual({ url: null });
    expect(calls.map(([m, p]) => `${m} ${p}`)).toContain("POST /v1/subscriptions/sub_1");
  });

  it("takes each event once, and ignores another workspace's checkout", async () => {
    const w = await workspace();
    const other = await workspace();
    await changePlan(deps, { organisationId: w.id, userId: w.userId, planId: w.planId });
    const customerId = (await account(w.id))?.customerId ?? "";
    const id = uuidv7();
    const once = await send("invoice.finalized", invoice(customerId, "open"), new Date(), id);
    const again = await send("invoice.finalized", invoice(customerId, "open"), new Date(), id);
    expect([once.taken, again.taken]).toEqual([true, false]);
    expect(
      await db
        .select()
        .from(schema.gatewayEvents)
        .where(eq(schema.gatewayEvents.eventId, `evt_${id}`)),
    ).toHaveLength(1);

    // A subscription's older event, arriving after a newer one, changes nothing.
    await send("customer.subscription.updated", subscription(customerId, w.planId, "active"));
    const late = await send(
      "customer.subscription.updated",
      subscription(customerId, w.planId, "past_due"),
      new Date(Date.now() - 60_000),
    );
    expect(late.result).toBe("ignored: older than the last");
    const [state] = await db
      .select({ status: schema.workspacePlans.status })
      .from(schema.workspacePlans)
      .where(inOrg(schema.workspacePlans, w.id));
    expect(state?.status).toBe("active");

    // A checkout naming another workspace than its customer's changes nothing.
    const stray = await send("checkout.session.completed", {
      mode: "subscription",
      client_reference_id: other.id,
      customer: customerId,
      subscription: "sub_x",
    });
    expect(stray.result).toBe("ignored: not this workspace's customer");
    expect((await account(other.id))?.subscriptionId).toBeUndefined();
  });

  it("never moves an invoice back when its events arrive out of order", async () => {
    const w = await workspace();
    await changePlan(deps, { organisationId: w.id, userId: w.userId, planId: w.planId });
    const customerId = (await account(w.id))?.customerId ?? "";
    await send(
      "invoice.paid",
      invoice(customerId, "paid", { status_transitions: { paid_at: 1_792_000_100 } }),
    );
    await send("invoice.finalized", invoice(customerId, "open"));
    const [row] = await db.select().from(schema.invoices).where(inOrg(schema.invoices, w.id));
    expect(row).toMatchObject({ status: "paid", amountPaid: 4900, number: "INV-0412" });
    expect((await billingOf(db, w.id, gateway)).invoices).toEqual([
      expect.objectContaining({
        number: "INV-0412",
        status: "paid",
        url: "https://invoice.stripe.com/i/abc",
      }),
    ]);
  });

  it("warns at 7 and 14 days, suspends at 21, deletes nothing, and reopens once paid", async () => {
    const w = await workspace();
    await changePlan(deps, { organisationId: w.id, userId: w.userId, planId: w.planId });
    const customerId = (await account(w.id))?.customerId ?? "";
    await send("customer.subscription.created", subscription(customerId, w.planId, "active"));
    const failed = new Date("2026-10-01T09:00:00Z");
    await send("invoice.payment_failed", invoice(customerId, "open"), failed);
    // A second failure keeps the first's date.
    await send(
      "invoice.payment_failed",
      invoice(customerId, "open"),
      new Date("2026-10-04T09:00:00Z"),
    );
    expect((await account(w.id))?.pastDueSince).toEqual(failed);
    const mine = () => mailer.sent.filter((m) => m.to === w.email);

    await runDunning(deps, new Date(failed.getTime() + 6 * day));
    expect(mine()).toHaveLength(0);
    await runDunning(deps, new Date(failed.getTime() + 7 * day));
    await runDunning(deps, new Date(failed.getTime() + 8 * day));
    expect(mine().map((m) => m.subject)).toEqual([
      "Endless Hall Records: a payment of £49.00 is overdue",
    ]);
    expect(mine()[0]?.text).toContain("before 22 October 2026");
    await runDunning(deps, new Date(failed.getTime() + 14 * day));
    expect(mine()).toHaveLength(2);
    await runDunning(deps, new Date(failed.getTime() + 21 * day));
    expect(mine().at(-1)?.subject).toBe(
      "Endless Hall Records is suspended until its payment is made",
    );
    expect(await organisation(w.id)).toMatchObject({
      suspendedReason: DUNNING_REASON,
      deleteAfter: null,
    });
    const [suspended] = await db
      .select()
      .from(schema.instanceEvents)
      .where(
        and(
          eq(schema.instanceEvents.action, "workspace.suspended"),
          eq(schema.instanceEvents.target, "Endless Hall Records"),
        ),
      );
    expect(suspended).toMatchObject({ actorId: null, details: { by: "billing" } });
    await runDunning(deps, new Date(failed.getTime() + 30 * day));
    expect(mine()).toHaveLength(3);

    // Paid: dunning ends and the workspace opens again.
    await send("invoice.paid", invoice(customerId, "paid"));
    expect(await organisation(w.id)).toMatchObject({ suspendedAt: null, suspendedReason: null });
    expect(await account(w.id)).toMatchObject({ pastDueSince: null, dunningStage: 0 });
  });

  it("leaves a workspace an operator suspended as the operator left it", async () => {
    const w = await workspace();
    await changePlan(deps, { organisationId: w.id, userId: w.userId, planId: w.planId });
    const customerId = (await account(w.id))?.customerId ?? "";
    await send(
      "invoice.payment_failed",
      invoice(customerId, "open"),
      new Date(Date.now() - 22 * day),
    );
    await db
      .update(schema.organisations)
      .set({ suspendedAt: new Date(), suspendedReason: "Asked us to pause it" })
      .where(eq(schema.organisations.id, w.id));
    await runDunning(deps);
    expect((await account(w.id))?.dunningStage).toBe(3);
    expect((await organisation(w.id))?.suspendedReason).toBe("Asked us to pause it");
    await send("invoice.paid", invoice(customerId, "paid"));
    expect((await organisation(w.id))?.suspendedReason).toBe("Asked us to pause it");
  });

  it("offers only plans that are priced, shown and current, and none without a gateway", async () => {
    const w = await workspace();
    const [hidden] = await db
      .insert(schema.plans)
      .values({
        key: `label-${uuidv7().slice(-8)}`,
        name: "Label",
        priceAmount: 19_000,
        interval: "month",
        hidden: true,
        features: [],
        severities: [],
      })
      .returning();
    const [agreed] = await db
      .insert(schema.plans)
      .values({ key: `house-${uuidv7().slice(-8)}`, name: "House", features: [], severities: [] })
      .returning();
    const offered = (await billingOf(db, w.id, gateway)).plans.map((p) => p.id);
    expect(offered).toContain(w.planId);
    expect(offered).not.toContain(hidden?.id);
    expect(offered).not.toContain(agreed?.id);
    const ask = (planId: string, via: BillingDeps = deps) =>
      changePlan(via, { organisationId: w.id, userId: w.userId, planId }).catch((e: unknown) => e);
    expect(await ask(hidden?.id ?? "")).toMatchObject({ status: 404 });
    expect(await ask(agreed?.id ?? "")).toMatchObject({ status: 409, code: "plan_by_agreement" });
    expect(await ask(w.planId, { ...deps, gateway: null })).toMatchObject({
      status: 409,
      code: "billing_unavailable",
    });
  });
});

import { createDb, inOrg, runMigrations, schema, uuidv7 } from "@hekate/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memoryMailer } from "../mail.ts";
import {
  type BillingDeps,
  billingOf,
  changePlan,
  DUNNING_REASON,
  invoiceByHand,
  retakeGatewayEvent,
  runDunning,
  settleByHand,
  takeGatewayEvent,
} from "./billing.ts";
import { endPromo, savePromo, usesOf } from "./promos.ts";
import { type Stripe, StripeError, signStripeEvent } from "./stripe.ts";
import { stripeGateway } from "./stripe-gateway.ts";

const url = process.env.DATABASE_URL;
const secret = "whsec_billing_tests";
const day = 86_400_000;
type Obj = Record<string, unknown>;

describe.runIf(url)("billing (#178)", () => {
  const { db, close } = createDb(url ?? "", { max: 3 });
  const mailer = memoryMailer();
  const calls: [string, string, Obj][] = [];
  /** Stripe's side: its subscriptions and checkouts as they stand, by id. */
  const subscriptions = new Map<string, Obj>();
  const invoices = new Map<string, Obj>();
  const sessions = new Map<string, { status: string }>();
  const missing = () => {
    throw new StripeError(404, "No such object", "resource_missing");
  };
  const stripe: Stripe = {
    async request(method, path, params = {}) {
      calls.push([method, path, params]);
      if (path === "/v1/customers") return { id: `cus_${uuidv7().slice(-12)}` } as never;
      if (path === "/v1/checkout/sessions") {
        const id = `cs_${uuidv7().slice(-12)}`;
        sessions.set(id, { status: "open" });
        const expires_at = Math.floor(Date.now() / 1000) + 86_400;
        return { id, url: `https://checkout.stripe.com/c/${id}`, expires_at } as never;
      }
      const session = /^\/v1\/checkout\/sessions\/(cs_\w+)(\/expire)?$/.exec(path);
      if (session?.[1]) {
        const held = sessions.get(session[1]) ?? { status: "expired" };
        if (session[2]) held.status = "expired";
        return held as never;
      }
      const held = /^\/v1\/invoices\/(\w+)$/.exec(path)?.[1];
      if (held && method === "GET") return (invoices.get(held) ?? missing()) as never;
      const subscription = /^\/v1\/subscriptions\/(\w+)$/.exec(path)?.[1];
      if (subscription && method === "GET")
        return (subscriptions.get(subscription) ?? missing()) as never;
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

  /** A workspace with an owner and a priced plan, checked out once so it is a customer. */
  const workspace = async (plan: Obj = {}) => {
    const [org] = await db
      .insert(schema.organisations)
      .values({ name: "Endless Hall Records", slug: `billing-${uuidv7()}` })
      .returning();
    const id = org?.id ?? "";
    const userId = uuidv7();
    const email = `owner-${userId}@example.test`;
    await db.insert(schema.users).values({ id: userId, name: "Mira Solberg", email });
    await db.insert(schema.members).values({ organisationId: id, userId, role: "owner" });
    const [made] = await db
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
        ...plan,
      })
      .returning();
    const planId = made?.id ?? "";
    const checkout = await changePlan(deps, { organisationId: id, userId, planId });
    const [account] = await db
      .select()
      .from(schema.billingAccounts)
      .where(inOrg(schema.billingAccounts, id));
    const customerId = account?.customerId ?? "";
    return { id, userId, email, planId, customerId, checkout, subscriptionId: `sub_${customerId}` };
  };
  /** Send an event as Stripe would, through the gateway's own reading of it. */
  const send = (type: string, object: Obj, at = new Date(), id = uuidv7()) => {
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
  /** A subscription as Stripe holds it now, which its events are read against. */
  const subscribe = (w: { customerId: string; planId: string }, status: string) => {
    const object = {
      id: `sub_${w.customerId}`,
      customer: w.customerId,
      status,
      metadata: { planId: w.planId },
      items: {
        data: [
          {
            id: "si_1",
            current_period_end: 1_794_000_000,
            price: { unit_amount: 4900, currency: "gbp" },
          },
        ],
      },
    };
    subscriptions.set(object.id, object);
    return object;
  };
  /**
   * An invoice as Stripe holds it now, which its events are read against. Stripe's ids are its
   * own across every account: one invoice per customer here.
   */
  const invoice = (w: { customerId: string }, status: string, extra: Obj = {}) => {
    const object = {
      id: `in_${w.customerId}`,
      customer: w.customerId,
      parent: { subscription_details: { subscription: `sub_${w.customerId}` } },
      number: "INV-0412",
      status,
      currency: "gbp",
      amount_due: 4900,
      amount_paid: status === "paid" ? 4900 : 0,
      created: 1_792_000_000,
      hosted_invoice_url: "https://invoice.stripe.com/i/abc",
      ...extra,
    };
    invoices.set(object.id, object);
    return object;
  };
  /** The checkout a workspace was last sent to, by its id. */
  const sessionOf = async (id: string) => (await account(id))?.checkoutId ?? "";
  const checkedOut = async (w: Awaited<ReturnType<typeof workspace>>) => {
    await send("checkout.session.completed", {
      id: await sessionOf(w.id),
      mode: "subscription",
      client_reference_id: w.id,
      customer: w.customerId,
      subscription: w.subscriptionId,
    });
    await send("customer.subscription.created", subscribe(w, "active"));
  };
  const account = async (id: string) =>
    (await db.select().from(schema.billingAccounts).where(inOrg(schema.billingAccounts, id)))[0];
  const organisation = async (id: string) =>
    (await db.select().from(schema.organisations).where(eq(schema.organisations.id, id)))[0];
  const planState = async (id: string) =>
    (
      await db
        .select({ status: schema.workspacePlans.status })
        .from(schema.workspacePlans)
        .where(inOrg(schema.workspacePlans, id))
    )[0]?.status;

  it("checks out as one customer, then changes the plan in place", async () => {
    calls.length = 0;
    const w = await workspace();
    expect(w.checkout.url).toMatch(/^https:\/\/checkout\.stripe\.com\/c\/cs_/);
    expect(calls.find(([, p]) => p === "/v1/customers")?.[2]).toMatchObject({
      name: "Endless Hall Records",
      email: w.email,
    });
    expect(w.customerId).toMatch(/^cus_/);

    await checkedOut(w);
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
    expect((await account(w.id))?.checkoutId).toBeNull();

    // Now subscribed, a change goes to the subscription, not to another checkout.
    calls.length = 0;
    expect(
      await changePlan(deps, { organisationId: w.id, userId: w.userId, planId: w.planId }),
    ).toEqual({ url: null });
    expect(calls.map(([m, p]) => `${m} ${p}`)).toContain(
      `POST /v1/subscriptions/${w.subscriptionId}`,
    );
  });

  it("gives one checkout at a time, so only one can be paid", async () => {
    const w = await workspace();
    const ask = (planId = w.planId) =>
      changePlan(deps, { organisationId: w.id, userId: w.userId, planId }).catch((e: unknown) => e);
    // The same plan again: the same checkout.
    calls.length = 0;
    expect(await ask()).toEqual(w.checkout);
    expect(calls.some(([, p]) => p === "/v1/checkout/sessions")).toBe(false);
    // Another plan: the first is closed before the second is made.
    const [other] = await db
      .insert(schema.plans)
      .values({
        key: `label-${uuidv7().slice(-8)}`,
        name: "Label",
        priceAmount: 19_000,
        interval: "month",
        features: [],
        severities: [],
      })
      .returning();
    const first = String(w.checkout.url).split("/").at(-1) ?? "";
    const second = (await ask(other?.id)) as { url: string };
    expect(sessions.get(first)?.status).toBe("expired");
    expect(second.url).not.toBe(w.checkout.url);
    // Paid already, though its webhook has not come: no other is made.
    const paid = second.url.split("/").at(-1) ?? "";
    sessions.set(paid, { status: "complete" });
    expect(await ask()).toMatchObject({ status: 409, code: "checkout_finishing" });
  });

  it("takes each event once, and ignores another workspace's checkout", async () => {
    const w = await workspace();
    const other = await workspace();
    const id = uuidv7();
    const once = await send("invoice.finalized", invoice(w, "open"), new Date(), id);
    const again = await send("invoice.finalized", invoice(w, "open"), new Date(), id);
    expect([once.taken, again.taken]).toEqual([true, false]);
    expect(
      await db
        .select()
        .from(schema.gatewayEvents)
        .where(eq(schema.gatewayEvents.eventId, `evt_${id}`)),
    ).toHaveLength(1);

    // A checkout naming another workspace than its customer's changes nothing.
    const stray = await send("checkout.session.completed", {
      id: "cs_stray",
      mode: "subscription",
      client_reference_id: other.id,
      customer: w.customerId,
      subscription: "sub_x",
    });
    expect(stray.result).toBe("ignored: not this workspace's customer");
    expect((await account(other.id))?.subscriptionId).toBeNull();
  });

  it("reads a subscription as it stands, whatever order its events arrive in", async () => {
    const w = await workspace();
    await checkedOut(w);
    // Stripe holds it active; an older event saying it was past due arrives late.
    const late = { ...subscribe(w, "past_due") };
    subscribe(w, "active");
    await send("customer.subscription.updated", late, new Date(Date.now() - 60_000));
    expect(await planState(w.id)).toBe("active");
    expect((await account(w.id))?.pastDueSince).toBeNull();
  });

  it("takes the event's own word for an invoice the gateway no longer has", async () => {
    const w = await workspace();
    await checkedOut(w);
    // A draft, deleted in Stripe before its event arrives.
    const draft = { ...invoice(w, "draft"), id: `in_draft_${w.customerId}` };
    const taken = await send("invoice.deleted", draft);
    expect(taken).toMatchObject({ taken: true, result: "taken" });
    const [row] = await db
      .select()
      .from(schema.invoices)
      .where(inOrg(schema.invoices, w.id, eq(schema.invoices.gatewayId, draft.id)));
    expect(row?.status).toBe("draft");
  });

  it("never moves an invoice back when its events arrive out of order", async () => {
    const w = await workspace();
    const paid = invoice(w, "paid", { status_transitions: { paid_at: 1_792_000_100 } });
    await send("invoice.paid", paid);
    // A late event's snapshot says open; Stripe holds it paid.
    const stale = { ...paid, status: "open", amount_paid: 0 };
    await send("invoice.finalized", stale);
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
    await checkedOut(w);
    const failed = new Date("2026-10-01T09:00:00Z");
    await send("invoice.payment_failed", invoice(w, "open"), failed);
    // A second failure keeps the first's date.
    await send("invoice.payment_failed", invoice(w, "open"), new Date("2026-10-04T09:00:00Z"));
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
    await send("invoice.paid", invoice(w, "paid"));
    expect(await organisation(w.id)).toMatchObject({ suspendedAt: null, suspendedReason: null });
    expect(await account(w.id)).toMatchObject({
      pastDueSince: null,
      dunningStage: 0,
      noticedStage: 0,
    });
  });

  it("tells the owners again each hour until the mail goes", async () => {
    const w = await workspace();
    await checkedOut(w);
    const failed = new Date("2026-10-01T09:00:00Z");
    await send("invoice.payment_failed", invoice(w, "open"), failed);
    let down = true;
    const flaky: BillingDeps = {
      ...deps,
      mailer: {
        async send(message) {
          if (down && message.to === w.email) throw new Error("The mail server is down");
          await mailer.send(message);
        },
      },
    };
    await runDunning(flaky, new Date(failed.getTime() + 7 * day));
    expect(await account(w.id)).toMatchObject({ dunningStage: 1, noticedStage: 0 });
    down = false;
    await runDunning(flaky, new Date(failed.getTime() + 7 * day + 3_600_000));
    expect(await account(w.id)).toMatchObject({ dunningStage: 1, noticedStage: 1 });
    expect(mailer.sent.filter((m) => m.to === w.email)).toHaveLength(1);
  });

  it("starts dunning only for the workspace's own subscription, and only with its gateway on", async () => {
    const w = await workspace();
    await checkedOut(w);
    // An invoice made by hand in Stripe, failing, is kept but changes nothing.
    const byHand = { ...invoice(w, "open"), id: `in_hand_${w.customerId}`, parent: null };
    invoices.set(byHand.id, byHand);
    await send("invoice.payment_failed", byHand);
    expect((await account(w.id))?.pastDueSince).toBeNull();
    // Without the gateway, nothing advances.
    await send("invoice.payment_failed", invoice(w, "open"), new Date(Date.now() - 22 * day));
    expect(await runDunning({ ...deps, gateway: null })).toBe(0);
    expect((await account(w.id))?.dunningStage).toBe(0);
  });

  it("leaves a workspace an operator suspended as the operator left it", async () => {
    const w = await workspace();
    await checkedOut(w);
    await send("invoice.payment_failed", invoice(w, "open"), new Date(Date.now() - 22 * day));
    await db
      .update(schema.organisations)
      .set({ suspendedAt: new Date(), suspendedReason: "Asked us to pause it" })
      .where(eq(schema.organisations.id, w.id));
    await runDunning(deps);
    expect((await account(w.id))?.dunningStage).toBe(3);
    expect((await organisation(w.id))?.suspendedReason).toBe("Asked us to pause it");
    await send("invoice.paid", invoice(w, "paid"));
    expect((await organisation(w.id))?.suspendedReason).toBe("Asked us to pause it");
  });

  it("takes an event again against the invoice as it stands, never undoing a payment", async () => {
    const w = await workspace();
    await checkedOut(w);
    await send("invoice.payment_failed", invoice(w, "open"), new Date(Date.now() - 2 * day));
    expect((await account(w.id))?.pastDueSince).not.toBeNull();
    const [failure] = await db
      .select({ id: schema.gatewayEvents.id })
      .from(schema.gatewayEvents)
      .where(
        and(
          eq(schema.gatewayEvents.organisationId, w.id),
          eq(schema.gatewayEvents.type, "invoice.payment_failed"),
        ),
      );
    await send("invoice.paid", invoice(w, "paid"));
    expect((await account(w.id))?.pastDueSince).toBeNull();
    // The old failure, taken again, finds the invoice paid: nothing is owed.
    const again = await retakeGatewayEvent(deps, failure?.id ?? "");
    expect(again).toMatchObject({ type: "invoice.payment_failed", organisationId: w.id });
    expect((await account(w.id))?.pastDueSince).toBeNull();
    expect(
      await retakeGatewayEvent({ ...deps, gateway: null }, failure?.id ?? "").catch(
        (e: unknown) => e,
      ),
    ).toMatchObject({ status: 409, code: "billing_unavailable" });
    expect(await retakeGatewayEvent(deps, uuidv7()).catch((e: unknown) => e)).toMatchObject({
      status: 404,
    });
  });

  it("numbers invoices by hand in one series, and settles only open ones made by hand", async () => {
    const w = await workspace();
    const other = await workspace();
    const made = await invoiceByHand(db, w.id, {
      amount: 120_000,
      currency: "GBP",
      description: "Joplin Rags mastering, by agreement",
      periodStart: null,
      periodEnd: null,
      dueAt: "2026-11-30T00:00:00Z",
    });
    const next = await invoiceByHand(db, other.id, {
      amount: 5000,
      currency: "GBP",
      description: "Opening titles review seats",
      periodStart: null,
      periodEnd: null,
      dueAt: null,
    });
    const n = Number(made.number?.slice(3));
    expect(made).toMatchObject({ source: "manual", status: "open", amountDue: 120_000 });
    expect(next.number).toBe(`HK-${String(n + 1).padStart(4, "0")}`);
    // Another workspace's invoice is not this one's to settle.
    expect(
      await settleByHand(db, other.id, made.id, "paid").catch((e: unknown) => e),
    ).toMatchObject({ status: 409, code: "not_open" });
    const paid = await settleByHand(db, w.id, made.id, "paid");
    expect(paid).toMatchObject({ status: "paid", amountPaid: 120_000 });
    expect(paid.paidAt).not.toBeNull();
    expect(await settleByHand(db, w.id, made.id, "void").catch((e: unknown) => e)).toMatchObject({
      status: 409,
    });
    expect((await billingOf(db, w.id, gateway)).invoices[0]).toMatchObject({
      number: made.number,
      description: "Joplin Rags mastering, by agreement",
      status: "paid",
    });
  });

  /** A code for the tests, its terms as given. */
  const promo = (terms: Partial<Parameters<typeof savePromo>[1]> = {}) =>
    savePromo(db, { code: `TEST-${uuidv7().slice(-8)}`, percentOff: 50, months: 3, ...terms });
  const useCount = async (id: string) =>
    (await db.select().from(schema.promoCodes).where(eq(schema.promoCodes.id, id)))[0]?.uses;

  it("holds a code's use while its checkout is open, and gives it back when it lapses", async () => {
    const w = await workspace();
    const other = await workspace();
    const code = await promo({ maxUses: 1 });
    const ask = (x: typeof w, planId = x.planId) =>
      changePlan(deps, {
        organisationId: x.id,
        userId: x.userId,
        planId,
        promoCode: code.code.toLowerCase(),
      }).catch((e: unknown) => e);
    calls.length = 0;
    const first = (await ask(w)) as { url: string };
    expect(await useCount(code.id)).toBe(1);
    // The checkout carries the code's discount.
    const session = calls.find(([, p]) => p === "/v1/checkout/sessions")?.[2];
    expect(session).toMatchObject({ discounts: [{ coupon: expect.stringMatching(/_p50_m3$/) }] });
    // Asked again, the same checkout, with the same use.
    expect(await ask(w)).toEqual(first);
    expect(await useCount(code.id)).toBe(1);
    // Its one use is held: nobody else has it meanwhile.
    expect(await ask(other)).toMatchObject({ status: 409, message: "That code has been used up." });
    // The checkout lapses unpaid: the use is given back, and the next to ask has it.
    await send("checkout.session.expired", { id: await sessionOf(w.id) });
    expect(await useCount(code.id)).toBe(0);
    expect(await ask(other)).toMatchObject({ url: expect.any(String) });
    await checkedOut(other);
    expect(await usesOf(db, code.id)).toEqual([
      expect.objectContaining({
        workspace: { id: other.id, name: "Endless Hall Records" },
        status: "taken",
      }),
      expect.objectContaining({
        workspace: { id: w.id, name: "Endless Hall Records" },
        status: "released",
      }),
    ]);
  });

  it("gives a use back when its checkout is closed for another, and applies a code at once to a subscription", async () => {
    const w = await workspace();
    const code = await promo({ maxUses: 5 });
    await changePlan(deps, {
      organisationId: w.id,
      userId: w.userId,
      planId: w.planId,
      promoCode: code.code,
    });
    expect(await useCount(code.id)).toBe(1);
    // The same plan without the code: the first checkout is closed, its use given back.
    await changePlan(deps, { organisationId: w.id, userId: w.userId, planId: w.planId });
    expect(await useCount(code.id)).toBe(0);
    await checkedOut(w);
    calls.length = 0;
    await changePlan(deps, {
      organisationId: w.id,
      userId: w.userId,
      planId: w.planId,
      promoCode: code.code,
    });
    expect(
      calls.find(([m, p]) => m === "POST" && p === `/v1/subscriptions/${w.subscriptionId}`)?.[2],
    ).toMatchObject({
      discounts: [{ coupon: expect.any(String) }],
    });
    expect(await useCount(code.id)).toBe(1);
    expect((await usesOf(db, code.id))[0]).toMatchObject({ status: "taken", plan: "Studio" });
  });

  it("refuses a code that does not apply, and one there is no such of", async () => {
    const w = await workspace();
    const ask = (promoCode: string) =>
      changePlan(deps, {
        organisationId: w.id,
        userId: w.userId,
        planId: w.planId,
        promoCode,
      }).catch((e: unknown) => e);
    const elsewhere = await promo({ planIds: [uuidv7()] });
    const euros = await promo({ percentOff: null, amountOff: 2000, currency: "EUR" });
    const over = await promo({ until: "2026-01-01T00:00:00Z" });
    expect(await ask(elsewhere.code)).toMatchObject({
      code: "promo_refused",
      message: "That code is not for this plan.",
    });
    expect(await ask(euros.code)).toMatchObject({ message: "That code is for another currency." });
    expect(await ask(over.code)).toMatchObject({ message: "That code has ended." });
    await endPromo(db, elsewhere.id);
    expect(await ask("NOPE-0000")).toMatchObject({
      status: 409,
      message: "There is no such code.",
    });
    expect(
      await savePromo(db, { code: euros.code, percentOff: 10 }).catch((e: unknown) => e),
    ).toMatchObject({
      status: 409,
      code: "promo_code_taken",
    });
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

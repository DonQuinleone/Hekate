import { inOrg, schema, uuidv7 } from "@hekate/db";
import { type BillingCredit, formatMoney } from "@hekate/shared";
import { desc, eq, inArray, isNotNull } from "drizzle-orm";
import { workspaceDateFormats } from "../dates.ts";
import { mailDate } from "../email/templates.ts";
import { CodedException, NotFound } from "../errors.ts";
import { sendEmail } from "../mail.ts";
import { type BillingDeps, priceOf } from "./billing.ts";
import { assertApplies, discountOf, findPromo, useOf } from "./promos.ts";

const { billingAccounts, billingCredits, invoices, workspacePlans, plans, members, organisations } =
  schema;

/**
 * What an operator does for one workspace from its row on the Billing overview (#445): apply a
 * promo code to its subscription, give it a credit toward what it next owes, and send its owners
 * its latest invoice again. Each is the route's to record as an instance event.
 */

const disconnected = () =>
  new CodedException(
    409,
    "billing_unavailable",
    "It pays through the gateway, and the gateway is not connected (HEKATE_BILLING).",
  );

/** The workspace's plan, priced when it has a price. */
async function planOf(db: Pick<BillingDeps["db"], "select">, organisationId: string) {
  const [held] = await db
    .select({ plan: plans })
    .from(workspacePlans)
    .innerJoin(plans, eq(plans.id, workspacePlans.planId))
    .where(inOrg(workspacePlans, organisationId));
  return held ? { plan: held.plan, price: priceOf(held.plan) } : null;
}

/**
 * Apply one of the instance's codes to a workspace's subscription, as an owner could when
 * changing plan: the same checks, its use taken at once, and the subscription given the code's
 * discount on the plan it is on.
 */
export async function applyPromo(
  deps: Pick<BillingDeps, "db" | "gateway">,
  organisationId: string,
  code: string,
): Promise<{ code: string; plan: string }> {
  const { db, gateway } = deps;
  if (!gateway) throw disconnected();
  return db.transaction(async (tx) => {
    // Held as a change of plan holds it, so an owner's change at the same moment waits.
    const [account] = await tx
      .select()
      .from(billingAccounts)
      .where(inOrg(billingAccounts, organisationId))
      .for("update");
    if (!account?.subscriptionId)
      throw new CodedException(
        409,
        "not_subscribed",
        "It has no subscription for a code to apply to: give the code to its owners to use at checkout.",
      );
    const held = await planOf(tx, organisationId);
    if (!held?.price)
      throw new CodedException(409, "plan_by_agreement", "Its plan has no price to take a code.");
    // Held for the change, so the code's last use cannot go twice.
    const promo = await findPromo(tx, code);
    assertApplies(promo, held.plan.id, held.price.currency);
    await gateway.changePlan({
      subscriptionId: account.subscriptionId,
      plan: { id: held.plan.id, name: held.plan.name, price: held.price },
      discount: discountOf(promo),
    });
    await useOf(tx, promo, { organisationId, planId: held.plan.id, checkoutId: null });
    return { code: promo.code, plan: held.plan.name };
  });
}

const creditOf = (row: typeof billingCredits.$inferSelect): BillingCredit => ({
  id: row.id,
  source: row.source,
  amount: row.amount,
  currency: row.currency,
  reason: row.reason,
  invoiceId: row.invoiceId,
  createdAt: row.createdAt.toISOString(),
});

/**
 * Give a workspace a credit toward what it next owes. One paying through the gateway gets it as
 * its customer's balance, which the gateway takes off its next invoice; one invoiced by hand has
 * it held until its next invoice by hand, which takes it off as a line of its own.
 */
export async function issueCredit(
  deps: Pick<BillingDeps, "db" | "gateway">,
  organisationId: string,
  input: { amount: number; currency: string; reason: string },
  actorId: string | null,
): Promise<BillingCredit> {
  const { db, gateway } = deps;
  const [account] = await db
    .select()
    .from(billingAccounts)
    .where(inOrg(billingAccounts, organisationId));
  const id = uuidv7();
  const values = {
    id,
    organisationId,
    amount: input.amount,
    currency: input.currency,
    reason: input.reason,
    createdBy: actorId,
  };
  if (!account?.subscriptionId) {
    const [made] = await db
      .insert(billingCredits)
      .values({ ...values, source: "manual" })
      .returning();
    if (!made) throw new Error("The credit was not written");
    return creditOf(made);
  }
  if (!gateway) throw disconnected();
  // The gateway keeps one balance per customer, in the currency it bills them in.
  const held = await planOf(db, organisationId);
  if (held?.price && held.price.currency !== input.currency)
    throw new CodedException(
      409,
      "credit_currency",
      `Its subscription is billed in ${held.price.currency}: give the credit in ${held.price.currency}.`,
    );
  const gatewayId = await gateway.credit({
    customerId: account.customerId,
    amount: input.amount,
    currency: input.currency,
    description: input.reason,
    // The credit's own id: asked again, the gateway gives back the one it made.
    key: id,
  });
  const [made] = await db
    .insert(billingCredits)
    .values({ ...values, source: gateway.kind, gatewayId })
    .returning();
  if (!made) throw new Error("The credit was not written");
  return creditOf(made);
}

/**
 * Send the workspace's owners its latest invoice from the gateway again: its page and its PDF,
 * read afresh from the gateway where it can say, by mail. Invoices by hand are sent outside
 * Hekate (decision 211), so they are not sent from here.
 */
export async function sendLatestInvoice(
  deps: Pick<BillingDeps, "db" | "gateway" | "mailer">,
  organisationId: string,
): Promise<{ number: string | null; sent: number }> {
  const { db, gateway } = deps;
  const [latest] = await db
    .select()
    .from(invoices)
    .where(
      inOrg(
        invoices,
        organisationId,
        eq(invoices.source, "stripe"),
        isNotNull(invoices.gatewayId),
        inArray(invoices.status, [...sendable]),
      ),
    )
    .orderBy(desc(invoices.issuedAt))
    .limit(1);
  if (!latest)
    throw new CodedException(409, "no_invoice", "It has no invoice from the gateway to send.");
  // Its links as the gateway gives them now; the copy kept here if it cannot say.
  const now =
    gateway && latest.gatewayId
      ? await gateway.invoice(latest.gatewayId).catch((error: unknown) => {
          console.error(`The gateway's invoice ${latest.gatewayId} could not be read`, error);
          return null;
        })
      : null;
  const invoice = now ?? latest;
  const page = invoice.url ?? latest.url;
  const pdf = invoice.pdfUrl ?? latest.pdfUrl;
  if (!page && !pdf)
    throw new CodedException(409, "no_invoice_page", "Its latest invoice has no page to send.");
  const owners = await db
    .select({ email: schema.users.email, workspace: organisations.name })
    .from(members)
    .innerJoin(schema.users, eq(schema.users.id, members.userId))
    .innerJoin(organisations, eq(organisations.id, members.organisationId))
    .where(inOrg(members, organisationId, eq(members.role, "owner")));
  if (owners.length === 0) throw new NotFound("Owner");
  const number = invoice.number ?? latest.number;
  const amount = formatMoney(invoice.amountDue, invoice.currency);
  const { dateFormat } = await workspaceDateFormats(db, organisationId);
  const standing =
    invoice.status === "paid"
      ? "It is paid: this copy is for your records."
      : invoice.dueAt
        ? `It is due on ${mailDate(invoice.dueAt, dateFormat)}.`
        : "It is still to be paid.";
  for (const owner of owners)
    await sendEmail(
      deps.mailer,
      owner.email,
      {
        workspace: owner.workspace,
        subject: `${owner.workspace}: invoice ${number ?? ""}`.trim(),
        heading: `Invoice ${number ? `${number} ` : ""}for ${owner.workspace}, ${amount}`,
        body: [standing, ...(pdf ? [`Its PDF: ${pdf}`] : [])],
        ...(page ? { action: { label: "Open the invoice", url: page } } : {}),
        foot: "You get this because you own this workspace, and the instance's operators sent it again.",
      },
      organisationId,
    );
  return { number, sent: owners.length };
}

/** Which of the gateway's invoices can be sent: one finalised and not voided. */
const sendable = ["open", "paid", "uncollectible"] as const;

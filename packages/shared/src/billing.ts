import { z } from "zod";

/**
 * Billing through a gateway (#178): a workspace pays for its plan (#177) through Stripe, or is
 * invoiced by hand. A payment that fails puts it in dunning: its owners are warned at 7 and 14
 * days, and it is suspended at 21. Nothing is ever deleted for want of payment.
 */

/** Where an invoice came from: the gateway, or an operator by hand. */
export const invoiceSources = ["stripe", "manual"] as const;
export type InvoiceSource = (typeof invoiceSources)[number];

export const invoiceStatuses = ["draft", "open", "paid", "void", "uncollectible"] as const;
export type InvoiceStatus = (typeof invoiceStatuses)[number];

/** An invoice as the workspace and the instance see it. Amounts in the currency's minor unit. */
export interface Invoice {
  id: string;
  source: InvoiceSource;
  /** The gateway's number for it (`INV-0412`), or Hekate's for one by hand (`HK-0007`). */
  number: string | null;
  /** What one by hand is for. */
  description: string | null;
  status: InvoiceStatus;
  currency: string;
  amountDue: number;
  amountPaid: number;
  periodStart: string | null;
  periodEnd: string | null;
  issuedAt: string;
  dueAt: string | null;
  paidAt: string | null;
  /** The gateway's page for paying or reading it; null for one by hand. */
  url: string | null;
}

/**
 * An invoice an operator makes by hand (#178), for a plan by agreement: it is sent by mail
 * outside Hekate and marked paid, or void, by hand.
 */
export const manualInvoiceInput = z.object({
  amount: z.number().int().positive().max(100_000_000),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, { error: "A three-letter currency code, such as GBP" }),
  description: z.string().trim().min(1, "Say what it is for").max(200),
  periodStart: z.iso.datetime({ offset: true }).nullable().default(null),
  periodEnd: z.iso.datetime({ offset: true }).nullable().default(null),
  dueAt: z.iso.datetime({ offset: true }).nullable().default(null),
});
export type ManualInvoiceInput = z.input<typeof manualInvoiceInput>;

/** An invoice by hand, settled by hand: paid, or void. */
export const manualInvoiceOutcome = z.object({ outcome: z.enum(["paid", "void"]) });

/** Changing the workspace's plan: through Checkout first, then on its subscription. */
export const checkoutInput = z.object({ planId: z.uuid() });

/** The days after a missed payment at which dunning acts, and what it does then. */
export const dunningSteps = [
  { days: 7, action: "warn" },
  { days: 14, action: "warn" },
  { days: 21, action: "suspend" },
] as const;

/**
 * The step dunning is due to take, counted from 1, or null when nothing is due: the furthest
 * step its days have reached that it has not taken. A step missed (the job not running for a
 * week) is skipped for the later one, so an owner is never warned twice in one day.
 */
export function dunningDue(pastDueSince: Date, now: Date, taken: number): number | null {
  const days = Math.floor((now.getTime() - pastDueSince.getTime()) / 86_400_000);
  let reached = 0;
  for (const [i, step] of dunningSteps.entries()) if (days >= step.days) reached = i + 1;
  return reached > taken ? reached : null;
}

/**
 * A price in words, from its amount in the currency's minor unit: `£49.00`, `JP¥4,900`. The
 * minor unit is the currency's own (none for yen, three places for dinars), as Stripe counts.
 */
export function formatMoney(amount: number, currency: string): string {
  const format = new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: currency.toUpperCase(),
  });
  const places = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(amount / 10 ** places);
}

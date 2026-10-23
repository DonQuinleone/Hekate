import { z } from "zod";
import type { PlanFeature, WorkspacePlan } from "./plans.ts";
import type { WorkspaceUsage } from "./usage.ts";

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
  /** The gateway's PDF of it; null for one by hand. */
  pdfUrl: string | null;
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

/** A plan a workspace may choose (#179): what it gives, and its price. */
export interface PlanChoice {
  id: string;
  key: string;
  name: string;
  storageQuota: number | null;
  memberLimit: number | null;
  projectLimit: number | null;
  features: PlanFeature[];
  price: { amount: number; currency: string; interval: "month" | "year" };
}

/** The workspace's Billing settings (#179), as its admins read them. */
export interface WorkspaceBilling {
  /** Null where payments are arranged with the operators (HEKATE_BILLING=manual). */
  gateway: "stripe" | null;
  plan: WorkspacePlan;
  /** The plan the workspace is on, with its price, even once hidden or retired; null on none. */
  current: (Omit<PlanChoice, "price"> & { price: PlanChoice["price"] | null }) | null;
  /** The plans it may choose. */
  plans: PlanChoice[];
  subscribed: boolean;
  pastDueSince: string | null;
  invoices: Invoice[];
  usage: WorkspaceUsage;
  /** The card and billing details at the gateway; null before the first checkout. */
  customer: BillingCustomer | null;
}

/** Changing the workspace's plan: through Checkout first, then on its subscription. */
export const checkoutInput = z.object({
  planId: z.uuid(),
  /** A promo code, as typed. */
  promoCode: z.string().trim().toUpperCase().max(24).optional(),
});

/** Why a workspace dunning suspended is suspended, and how it is told apart from an operator's. */
export const DUNNING_REASON =
  "A payment is 21 days overdue. The workspace opens again as soon as it is paid.";

/** What the gateway holds for a workspace's billing (#179): the card and the details it bills. */
export interface BillingCustomer {
  name: string | null;
  email: string | null;
  /** On one line, as an invoice shows it. */
  address: string | null;
  /** VAT and other tax ids, as given. */
  taxIds: string[];
  card: { brand: string; last4: string; expMonth: number; expYear: number } | null;
}

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

/**
 * A promo code (#178): a percentage or an amount off, for some months or for as long as the
 * subscription lasts, for the first so many who use it, until a date, on some plans or any.
 */
export interface PromoCode {
  id: string;
  /** As people type it: `LAUNCH50`. */
  code: string;
  percentOff: number | null;
  /** In the currency's minor unit. */
  amountOff: number | null;
  currency: string | null;
  /** How many months the discount lasts; null for as long as the subscription does. */
  months: number | null;
  maxUses: number | null;
  /** Checkouts open with it and subscriptions that have it. */
  uses: number;
  until: string | null;
  /** The plans it is for; none for any. */
  planIds: string[];
  endedAt: string | null;
}

export const promoCodeInput = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9][A-Z0-9-]{2,23}$/, {
        error: "Letters, digits and hyphens, 3 to 24 of them",
      }),
    percentOff: z.number().int().min(1).max(100).nullable().default(null),
    amountOff: z.number().int().positive().max(100_000_000).nullable().default(null),
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, { error: "A three-letter currency code, such as GBP" })
      .nullable()
      .default(null),
    months: z.number().int().min(1).max(36).nullable().default(null),
    maxUses: z.number().int().positive().max(1_000_000).nullable().default(null),
    until: z.iso.datetime({ offset: true }).nullable().default(null),
    planIds: z.array(z.uuid()).max(50).default([]),
  })
  .refine((p) => (p.percentOff === null) !== (p.amountOff === null), {
    error: "A percentage off or an amount off, one of them",
    path: ["percentOff"],
  })
  .refine((p) => p.amountOff === null || p.currency !== null, {
    error: "An amount off needs its currency",
    path: ["currency"],
  });
export type PromoCodeInput = z.input<typeof promoCodeInput>;

/** What may be asked of a code: what stops it applying to a plan now, or null when it applies. */
export function promoRefusal(
  promo: Pick<
    PromoCode,
    "amountOff" | "currency" | "maxUses" | "uses" | "until" | "planIds" | "endedAt"
  >,
  against: { planId: string; currency: string; now: Date },
): string | null {
  if (promo.endedAt || (promo.until && new Date(promo.until) <= against.now))
    return "That code has ended.";
  if (promo.maxUses !== null && promo.uses >= promo.maxUses) return "That code has been used up.";
  if (promo.planIds.length > 0 && !promo.planIds.includes(against.planId))
    return "That code is not for this plan.";
  if (promo.amountOff !== null && promo.currency?.toUpperCase() !== against.currency.toUpperCase())
    return "That code is for another currency.";
  return null;
}

/** A code in words, as a list shows it: "50% off for 3 months · used 4 of 50 · until 31 Dec 2026". */
export function promoSummary(
  promo: Pick<
    PromoCode,
    "percentOff" | "amountOff" | "currency" | "months" | "maxUses" | "uses" | "until" | "endedAt"
  >,
  date: (iso: string) => string,
): string {
  const off =
    promo.percentOff !== null
      ? `${promo.percentOff}% off`
      : `${formatMoney(promo.amountOff ?? 0, promo.currency ?? "GBP")} off`;
  const lasts =
    promo.months === null
      ? "for good"
      : promo.months === 1
        ? "the first invoice"
        : `for ${promo.months} months`;
  const used =
    promo.maxUses === null ? `used ${promo.uses}` : `used ${promo.uses} of ${promo.maxUses}`;
  const ends = promo.endedAt ? "ended" : promo.until ? `until ${date(promo.until)}` : null;
  return [`${off} ${lasts}`, used, ends].filter(Boolean).join(" · ");
}

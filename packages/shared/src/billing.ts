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
  /** What credits took off one by hand (#445), before `amountDue`; null when none did. */
  credit: number | null;
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
  /** When it is suspended if the payment is still owed, by the instance's rules (#180). */
  suspendsAt: string | null;
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

/**
 * Every reason dunning suspends a workspace with. With dunning's days an operator's to set
 * (#180), the reason will stop naming a day; this release recognises the new words and still
 * writes the old, so a replica a release behind, during a rolling upgrade, still knows a
 * workspace it finds suspended for what it is (decision 198). The next release writes the new.
 */
export const dunningReasons = [
  DUNNING_REASON,
  "A payment is overdue. The workspace opens again as soon as it is paid.",
] as const;

export const isDunningReason = (reason: string | null | undefined) =>
  (dunningReasons as readonly (string | null | undefined)[]).includes(reason);

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

/**
 * The days after a missed payment at which dunning acts (#180): its owners warned, warned
 * again, and the workspace suspended. The instance's operators set them.
 */
export const dunningRule = z
  .object({
    warn: z.number().int().min(1).max(60),
    warnAgain: z.number().int().min(1).max(90),
    suspend: z.number().int().min(1).max(120),
  })
  .refine((r) => r.warn < r.warnAgain && r.warnAgain < r.suspend, {
    error: "Each step comes after the one before it",
    path: ["warnAgain"],
  });
export type DunningRule = z.infer<typeof dunningRule>;

export const defaultDunning: DunningRule = { warn: 7, warnAgain: 14, suspend: 21 };

/** How many steps dunning takes: the last suspends. */
export const DUNNING_STEPS = 3;

/** The steps of a rule, in order, with what each does. */
export function dunningStepsOf(rule: DunningRule) {
  return [
    { days: rule.warn, action: "warn" },
    { days: rule.warnAgain, action: "warn" },
    { days: rule.suspend, action: "suspend" },
  ] as const;
}

/**
 * The step dunning is due to take, counted from 1, or null when nothing is due: the furthest
 * step its days have reached that it has not taken. A step missed (the job not running for a
 * week) is skipped for the later one, so an owner is never warned twice in one day.
 */
export function dunningDue(
  pastDueSince: Date,
  now: Date,
  taken: number,
  rule: DunningRule = defaultDunning,
): number | null {
  const days = Math.floor((now.getTime() - pastDueSince.getTime()) / 86_400_000);
  let reached = 0;
  for (const [i, step] of dunningStepsOf(rule).entries()) if (days >= step.days) reached = i + 1;
  return reached > taken ? reached : null;
}

/** When a workspace that first failed to pay then is suspended, under a rule. */
export const suspendsAt = (pastDueSince: Date, rule: DunningRule) =>
  new Date(pastDueSince.getTime() + rule.suspend * 86_400_000);

/** The instance's billing rules (#180): its currency, dunning's days, and how long a trial is. */
export const billingRules = z.object({
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, { error: "A three-letter currency code, such as GBP" }),
  dunning: dunningRule,
  /** How long a trial lasts, for workspaces that sign up for one (#184); 0 for none. */
  trialDays: z.number().int().min(0).max(90),
});
export type BillingRules = z.infer<typeof billingRules>;

export const defaultBillingRules: BillingRules = {
  currency: "GBP",
  dunning: defaultDunning,
  trialDays: 14,
};

/**
 * A price in words, from its amount in the currency's minor unit: `£49.00`, `JP¥4,900`. The
 * minor unit is the currency's own (none for yen, three places for dinars), as Stripe counts.
 */
export function formatMoney(amount: number, currency: string): string {
  const format = new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: currency.toUpperCase(),
  });
  return format.format(amount / 10 ** currencyPlaces(currency));
}

/** How many places a currency's minor unit has: 2 for pounds, none for yen, 3 for dinars. */
export function currencyPlaces(currency: string): number {
  const format = new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: currency.toUpperCase(),
  });
  return format.resolvedOptions().maximumFractionDigits ?? 2;
}

/**
 * An amount as typed (`49`, `49.50`, `1,180`) in the currency's minor unit, or null when it is
 * not one, or has more places than the currency.
 */
export function minorUnits(typed: string, currency: string): number | null {
  const places = currencyPlaces(currency);
  const clean = typed.trim().replaceAll(",", "");
  const match = /^(\d+)(?:\.(\d+))?$/.exec(clean);
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > places) return null;
  return Number(match[1]) * 10 ** places + Number(fraction.padEnd(places, "0") || "0");
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

/** A price as a month's share of it: a year's is a twelfth, rounded to the minor unit. */
export function monthlyAmount(price: { amount: number; interval: "month" | "year" }): number {
  return price.interval === "year" ? Math.round(price.amount / 12) : price.amount;
}

/** One workspace on the instance's Billing overview (#180): its plan and what it owes. */
export interface BillingWorkspaceRow {
  id: string;
  name: string;
  /** Null on no plan (the internal plan). */
  plan: { id: string; name: string } | null;
  status: WorkspacePlan["status"];
  /** Null for a plan by agreement. */
  price: PlanChoice["price"] | null;
  trialEndsAt: string | null;
  renewsAt: string | null;
  cancelsAt: string | null;
  subscribed: boolean;
  /** When a payment first failed, while it is owed. */
  pastDueSince: string | null;
  /** The oldest open invoice past its due date, by hand or the gateway's. */
  overdue: { number: string | null; dueAt: string } | null;
  /** Suspended by dunning (not by an operator): waiving reopens it. */
  dunningSuspended: boolean;
  /** Credits held for its next invoice by hand (#445), by currency; none for the gateway's. */
  credits: { amount: number; currency: string }[];
  /** Its latest invoice from the gateway with a page, which can be sent again (#445). */
  latestInvoice: { number: string | null; issuedAt: string } | null;
}

/** The instance's Billing overview (#180). Amounts in each currency's minor unit. */
export interface BillingOverview {
  gateway: "stripe" | null;
  /** What the workspaces on a priced plan pay in a month, by currency, most workspaces first. */
  revenue: { amount: number; currency: string; workspaces: number }[];
  /** Workspaces paying (active or owing), and of them how many are on a plan by agreement. */
  paying: number;
  custom: number;
  trials: { count: number; soonestEnd: string | null };
  overdue: { count: number; longest: { name: string; since: string } | null };
  /** Payments the gateway said failed this calendar month. */
  failedPayments: number;
  /** The gateway's next payout to the instance; null with none due or none known. */
  nextPayout: { amount: number; currency: string; arrivesAt: string } | null;
  workspaces: BillingWorkspaceRow[];
}

/**
 * Waiving what a workspace owes (#180): its open invoices are voided, dunning ends, and a
 * workspace dunning suspended opens again. Said why, for the instance's events.
 */
export const waiveInput = z.object({ reason: z.string().trim().min(1, "Say why").max(200) });

/** An operator applies one of the instance's promo codes to a workspace's subscription (#445). */
export const workspacePromoInput = z.object({
  code: z.string().trim().min(1, "Type a code").max(40),
});

/**
 * A credit toward what a workspace next owes (#445): its customer's balance at the gateway, or,
 * invoiced by hand, held for its next invoice. Said why, for the instance's events.
 */
export const creditInput = z.object({
  amount: z.number().int().positive().max(100_000_000),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, { error: "A three-letter currency code, such as GBP" }),
  reason: z.string().trim().min(1, "Say why").max(200),
});
export type CreditInput = z.input<typeof creditInput>;

/** A credit given (#445). */
export interface BillingCredit {
  id: string;
  /** Through the gateway (its customer's balance), or held for the next invoice by hand. */
  source: InvoiceSource;
  amount: number;
  currency: string;
  reason: string;
  /** The invoice by hand it was taken off; null while held, and always for the gateway's. */
  invoiceId: string | null;
  createdAt: string;
}

/**
 * Credits held for a workspace invoiced by hand (#445), taken off an invoice of `amount`: the
 * oldest first, each whole while it fits; the first that does not fit is split, and what is left
 * of it held for the next invoice. Credits after it wait. Pure, so the arithmetic is tested.
 */
export function creditsAgainst<T extends { amount: number }>(
  held: T[],
  amount: number,
): { taken: { credit: T; amount: number }[]; remainder: { credit: T; amount: number } | null } {
  const taken: { credit: T; amount: number }[] = [];
  let left = amount;
  for (const credit of held) {
    if (left <= 0) break;
    if (credit.amount <= left) {
      taken.push({ credit, amount: credit.amount });
      left -= credit.amount;
      continue;
    }
    taken.push({ credit, amount: left });
    return { taken, remainder: { credit, amount: credit.amount - left } };
  }
  return { taken, remainder: null };
}

/** How the instance takes payment (#180), for its Billing section's Gateways tab. */
export interface BillingGatewayStatus {
  /** HEKATE_BILLING: through Stripe, or invoices by hand alone. */
  mode: "stripe" | "manual";
  /** Stripe's side, with billing through it: null otherwise. */
  stripe: {
    /** The account payments go to; null when Stripe could not say (a key without the right). */
    account: { id: string; name: string | null } | null;
    /** Test-mode keys alone, for now (decision 210). */
    test: boolean;
    tax: boolean;
    /** The last event its webhook delivered, and how many failed in the last week. */
    lastEventAt: string | null;
    failedEvents: number;
    /** Where Stripe sends its events. */
    webhookUrl: string;
  } | null;
  /** Invoices made by hand still open, across workspaces. */
  openByHand: number;
}

/** A month as reports name it: `2026-10`. */
export type MonthKey = `${number}-${string}`;

/** The month a moment falls in, in UTC. */
export const monthKeyOf = (at: Date): MonthKey =>
  `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}` as MonthKey;

/** The last so many months, oldest first, ending with the one `now` is in. */
export function monthsBack(now: Date, count: number): MonthKey[] {
  return Array.from({ length: count }, (_, i) =>
    monthKeyOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (count - 1 - i), 1))),
  );
}

/**
 * An invoice's payment spread over the months it pays for, by days (#180's revenue
 * recognition): a year paid in March is a twelfth a month. One with no period is the month it
 * was paid. Each share is whole minor units, and the shares add up to what was paid.
 */
export function recognise(invoice: {
  amountPaid: number;
  paidAt: Date;
  periodStart: Date | null;
  periodEnd: Date | null;
}): { month: MonthKey; amount: number }[] {
  const { periodStart: start, periodEnd: end, amountPaid } = invoice;
  if (!start || !end || end <= start)
    return [{ month: monthKeyOf(invoice.paidAt), amount: amountPaid }];
  const total = end.getTime() - start.getTime();
  const parts: { month: MonthKey; ms: number }[] = [];
  let cursor = start;
  while (cursor < end) {
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    const until = next < end ? next : end;
    parts.push({ month: monthKeyOf(cursor), ms: until.getTime() - cursor.getTime() });
    cursor = until;
  }
  // Each share rounded down, and what rounding left given to the last.
  const shares = parts.map((p) => ({
    month: p.month,
    amount: Math.floor((amountPaid * p.ms) / total),
  }));
  const given = shares.reduce((sum, s) => sum + s.amount, 0);
  const last = shares.at(-1);
  if (last) last.amount += amountPaid - given;
  return shares;
}

/** Share of the paying base lost in a period, or null with nobody to lose. */
export const churnRate = (lost: number, payingNow: number) =>
  lost + payingNow === 0 ? null : lost / (lost + payingNow);

/** The instance's Billing reports (#180), in one currency: the instance's. */
export interface BillingReports {
  currency: string;
  /** What paying workspaces' plans are worth a month at list price, and a year. */
  mrr: number;
  arr: number;
  /** Paying workspaces on a priced plan in this currency, and what each pays on average. */
  paying: number;
  average: number | null;
  /** Workspaces whose plan ended in the last 90 days, against those paying now. */
  churn: { lost: number; rate: number | null };
  /** What was collected, and from how many workspaces, each of the last twelve months. */
  months: { month: MonthKey; collected: number; workspaces: number }[];
  /** Where the monthly revenue comes from: each plan, its workspaces and its share. */
  byPlan: { planId: string; name: string; workspaces: number; amount: number; share: number }[];
  /** Other currencies some plans are priced in, left out of these figures. */
  otherCurrencies: string[];
}

/** The period an export covers: these months, oldest first, both included. */
export const exportPeriod = z.object({
  from: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  to: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
});

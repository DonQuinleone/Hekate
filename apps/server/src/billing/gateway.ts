import type { InvoiceStatus, WorkspacePlanStatus } from "@hekate/shared";

/**
 * A billing gateway (#178): what takes a workspace's payments. Stripe is the first; Paddle can
 * follow behind the same interface. Each gateway reads its own webhooks into facts in Hekate's
 * terms, and everything after that (plans, invoices, dunning) is the same for all of them.
 */
export interface Gateway {
  readonly kind: "stripe";
  /** Make the workspace a customer, once: asked again, the same customer comes back. */
  createCustomer(input: { organisationId: string; name: string; email: string }): Promise<string>;
  /** A checkout for an owner to pay for a plan the first time: its page and when it lapses. */
  checkout(input: {
    organisationId: string;
    customerId: string;
    plan: PricedPlan;
    /** Kept from a trial the workspace is already on, so it converts at its end. */
    trialEnd: Date | null;
    /** A promo code's discount, when one was given. */
    discount: Discount | null;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ id: string; url: string; expiresAt: Date }>;
  /**
   * Close a checkout no longer wanted, so it cannot be paid as well as a later one. `complete`
   * when it was paid already, and so cannot be.
   */
  closeCheckout(id: string): Promise<"closed" | "complete">;
  /**
   * A subscription as it stands now: what its events are read against, whatever their order.
   * Null when the gateway no longer has it.
   */
  subscription(subscriptionId: string): Promise<SubscriptionFact | null>;
  /** An invoice as it stands now, likewise; null once it is gone (a draft deleted). */
  invoice(invoiceId: string): Promise<InvoiceFacts | null>;
  /** What an event kept in the gateway log means, to take it again (#159's replay). */
  factOf(payload: unknown): Fact;
  /** Move a subscription to another plan, the difference pro-rated. */
  changePlan(input: {
    subscriptionId: string;
    plan: PricedPlan;
    discount: Discount | null;
  }): Promise<void>;
  /** Where an owner changes the card and billing details, and reads past invoices. */
  portal(input: { customerId: string; returnUrl: string }): Promise<string>;
  /** A webhook, verified; throws when its signature does not hold. */
  read(body: string, header: (name: string) => string | undefined): GatewayEvent;
}

/** A promo code's discount (#178), as the gateway is to give it. */
export interface Discount {
  /** The code's id: what the gateway's own discount is named after. */
  promoId: string;
  /** As people type it. */
  code: string;
  percentOff: number | null;
  amountOff: number | null;
  currency: string | null;
  /** Null for as long as the subscription lasts. */
  months: number | null;
}

export interface PricedPlan {
  id: string;
  name: string;
  price: { amount: number; currency: string; interval: "month" | "year" };
}

/** An event, as the gateway sent it, and what it means here. */
export interface GatewayEvent {
  id: string;
  type: string;
  occurredAt: Date;
  payload: unknown;
  fact: Fact;
}

export interface InvoiceFacts {
  gatewayId: string;
  /** The subscription it bills; null for one made by hand in the gateway. */
  subscriptionId: string | null;
  number: string | null;
  status: InvoiceStatus;
  currency: string;
  amountDue: number;
  amountPaid: number;
  periodStart: Date | null;
  periodEnd: Date | null;
  issuedAt: Date;
  dueAt: Date | null;
  paidAt: Date | null;
  url: string | null;
}

/** A subscription as it stands. A null status changes nothing about the plan. */
export interface SubscriptionFact {
  kind: "subscription";
  customerId: string;
  subscriptionId: string;
  planId: string | null;
  status: WorkspacePlanStatus | null;
  trialEndsAt: Date | null;
  renewsAt: Date | null;
  ended: boolean;
  amount: number | null;
  currency: string | null;
}

export type Fact =
  /** An owner finished checking out: the workspace's subscription is known. */
  | {
      kind: "checkout";
      checkoutId: string;
      organisationId: string;
      customerId: string;
      subscriptionId: string;
    }
  /** A checkout lapsed unpaid: the promo code it held is given back. */
  | { kind: "checkout_expired"; checkoutId: string }
  /** A subscription began, changed or ended. */
  | SubscriptionFact
  /** An invoice was made, finalised, paid, failed or voided. */
  | {
      kind: "invoice";
      customerId: string;
      invoice: InvoiceFacts;
      outcome: "paid" | "failed" | null;
    }
  /** Money paid out to the instance: belongs to no workspace. */
  | { kind: "payout"; amount: number; currency: string }
  /** Anything else: kept in the log, nothing done. */
  | { kind: "other" };

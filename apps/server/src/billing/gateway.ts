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
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ id: string; url: string; expiresAt: Date }>;
  /**
   * Close a checkout no longer wanted, so it cannot be paid as well as a later one. `complete`
   * when it was paid already, and so cannot be.
   */
  closeCheckout(id: string): Promise<"closed" | "complete">;
  /** A subscription as it stands now: what its events are read against, whatever their order. */
  subscription(subscriptionId: string): Promise<SubscriptionFact>;
  /** Move a subscription to another plan, the difference pro-rated. */
  changePlan(input: { subscriptionId: string; plan: PricedPlan }): Promise<void>;
  /** Where an owner changes the card and billing details, and reads past invoices. */
  portal(input: { customerId: string; returnUrl: string }): Promise<string>;
  /** A webhook, verified; throws when its signature does not hold. */
  read(body: string, header: (name: string) => string | undefined): GatewayEvent;
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
  | { kind: "checkout"; organisationId: string; customerId: string; subscriptionId: string }
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

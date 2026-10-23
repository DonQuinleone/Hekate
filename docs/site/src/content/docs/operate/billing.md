---
title: Billing
description: Taking payment for plans through Stripe, the webhook it needs, what happens when a payment fails, and the test that proves it.
---

Billing is for a hosted offering. A self-hosted install leaves it off (`HEKATE_BILLING=off`, the default) and none of this applies: every workspace is on the internal plan, with everything included.

With `HEKATE_BILLING=stripe`, each workspace pays for its [plan](../quotas/#plans) through Stripe. For now Hekate takes test-mode keys only; live keys follow with the hosted offering.

## Set it up

1. In Stripe (test mode), make a secret key, or a restricted key allowed to write customers, products, Checkout sessions, customer portal sessions and subscriptions. Set it as `STRIPE_SECRET_KEY`.
2. Add a webhook endpoint for `https://<your instance>/api/hooks/billing/stripe`, sending at least `checkout.session.completed`, `customer.subscription.*`, `invoice.*` and `payout.*`. Set its signing secret as `STRIPE_WEBHOOK_SECRET`.
3. Turn on the customer portal in Stripe's settings, so owners can change their card.
4. For tax, set up Stripe Tax and set `STRIPE_TAX=true`: Checkout then asks for the address and tax id it needs.

Both keys may be read from files (`STRIPE_SECRET_KEY_FILE`, `STRIPE_WEBHOOK_SECRET_FILE`). Hekate refuses to start with billing on and either missing.

## How a workspace pays

- **Choosing a plan.** A workspace's owner chooses one of the plans that have a price and are not hidden or retired. The first time, Hekate makes the workspace a Stripe customer and sends the owner to Stripe Checkout; only one checkout is open at a time, so a workspace never pays for two subscriptions. After that, a change goes straight to the subscription, the difference pro-rated. A trial the workspace is already on carries over, so it converts when the trial would have ended.
- **The card.** Owners change it, and the billing details, in Stripe's customer portal.
- **Webhooks.** Every event is checked against the signing secret; one that does not hold is refused (401). Each event is taken once, however often Stripe sends it, and kept for the instance's Gateway log. One that fails answers 500, so Stripe sends it again.
- **Plans and limits.** A subscription's plan, status (trial, active, past due or cancelled) and renewal date come from Stripe, read from the subscription as it stands when each event arrives, so events in any order leave it right. The plan's limits are copied to the workspace as when an operator assigns one.
- **Invoices.** Each invoice Stripe reports is kept with its number, amounts, period and Stripe's page for it, and listed in the workspace's billing settings. An invoice's status never moves back, whatever order its events arrive in.

## Invoices by hand

A plan by agreement (one without a price) is not sold through Stripe. Operators invoice for it by hand, with billing on (`stripe` or `manual`): `POST /api/instance/workspaces/:id/invoices` with the amount in the currency's minor unit, the currency and what it is for, and optionally its period and due date. Invoices by hand are numbered in the instance's own series (`HK-0001`), sent outside Hekate, and marked paid or void by hand (`POST …/invoices/:invoiceId/settle`). Each is an instance event, and each shows in the workspace's billing settings with the rest. Dunning leaves invoices by hand to the operators.

## The Gateway log

With billing on, **Logs** has a **Gateway** tab: every event Stripe sent, when it arrived, its workspace (none for a payout), what it was about, its amount, and what came of it (`taken`, `ignored` and why, or `failed` and why). It is kept for good, as a record of payments, and exports to CSV like the other logs.

**Debug tools**, **Replay**, takes a past event again. It is read against the subscription or invoice as Stripe holds it now, so taking an old event again never undoes what came after it: an old failed payment taken again after the invoice was paid leaves nothing owed. Each is an instance event.

## When a payment fails

Dunning counts from the first failed payment of the workspace's subscription (an invoice made by hand in Stripe does not count):

| After | What happens |
| --- | --- |
| 7 days | The workspace's owners are told what is owed and when the workspace will be suspended. |
| 14 days | They are told again. |
| 21 days | The workspace is suspended (an instance event, by billing), and its owners are told. |

Nothing is ever deleted for want of payment. Once a payment goes through, dunning ends, and a workspace it suspended opens again. A workspace an operator suspended, or set to be deleted, stays as the operator left it. The `billing-dunning` job runs hourly, and only with billing on; mail that fails is sent again the next hour.

## Testing it against Stripe

`apps/server/src/billing/stripe.integration.test.ts` runs against Stripe's test mode when `STRIPE_TEST_SECRET_KEY` holds a test-mode key. On a test clock, it takes a workspace through a week's trial to its first payment, then makes the renewal fail and checks the workspace is suspended three weeks later. CI runs it when the repository has the `STRIPE_TEST_SECRET_KEY` secret.

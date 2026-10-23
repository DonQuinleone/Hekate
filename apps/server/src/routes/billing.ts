import { checkoutInput } from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { type BillingDeps, billingOf, changePlan, portalFor } from "../billing/billing.ts";
import { requireRole, type TenantVariables } from "../tenancy.ts";

/**
 * `/api/organisation/billing` (#178): the workspace's plan, the plans it may choose and its
 * invoices, for its admins; changing the plan and the card, for its owners alone, as they are
 * the ones who pay.
 */
export const billingRoutes = (deps: BillingDeps) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/", requireRole("admin"), async (c) =>
      c.json(await billingOf(deps.db, c.var.organisationId, deps.gateway)),
    )
    .post("/checkout", requireRole("owner"), zValidator("json", checkoutInput), async (c) =>
      c.json(
        await changePlan(deps, {
          organisationId: c.var.organisationId,
          userId: c.var.userId,
          ...c.req.valid("json"),
        }),
      ),
    )
    .post("/portal", requireRole("owner"), async (c) =>
      c.json({ url: await portalFor(deps, c.var.organisationId) }),
    );

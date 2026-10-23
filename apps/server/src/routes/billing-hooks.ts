import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { type BillingDeps, takeGatewayEvent } from "../billing/billing.ts";
import { Unsigned } from "../billing/stripe.ts";

/**
 * `/api/hooks/billing` (#178): where the gateway sends its events. Open to anyone, as the
 * gateway has no session; an event counts only once its signature holds, and counts once
 * however often it is sent. One that fails answers 500, so the gateway sends it again.
 */
export const billingHookRoutes = (deps: BillingDeps) =>
  new Hono().post("/stripe", async (c) => {
    const gateway = deps.gateway;
    if (gateway?.kind !== "stripe") throw new HTTPException(404, { message: "No billing here" });
    let event: ReturnType<typeof gateway.read>;
    try {
      event = gateway.read(await c.req.text(), (name) => c.req.header(name));
    } catch (error) {
      if (error instanceof Unsigned || error instanceof SyntaxError)
        throw new HTTPException(401, { message: error.message });
      throw error;
    }
    const { result } = await takeGatewayEvent(deps, gateway.kind, event);
    return c.json({ received: true, result });
  });

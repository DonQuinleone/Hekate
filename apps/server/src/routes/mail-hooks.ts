import type { Database } from "@hekate/db";
import type { BounceProvider } from "@hekate/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Keyring } from "../keyring.ts";
import { type Fetcher, readBounces, recordBounces, Unverified } from "../mail-bounces.ts";
import { zValidator } from "../openapi/validator.ts";
import { bounceConfigOf } from "../workspace-mail.ts";

export interface MailHookDeps {
  db: Database;
  keyring: Keyring;
  /** The instance's provider, where it reports bounces, and the secret it signs them with. */
  instance: { provider: BounceProvider; secret: string } | null;
  /** For tests: how Amazon SNS's certificates and subscription addresses are reached. */
  fetch?: Fetcher;
}

/**
 * `/api/hooks/mail` (#161): where mail providers send their bounce and complaint reports. Open to
 * anyone, as a provider has no session; a report counts only once its signature holds against the
 * secret the operator (the instance's) or the workspace (its own mail's) gave. One that does not
 * is refused with 401 and changes nothing.
 */
export const mailHookRoutes = (deps: MailHookDeps) => {
  const take = async (
    provider: BounceProvider,
    secret: string,
    scope: { organisationId: string } | "instance",
    body: string,
    header: (name: string) => string | undefined,
  ) => {
    try {
      const reports = await readBounces(provider, secret, body, header, {
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
      await recordBounces(deps.db, scope, provider, reports);
    } catch (error) {
      if (error instanceof Unverified) throw new HTTPException(401, { message: error.message });
      throw error;
    }
  };
  return new Hono()
    .post("/instance", async (c) => {
      if (!deps.instance) throw new HTTPException(404, { message: "No bounce reports here" });
      await take(
        deps.instance.provider,
        deps.instance.secret,
        "instance",
        await c.req.text(),
        (n) => c.req.header(n),
      );
      return c.body(null, 204);
    })
    .post(
      "/workspaces/:organisationId",
      zValidator("param", z.object({ organisationId: z.uuid() })),
      async (c) => {
        const { organisationId } = c.req.valid("param");
        const config = await bounceConfigOf(deps.db, deps.keyring, organisationId);
        // The same answer whether the workspace is unknown or has no reports to take.
        if (!config) throw new HTTPException(404, { message: "No bounce reports here" });
        await take(config.provider, config.secret, { organisationId }, await c.req.text(), (n) =>
          c.req.header(n),
        );
        return c.body(null, 204);
      },
    );
};

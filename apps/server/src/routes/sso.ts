import type { Database } from "@hekate/db";
import { ssoSettingsInput } from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { type Audit, requestInfo } from "../audit.ts";
import { SsoProblem, saveSso, serviceProvider, ssoOf } from "../sso.ts";
import { requireRole, type TenantVariables } from "../tenancy.ts";

/**
 * `/api/organisation/sso`: the workspace's single sign-on. Admins read and change it; the
 * client secret goes in and is never sent back. Saving an OIDC issuer reads its discovery
 * document then and there, so a wrong issuer is found at once rather than at sign-in.
 */
export const ssoRoutes = (
  db: Database,
  audit: Audit,
  context: { baseURL: string; trusted: string[]; trustProxy: boolean },
) =>
  new Hono<{ Variables: TenantVariables }>()
    .use("*", requireRole("admin"))
    .get("/", async (c) =>
      c.json({
        sso: await ssoOf(db, c.var.organisationId),
        serviceProvider: serviceProvider(context.baseURL, c.var.organisationId),
      }),
    )
    .put("/", zValidator("json", ssoSettingsInput), async (c) => {
      const input = c.req.valid("json");
      await saveSso(db, c.var.organisationId, c.var.userId, input, context).catch((error) => {
        if (error instanceof SsoProblem) throw new HTTPException(422, { message: error.message });
        throw error;
      });
      const { clientSecret, ...change } = input;
      await audit.record(
        c.var.organisationId,
        await audit.member(c.var.userId),
        {
          action: "organisation.sso",
          details: { ...change, clientSecret: clientSecret === undefined ? "kept" : "changed" },
        },
        requestInfo(c, context.trustProxy),
      );
      return c.json({
        sso: await ssoOf(db, c.var.organisationId),
        serviceProvider: serviceProvider(context.baseURL, c.var.organisationId),
      });
    });

import type { Database } from "@hekate/db";
import { Hono } from "hono";
import { workspacePlanOf } from "../plans.ts";
import type { TenantVariables } from "../tenancy.ts";

/**
 * `/api/organisation/plan` (#177): the plan this workspace is on and what it gives, so its pages
 * can show what is included and leave out what is not. Any member may read it; only the
 * instance's operators change it.
 */
export const planRoutes = (db: Database, billing: boolean) =>
  new Hono<{ Variables: TenantVariables }>().get("/", async (c) =>
    c.json(await workspacePlanOf(db, c.var.organisationId, billing)),
  );

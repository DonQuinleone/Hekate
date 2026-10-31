import { type Database, inOrg, schema } from "@hekate/db";
import type { WorkspaceOperations } from "@hekate/shared";
import { desc } from "drizzle-orm";
import { Hono } from "hono";
import { requireRole, type TenantVariables } from "../tenancy.ts";
import { pendingRewrap } from "../workspace-keys.ts";

/**
 * `/api/organisation/operations` (#165): for the owner, what they act on that the workspace's
 * other pages do not already say: how its files are encrypted. The release, the worker, the
 * queues and the metrics are the instance's operators' (decision 288), under Instance,
 * Operations, and never sent here. Owners only.
 */
export const operationsRoutes = (deps: { db: Database }) =>
  new Hono<{ Variables: TenantVariables }>().use("*", requireRole("owner")).get("/", async (c) => {
    const { db } = deps;
    const org = c.var.organisationId;
    const keys = schema.organisationKeys;
    const [key] = await db
      .select({ version: keys.version, createdAt: keys.createdAt })
      .from(keys)
      .where(inOrg(keys, org))
      .orderBy(desc(keys.version))
      .limit(1);
    return c.json({
      encryption: {
        keyVersion: key?.version ?? null,
        keySince: key?.createdAt.toISOString() ?? null,
        behind: key ? await pendingRewrap(db, org, key.version) : 0,
      },
    } satisfies WorkspaceOperations);
  });

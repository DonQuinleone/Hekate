import type { Database } from "@hekate/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Audit } from "../audit.ts";
import { admit } from "../rate-limit.ts";
import type { Storage } from "../storage.ts";
import { recordedReconciliation, workspaceStorage } from "../storage-usage.ts";
import { requireRole, type TenantVariables } from "../tenancy.ts";

/**
 * `/api/organisation/storage/usage` and `/reconcile` (#163): what the workspace keeps, per
 * backend and per project, what the reconciliation found in it, and a run over this workspace
 * alone. Admins only.
 */
export const storageSettingsRoutes = (deps: {
  db: Database;
  storage: Storage;
  audit: Audit;
  /** STORAGE_RECONCILE: whether runs remove what nothing uses, or only report it. */
  removing: boolean;
}) =>
  new Hono<{ Variables: TenantVariables }>()
    .use("*", requireRole("admin"))
    .get("/usage", async (c) =>
      c.json(await workspaceStorage(deps.db, c.var.organisationId, deps.removing)),
    )
    // A run over this workspace: what it finds is recorded, and acted on only by a later run a
    // day on, as at night. A few a quarter of an hour, so it cannot keep the storage busy.
    .post("/reconcile", async (c) => {
      const { allowed } = await admit(deps.db, `reconcile:${c.var.organisationId}`, {
        max: 3,
        windowMs: 15 * 60_000,
      });
      if (!allowed)
        throw new HTTPException(429, {
          message: "The storage was checked moments ago. Try again in a quarter of an hour.",
        });
      await recordedReconciliation(deps, {
        remove: deps.removing,
        organisationId: c.var.organisationId,
      });
      return c.json(await workspaceStorage(deps.db, c.var.organisationId, deps.removing));
    });

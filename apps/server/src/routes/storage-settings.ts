import { type Database, schema } from "@hekate/db";
import {
  bucketIdOf,
  bucketLine,
  entitled,
  organisationStorageInput,
  type WorkspaceStorage,
  workspaceBucketInput,
} from "@hekate/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { type Audit, requestInfo } from "../audit.ts";
import { zValidator } from "../openapi/validator.ts";
import { assertEntitled, workspacePlanOf } from "../plans.ts";
import { admit } from "../rate-limit.ts";
import type { Storage } from "../storage.ts";
import { recordedReconciliation, workspaceStorage } from "../storage-usage.ts";
import { requireRole, type TenantVariables } from "../tenancy.ts";
import { BucketRefused } from "../workspace-buckets.ts";

const { organisations } = schema;

/**
 * `/api/organisation/storage`: where the workspace's new files go (the instance's storage, or
 * a bucket of its own on a plan that includes it, #508), what it keeps per backend and per
 * project, what the reconciliation found in it (#163), and a run over this workspace alone.
 * Admins see it; owners choose. Existing files stay where they are. A bucket's access key and
 * secret go in and never come back.
 */
export const storageSettingsRoutes = (deps: {
  db: Database;
  storage: Storage;
  audit: Audit;
  /** STORAGE_RECONCILE: whether runs remove what nothing uses, or only report it. */
  removing: boolean;
  /** The billing module is on: the workspace's plan decides (#177). */
  billing?: boolean;
  trustProxy?: boolean;
}) => {
  const { db, storage, audit } = deps;
  const billing = deps.billing ?? false;

  const view = async (organisationId: string): Promise<WorkspaceStorage> => {
    const [[organisation], bucket, plan] = await Promise.all([
      db
        .select({ backend: organisations.storageBackend })
        .from(organisations)
        .where(eq(organisations.id, organisationId)),
      storage.buckets.current(organisationId),
      workspacePlanOf(db, organisationId, billing),
    ]);
    const chosen = organisation?.backend ?? null;
    const usesBucket = chosen !== null && bucketIdOf(chosen) !== null;
    return {
      backend: usesBucket ? null : chosen,
      defaultBackend: storage.backends.defaultBackend,
      available: storage.backends.names(),
      usesBucket,
      bucket,
      ownStorage: {
        entitled: entitled(plan.entitlements, "ownStorage"),
        plan: plan.plan?.name ?? null,
      },
    };
  };

  /** Reaching a bucket is reaching out: a few a quarter of an hour, saves and tests together. */
  const limit = async (organisationId: string) => {
    const { allowed } = await admit(db, `bucket:${organisationId}`, {
      max: 20,
      windowMs: 15 * 60_000,
    });
    if (!allowed)
      throw new HTTPException(429, {
        message:
          "The bucket has been tried many times just now. Try again in a quarter of an hour.",
      });
  };
  const refused = (error: unknown): never => {
    if (error instanceof BucketRefused) throw new HTTPException(422, { message: error.message });
    throw error;
  };

  return (
    new Hono<{ Variables: TenantVariables }>()
      .use("*", requireRole("admin"))
      .get("/", async (c) => c.json(await view(c.var.organisationId)))
      // One of the instance's backends, or its default (null): back from a bucket of its own too.
      .put("/", requireRole("owner"), zValidator("json", organisationStorageInput), async (c) => {
        const { backend } = c.req.valid("json");
        if (backend !== null && !storage.backends.has(backend)) {
          throw new HTTPException(400, {
            message: `Storage backend "${backend}" is not configured`,
          });
        }
        // Existing objects stay where they are; only new objects use the new backend.
        await db
          .update(organisations)
          .set({ storageBackend: backend })
          .where(eq(organisations.id, c.var.organisationId));
        await audit.record(
          c.var.organisationId,
          await audit.member(c.var.userId),
          { action: "organisation.storage", details: { backend: backend ?? "default" } },
          requestInfo(c, deps.trustProxy ?? false),
        );
        return c.json(await view(c.var.organisationId));
      })
      // The workspace's own bucket, tested with a probe object, saved and given its new files.
      .put("/bucket", requireRole("owner"), zValidator("json", workspaceBucketInput), async (c) => {
        const organisationId = c.var.organisationId;
        await assertEntitled(db, organisationId, billing, "ownStorage");
        await limit(organisationId);
        const input = c.req.valid("json");
        const bucket = await storage.buckets.save(organisationId, input).catch(refused);
        await audit.record(
          organisationId,
          await audit.member(c.var.userId),
          {
            action: "organisation.storage",
            details: {
              bucket: bucketLine(bucket),
              credentials: input.accessKeyId || input.secretAccessKey ? "changed" : "kept",
            },
          },
          requestInfo(c, deps.trustProxy ?? false),
        );
        return c.json(await view(organisationId));
      })
      // A probe object written and deleted with these details, nothing saved.
      .post(
        "/bucket/test",
        requireRole("owner"),
        zValidator("json", workspaceBucketInput),
        async (c) => {
          const organisationId = c.var.organisationId;
          await assertEntitled(db, organisationId, billing, "ownStorage");
          await limit(organisationId);
          return c.json(
            await storage.buckets.test(organisationId, c.req.valid("json")).catch(refused),
          );
        },
      )
      .get("/usage", async (c) =>
        c.json(await workspaceStorage(db, c.var.organisationId, deps.removing)),
      )
      // A run over this workspace: what it finds is recorded, and acted on only by a later run a
      // day on, as at night. A few a quarter of an hour, so it cannot keep the storage busy.
      .post("/reconcile", async (c) => {
        const { allowed } = await admit(db, `reconcile:${c.var.organisationId}`, {
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
        return c.json(await workspaceStorage(db, c.var.organisationId, deps.removing));
      })
  );
};

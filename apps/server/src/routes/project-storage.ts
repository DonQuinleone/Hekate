import { type Database, inOrg, schema } from "@hekate/db";
import { organisationStorageInput } from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, can } from "../access.ts";
import { NotFound } from "../errors.ts";
import type { Storage } from "../storage.ts";
import { projectBytes } from "../storage-usage.ts";
import { requireRole, type TenantVariables } from "../tenancy.ts";

const { organisations, projects } = schema;

const idParam = zValidator("param", z.object({ id: z.uuid() }));

/**
 * `/api/projects/:id/storage` (#240): where this project's new files go, and how much it keeps.
 * Like the workspace's own storage, workspace admins see it and owners choose; existing files
 * stay where they are.
 */
export const projectStorageRoutes = (deps: { db: Database; storage: Storage }) => {
  const { db, storage } = deps;
  const view = async (organisationId: string, projectId: string) => {
    const [[project], [organisation], [usage]] = await Promise.all([
      db
        .select({ backend: projects.storageBackend })
        .from(projects)
        .where(inOrg(projects, organisationId, eq(projects.id, projectId))),
      db
        .select({ backend: organisations.storageBackend })
        .from(organisations)
        .where(eq(organisations.id, organisationId)),
      projectBytes(db, organisationId, projectId),
    ]);
    if (!project) throw new NotFound("Project");
    return {
      /** The project's choice; null follows the workspace's. */
      backend: project.backend,
      /** What new files go to when the project has no choice of its own. */
      workspaceBackend: organisation?.backend ?? storage.backends.defaultBackend,
      available: storage.backends.names(),
      bytes: Number(usage?.bytes ?? 0),
    };
  };
  return new Hono<{ Variables: TenantVariables }>()
    .get("/:id/storage", requireRole("admin"), idParam, async (c) => {
      const { projectId } = await can(db, actorOf(c.var), "view", c.req.valid("param").id);
      return c.json(await view(c.var.organisationId, projectId));
    })
    .put(
      "/:id/storage",
      requireRole("owner"),
      idParam,
      zValidator("json", organisationStorageInput),
      async (c) => {
        const { projectId, archived } = await can(
          db,
          actorOf(c.var),
          "view",
          c.req.valid("param").id,
        );
        // An archived project is read-only for everyone until it is unarchived.
        if (archived) {
          throw new HTTPException(409, { message: "This project is archived; unarchive it first" });
        }
        const { backend } = c.req.valid("json");
        if (backend !== null && !storage.backends.has(backend)) {
          throw new HTTPException(400, {
            message: `Storage backend "${backend}" is not configured`,
          });
        }
        // Existing objects stay where they are; only new ones use the new backend.
        await db
          .update(projects)
          .set({ storageBackend: backend, updatedAt: new Date() })
          .where(inOrg(projects, c.var.organisationId, eq(projects.id, projectId)));
        return c.json(await view(c.var.organisationId, projectId));
      },
    );
};

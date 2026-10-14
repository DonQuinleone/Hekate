import { type Database, inOrg, schema } from "@hekate/db";
import { projectProfile } from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { asc, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { NotFound } from "../errors.ts";
import type { TenantVariables } from "../tenancy.ts";

const { projects, files, users } = schema;

export const createProjectInput = z.object({
  name: z.string().trim().min(1).max(120),
  profile: projectProfile,
});

export const projectRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/", async (c) => {
      const rows = await db
        .select()
        .from(projects)
        .where(inOrg(projects, c.var.organisationId, isNull(projects.archivedAt)))
        .orderBy(desc(projects.createdAt));
      return c.json({ projects: rows });
    })
    .post("/", zValidator("json", createProjectInput), async (c) => {
      const input = c.req.valid("json");
      const [project] = await db
        .insert(projects)
        .values({ ...input, organisationId: c.var.organisationId })
        .returning();
      return c.json({ project }, 201);
    })
    .get("/:id", zValidator("param", z.object({ id: z.uuid() })), async (c) => {
      const { id } = c.req.valid("param");
      const [project] = await db
        .select()
        .from(projects)
        .where(inOrg(projects, c.var.organisationId, eq(projects.id, id)));
      if (!project) throw new NotFound("Project");
      return c.json({ project });
    })
    .get("/:id/files", zValidator("param", z.object({ id: z.uuid() })), async (c) => {
      const { id } = c.req.valid("param");
      const organisationId = c.var.organisationId;
      const [project] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(inOrg(projects, organisationId, eq(projects.id, id)));
      if (!project) throw new NotFound("Project");
      // Metadata only: file contents leave Hekate solely through protected delivery.
      const rows = await db
        .select({
          id: files.id,
          folderId: files.folderId,
          name: files.name,
          kind: files.kind,
          contentType: files.contentType,
          byteSize: files.byteSize,
          mediaInfo: files.mediaInfo,
          streamStatus: files.streamStatus,
          peaksStatus: files.peaksStatus,
          uploadedBy: users.name,
          createdAt: files.createdAt,
        })
        .from(files)
        .leftJoin(users, eq(files.uploadedBy, users.id))
        .where(inOrg(files, organisationId, eq(files.projectId, project.id)))
        .orderBy(asc(files.name), desc(files.createdAt));
      return c.json({ files: rows });
    });

import { type Database, inOrg, schema } from "@hekate/db";
import {
  creatorRole,
  defaultProjectRoles,
  projectPermissions,
  projectProfile,
  updateProjectInput,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { asc, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, can, visibleProjects } from "../access.ts";
import type { TenantVariables } from "../tenancy.ts";

const { projects, files, users, projectRoles, projectMembers } = schema;

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
        .where(
          inOrg(
            projects,
            c.var.organisationId,
            isNull(projects.archivedAt),
            visibleProjects(actorOf(c.var)),
          ),
        )
        .orderBy(desc(projects.createdAt));
      return c.json({ projects: rows });
    })
    // Any member may start a project. It comes with the default roles, and its creator is
    // its first Producer.
    .post("/", zValidator("json", createProjectInput), async (c) => {
      const input = c.req.valid("json");
      const organisationId = c.var.organisationId;
      const project = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(projects)
          .values({ ...input, organisationId })
          .returning();
        if (!created) throw new Error("Project insert returned no row");
        const roles = await tx
          .insert(projectRoles)
          .values(
            defaultProjectRoles.map((role, position) => ({
              organisationId,
              projectId: created.id,
              name: role.name,
              permissions: role.permissions,
              position,
            })),
          )
          .returning({ id: projectRoles.id, name: projectRoles.name });
        const producer = roles.find((r) => r.name === creatorRole);
        if (!producer) throw new Error("The default roles have no creator role");
        await tx.insert(projectMembers).values({
          organisationId,
          projectId: created.id,
          userId: c.var.userId,
          roleId: producer.id,
        });
        return created;
      });
      // The creator is its Producer, who may do everything.
      return c.json({ project: { ...project, permissions: [...projectPermissions] } }, 201);
    })
    .get("/:id", zValidator("param", z.object({ id: z.uuid() })), async (c) => {
      const access = await can(db, actorOf(c.var), "view", c.req.valid("param").id);
      const [project] = await db
        .select()
        .from(projects)
        .where(inOrg(projects, c.var.organisationId, eq(projects.id, access.projectId)));
      // What the caller may do here, so the interface offers only that (the server still checks).
      return c.json({ project: { ...project, permissions: [...access.permissions] } });
    })
    // Settings are part of how the project's work flows.
    .patch(
      "/:id",
      zValidator("param", z.object({ id: z.uuid() })),
      zValidator("json", updateProjectInput),
      async (c) => {
        const access = await can(db, actorOf(c.var), "edit_workflows", c.req.valid("param").id);
        const input = c.req.valid("json");
        const [project] = await db
          .update(projects)
          .set({ ...input, updatedAt: new Date() })
          .where(inOrg(projects, c.var.organisationId, eq(projects.id, access.projectId)))
          .returning();
        return c.json({ project: { ...project, permissions: [...access.permissions] } });
      },
    )
    .get("/:id/files", zValidator("param", z.object({ id: z.uuid() })), async (c) => {
      const organisationId = c.var.organisationId;
      const access = await can(db, actorOf(c.var), "view", c.req.valid("param").id);
      const project = { id: access.projectId };
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
          analysisStatus: files.analysisStatus,
          uploadedBy: users.name,
          createdAt: files.createdAt,
        })
        .from(files)
        .leftJoin(users, eq(files.uploadedBy, users.id))
        .where(inOrg(files, organisationId, eq(files.projectId, project.id)))
        .orderBy(asc(files.name), desc(files.createdAt));
      return c.json({ files: rows });
    });

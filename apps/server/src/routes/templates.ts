import { type Database, inOrg, schema } from "@hekate/db";
import {
  type ProjectTemplate,
  saveTemplateInput,
  type TemplateContent,
  templateContent,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, can } from "../access.ts";
import { NotFound } from "../errors.ts";
import type { TenantVariables } from "../tenancy.ts";
import { categoriesOf } from "./categories.ts";

const { commentCategories, deliveryProfiles, projects, projectRoles, projectTemplates, users } =
  schema;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const idParam = zValidator("param", z.object({ id: z.uuid() }));

/** A project's set-up as a template holds it: its settings, roles and categories. */
async function snapshotOf(
  db: Database,
  organisationId: string,
  projectId: string,
): Promise<TemplateContent> {
  const [project] = await db
    .select({
      carriedCommentsShown: projects.carriedCommentsShown,
      deliveryProfile: projects.deliveryProfile,
      checkTruePeak: projects.checkTruePeak,
      requireEdl: projects.requireEdl,
      qaSettings: projects.qaSettings,
      commentReferences: projects.commentReferences,
      normalisation: projects.normalisation,
    })
    .from(projects)
    .where(inOrg(projects, organisationId, eq(projects.id, projectId)));
  if (!project) throw new NotFound("Project");
  const roles = await db
    .select({
      name: projectRoles.name,
      permissions: projectRoles.permissions,
      tools: projectRoles.tools,
    })
    .from(projectRoles)
    .where(inOrg(projectRoles, organisationId, eq(projectRoles.projectId, projectId)))
    .orderBy(asc(projectRoles.position));
  const categories = await categoriesOf(db, organisationId, projectId);
  return templateContent.parse({
    settings: {
      ...project,
      deliveryProfile: project.deliveryProfile ?? null,
      qaSettings: project.qaSettings ?? null,
      commentReferences: project.commentReferences ?? null,
    },
    roles,
    categories: categories.map((c) => ({ name: c.name, handling: c.handling, stage: c.stage })),
  });
}

/**
 * A template's content as a new project takes it: read back through its schema, and without a
 * workspace profile that has since been removed, so the project falls back to the workspace's.
 */
export async function templateFor(
  tx: Tx,
  organisationId: string,
  templateId: string,
): Promise<TemplateContent> {
  const [row] = await tx
    .select({ content: projectTemplates.content })
    .from(projectTemplates)
    .where(inOrg(projectTemplates, organisationId, eq(projectTemplates.id, templateId)));
  if (!row) throw new NotFound("Template");
  const content = templateContent.parse(row.content);
  const ref = content.settings.deliveryProfile;
  if (ref?.startsWith("custom:")) {
    const [found] = await tx
      .select({ id: deliveryProfiles.id })
      .from(deliveryProfiles)
      .where(
        inOrg(
          deliveryProfiles,
          organisationId,
          eq(deliveryProfiles.id, ref.slice("custom:".length)),
        ),
      );
    if (!found) content.settings.deliveryProfile = null;
  }
  return content;
}

/** A new project's categories, as a template or another project has them. */
export async function copyCategories(
  tx: Tx,
  organisationId: string,
  projectId: string,
  categories: TemplateContent["categories"],
) {
  if (categories.length > 0)
    await tx
      .insert(commentCategories)
      .values(categories.map((c, position) => ({ organisationId, projectId, ...c, position })));
  // Seeded now: the defaults never join them later.
  await tx
    .update(projects)
    .set({ categoriesSeeded: true })
    .where(inOrg(projects, organisationId, eq(projects.id, projectId)));
}

/** The workspace's templates, newest first, as the viewer may use and remove them. */
async function templatesOf(
  db: Database,
  organisationId: string,
  viewer: TenantVariables,
): Promise<ProjectTemplate[]> {
  const rows = await db
    .select({
      id: projectTemplates.id,
      name: projectTemplates.name,
      content: projectTemplates.content,
      createdById: projectTemplates.createdById,
      createdAt: projectTemplates.createdAt,
      createdByName: users.name,
      fromProject: projects.name,
    })
    .from(projectTemplates)
    .leftJoin(users, eq(users.id, projectTemplates.createdById))
    .leftJoin(
      projects,
      sql`${projects.id} = ${projectTemplates.fromProjectId} and ${projects.organisationId} = ${organisationId}`,
    )
    .where(inOrg(projectTemplates, organisationId))
    .orderBy(sql`${projectTemplates.createdAt} desc`);
  const admin = viewer.organisationRole === "owner" || viewer.organisationRole === "admin";
  return rows.map((r) => {
    const content = templateContent.safeParse(r.content);
    return {
      id: r.id,
      name: r.name,
      createdByName: r.createdByName,
      fromProject: r.fromProject,
      roles: content.success ? content.data.roles.map((role) => role.name) : [],
      categories: content.success ? content.data.categories.length : 0,
      removable: admin || r.createdById === viewer.userId,
      createdAt: r.createdAt.toISOString(),
    };
  });
}

/**
 * `/api/templates`: the workspace's project templates (#240). Any member may start a project
 * from one; whoever saved one, or a workspace admin, may remove it.
 */
export const templateRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/", async (c) =>
      c.json({ templates: await templatesOf(db, c.var.organisationId, c.var) }),
    )
    .delete("/:id", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const { id } = c.req.valid("param");
      const [row] = await db
        .select({ createdById: projectTemplates.createdById })
        .from(projectTemplates)
        .where(inOrg(projectTemplates, organisationId, eq(projectTemplates.id, id)));
      if (!row) throw new NotFound("Template");
      const admin = c.var.organisationRole === "owner" || c.var.organisationRole === "admin";
      if (!admin && row.createdById !== c.var.userId)
        throw new HTTPException(403, {
          message: "Only whoever saved a template, or an admin, can remove it",
        });
      await db
        .delete(projectTemplates)
        .where(inOrg(projectTemplates, organisationId, eq(projectTemplates.id, id)));
      return c.body(null, 204);
    });

/** `/api/projects/:id/template`: saving a project's set-up as a template, by those who edit it. */
export const projectTemplateRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>().post(
    "/:id/template",
    idParam,
    zValidator("json", saveTemplateInput),
    async (c) => {
      const organisationId = c.var.organisationId;
      const access = await can(db, actorOf(c.var), "edit_project", c.req.valid("param").id);
      const content = await snapshotOf(db, organisationId, access.projectId);
      const { name } = c.req.valid("json");
      const [made] = await db
        .insert(projectTemplates)
        .values({
          organisationId,
          name,
          content,
          fromProjectId: access.projectId,
          createdById: c.var.userId,
        })
        .onConflictDoNothing()
        .returning({ id: projectTemplates.id });
      if (!made)
        throw new HTTPException(409, { message: "The workspace has a template by that name" });
      const template = (await templatesOf(db, organisationId, c.var)).find((t) => t.id === made.id);
      return c.json({ template }, 201);
    },
  );

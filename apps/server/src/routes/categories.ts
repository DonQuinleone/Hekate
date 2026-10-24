import { type Database, inOrg, schema } from "@hekate/db";
import { categoryInput, defaultCategories } from "@hekate/shared";
import { asc, eq, max } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, can } from "../access.ts";
import { NotFound } from "../errors.ts";
import { zValidator } from "../openapi/validator.ts";
import type { TenantVariables } from "../tenancy.ts";

const { commentCategories, projects } = schema;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const idParam = zValidator("param", z.object({ id: z.uuid() }));

/** True when a statement failed on the named unique index. */
function violates(error: unknown, index: string): boolean {
  const cause = (error as { cause?: { code?: string; constraint_name?: string } }).cause;
  return cause?.code === "23505" && cause.constraint_name === index;
}

/**
 * Give a project its default categories, once: at its creation, or, for a project made
 * before categories existed, the first time they are read. The project row is locked, so
 * two first reads make one set.
 */
export async function seedCategories(tx: Tx, organisationId: string, projectId: string) {
  const [project] = await tx
    .select({ seeded: projects.categoriesSeeded })
    .from(projects)
    .where(inOrg(projects, organisationId, eq(projects.id, projectId)))
    .for("update");
  if (!project || project.seeded) return;
  await tx
    .insert(commentCategories)
    .values(
      defaultCategories.map((c, position) => ({ organisationId, projectId, ...c, position })),
    );
  await tx
    .update(projects)
    .set({ categoriesSeeded: true })
    .where(inOrg(projects, organisationId, eq(projects.id, projectId)));
}

/** A project's categories, in their order, seeding the defaults the first time. */
export async function categoriesOf(db: Database, organisationId: string, projectId: string) {
  await db.transaction((tx) => seedCategories(tx, organisationId, projectId));
  return db
    .select({
      id: commentCategories.id,
      name: commentCategories.name,
      handling: commentCategories.handling,
      stage: commentCategories.stage,
      position: commentCategories.position,
    })
    .from(commentCategories)
    .where(inOrg(commentCategories, organisationId, eq(commentCategories.projectId, projectId)))
    .orderBy(asc(commentCategories.position), asc(commentCategories.name));
}

const taken = () => new HTTPException(409, { message: "A category with that name exists" });

/**
 * `/api/projects/:id/categories`: the kinds of comment a project names (#36), for everyone
 * who sees it; adding one belongs to whoever edits the project's workflows.
 */
export const projectCategoryRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/:id/categories", idParam, async (c) => {
      const { projectId } = await can(db, actorOf(c.var), "view", c.req.valid("param").id);
      return c.json({ categories: await categoriesOf(db, c.var.organisationId, projectId) });
    })
    .post("/:id/categories", idParam, zValidator("json", categoryInput), async (c) => {
      const organisationId = c.var.organisationId;
      const { projectId } = await can(
        db,
        actorOf(c.var),
        "edit_workflows",
        c.req.valid("param").id,
      );
      const input = c.req.valid("json");
      try {
        const [made] = await db.transaction(async (tx) => {
          await seedCategories(tx, organisationId, projectId);
          const [last] = await tx
            .select({ position: max(commentCategories.position) })
            .from(commentCategories)
            .where(
              inOrg(commentCategories, organisationId, eq(commentCategories.projectId, projectId)),
            );
          return tx
            .insert(commentCategories)
            .values({ organisationId, projectId, ...input, position: (last?.position ?? -1) + 1 })
            .returning();
        });
        return c.json({ category: made }, 201);
      } catch (error) {
        if (violates(error, "comment_categories_name_idx")) throw taken();
        throw error;
      }
    });

/** `/api/categories/:id`: renaming a category, changing its handling, or removing it. */
export const categoryRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .patch("/:id", idParam, zValidator("json", categoryInput), async (c) => {
      const organisationId = c.var.organisationId;
      const category = await categoryOf(db, organisationId, c.req.valid("param").id);
      await can(db, actorOf(c.var), "edit_workflows", category.projectId);
      try {
        const [updated] = await db
          .update(commentCategories)
          .set({ ...c.req.valid("json"), updatedAt: new Date() })
          .where(inOrg(commentCategories, organisationId, eq(commentCategories.id, category.id)))
          .returning();
        return c.json({ category: updated });
      } catch (error) {
        if (violates(error, "comment_categories_name_idx")) throw taken();
        throw error;
      }
    })
    // Its comments keep everything else, without a category.
    .delete("/:id", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const category = await categoryOf(db, organisationId, c.req.valid("param").id);
      await can(db, actorOf(c.var), "edit_workflows", category.projectId);
      await db
        .delete(commentCategories)
        .where(inOrg(commentCategories, organisationId, eq(commentCategories.id, category.id)));
      return c.body(null, 204);
    });

async function categoryOf(db: Database, organisationId: string, id: string) {
  const [category] = await db
    .select({ id: commentCategories.id, projectId: commentCategories.projectId })
    .from(commentCategories)
    .where(inOrg(commentCategories, organisationId, eq(commentCategories.id, id)));
  if (!category) throw new NotFound("Category");
  return category;
}

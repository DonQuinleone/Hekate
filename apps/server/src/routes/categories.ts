import { type Database, inOrg, schema } from "@hekate/db";
import { categoryInput, defaultCategories } from "@hekate/shared";
import { asc, eq, max } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, can } from "../access.ts";
import { NotFound } from "../errors.ts";
import { zValidator } from "../openapi/validator.ts";
import { requireRole, type TenantVariables } from "../tenancy.ts";

const { commentCategories, organisations, projects, workspaceCategories } = schema;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const idParam = zValidator("param", z.object({ id: z.uuid() }));

/** True when a statement failed on the named unique index. */
function violates(error: unknown, index: string): boolean {
  const cause = (error as { cause?: { code?: string; constraint_name?: string } }).cause;
  return cause?.code === "23505" && cause.constraint_name === index;
}

/**
 * Give a workspace its set of categories for new projects (decision 247), once: the defaults,
 * the first time the set is read. The workspace's row is locked, so two first reads make one
 * set; from then on an empty set is the workspace's choice.
 */
async function seedWorkspaceCategories(tx: Tx, organisationId: string) {
  const seeded = async (lock: boolean) => {
    const query = tx
      .select({ seeded: organisations.categoriesSeeded })
      .from(organisations)
      .where(eq(organisations.id, organisationId));
    const [workspace] = await (lock ? query.for("update") : query);
    return !workspace || workspace.seeded;
  };
  // Read first without the lock, so making projects does not queue on the workspace's row
  // once its set exists; locked, read again, as another first read may have made it.
  if ((await seeded(false)) || (await seeded(true))) return;
  await tx
    .insert(workspaceCategories)
    .values(defaultCategories.map((c, position) => ({ organisationId, ...c, position })));
  await tx
    .update(organisations)
    .set({ categoriesSeeded: true })
    .where(eq(organisations.id, organisationId));
}

/** The workspace's set, in its order, seeding the defaults the first time. */
async function workspaceSetOf(tx: Tx, organisationId: string) {
  await seedWorkspaceCategories(tx, organisationId);
  return tx
    .select({
      id: workspaceCategories.id,
      name: workspaceCategories.name,
      handling: workspaceCategories.handling,
      stage: workspaceCategories.stage,
      position: workspaceCategories.position,
    })
    .from(workspaceCategories)
    .where(inOrg(workspaceCategories, organisationId))
    .orderBy(asc(workspaceCategories.position), asc(workspaceCategories.name));
}

/**
 * Give a project its categories, once: a copy of the workspace's set (decision 247) at its
 * creation, or, for a project made before categories existed, the first time they are read.
 * The project row is locked, so two first reads make one set.
 */
export async function seedCategories(tx: Tx, organisationId: string, projectId: string) {
  const [project] = await tx
    .select({ seeded: projects.categoriesSeeded })
    .from(projects)
    .where(inOrg(projects, organisationId, eq(projects.id, projectId)))
    .for("update");
  if (!project || project.seeded) return;
  const set = await workspaceSetOf(tx, organisationId);
  if (set.length > 0)
    await tx.insert(commentCategories).values(
      set.map((c, position) => ({
        organisationId,
        projectId,
        name: c.name,
        handling: c.handling,
        stage: c.stage,
        position,
      })),
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

async function workspaceCategoryOf(db: Database, organisationId: string, id: string) {
  const [category] = await db
    .select({ id: workspaceCategories.id })
    .from(workspaceCategories)
    .where(inOrg(workspaceCategories, organisationId, eq(workspaceCategories.id, id)));
  if (!category) throw new NotFound("Category");
  return category;
}

/**
 * `/api/organisation/categories` (decision 247): the comment categories every new project
 * starts with. Every member reads them; admins add, change and remove them. A project's own
 * are a copy, so no change here reaches a project that exists.
 */
export const workspaceCategoryRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/", async (c) => {
      const organisationId = c.var.organisationId;
      const categories = await db.transaction((tx) => workspaceSetOf(tx, organisationId));
      return c.json({ categories });
    })
    .post("/", requireRole("admin"), zValidator("json", categoryInput), async (c) => {
      const organisationId = c.var.organisationId;
      const input = c.req.valid("json");
      try {
        const [made] = await db.transaction(async (tx) => {
          await seedWorkspaceCategories(tx, organisationId);
          const [last] = await tx
            .select({ position: max(workspaceCategories.position) })
            .from(workspaceCategories)
            .where(inOrg(workspaceCategories, organisationId));
          return tx
            .insert(workspaceCategories)
            .values({ organisationId, ...input, position: (last?.position ?? -1) + 1 })
            .returning();
        });
        return c.json({ category: made }, 201);
      } catch (error) {
        if (violates(error, "workspace_categories_name_idx")) throw taken();
        throw error;
      }
    })
    .patch("/:id", requireRole("admin"), idParam, zValidator("json", categoryInput), async (c) => {
      const organisationId = c.var.organisationId;
      const category = await workspaceCategoryOf(db, organisationId, c.req.valid("param").id);
      try {
        const [updated] = await db
          .update(workspaceCategories)
          .set({ ...c.req.valid("json"), updatedAt: new Date() })
          .where(
            inOrg(workspaceCategories, organisationId, eq(workspaceCategories.id, category.id)),
          )
          .returning();
        return c.json({ category: updated });
      } catch (error) {
        if (violates(error, "workspace_categories_name_idx")) throw taken();
        throw error;
      }
    })
    .delete("/:id", requireRole("admin"), idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const category = await workspaceCategoryOf(db, organisationId, c.req.valid("param").id);
      await db
        .delete(workspaceCategories)
        .where(inOrg(workspaceCategories, organisationId, eq(workspaceCategories.id, category.id)));
      return c.body(null, 204);
    });

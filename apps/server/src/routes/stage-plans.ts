import { type Database, inOrg, schema } from "@hekate/db";
import {
  type PatchedChannel,
  type StageItem,
  type StagePlan,
  stageEditInput,
  stagePlanChangeInput,
  stagePlanInput,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { asc, eq, inArray, max, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, can, lockLiveProject } from "../access.ts";
import { NotFound } from "../errors.ts";
import { textPdfOf } from "../media/pdf.ts";
import { stagePlanPage } from "../stage-pdf.ts";
import type { TenantVariables } from "../tenancy.ts";
import { attachment } from "./comments.ts";

const { patchRows, projects, stageBoxes, stageItems, stagePlans } = schema;

const idParam = zValidator("param", z.object({ id: z.uuid() }));

const nameTaken = () =>
  new HTTPException(409, { message: "Another stage plan in this project has that name" });

function violates(error: unknown, index: string): boolean {
  const cause = (error as { cause?: { code?: string; constraint_name?: string } }).cause;
  return cause?.code === "23505" && cause.constraint_name === index;
}

const planShape = {
  id: stagePlans.id,
  name: stagePlans.name,
  width: stagePlans.width,
  depth: stagePlans.depth,
  grid: stagePlans.grid,
};

const itemShape = {
  id: stageItems.id,
  kind: stageItems.kind,
  label: stageItems.label,
  x: stageItems.x,
  y: stageItems.y,
  w: stageItems.w,
  h: stageItems.h,
  rotation: stageItems.rotation,
  patchRowId: stageItems.patchRowId,
  group: stageItems.group,
};

type Reader = Pick<Database, "select">;

/** A plan's items, oldest first, so what was put down later is drawn on top. */
async function itemsOf(db: Reader, organisationId: string, planIds: string[]) {
  if (planIds.length === 0) return [];
  return db
    .select({ ...itemShape, stagePlanId: stageItems.stagePlanId })
    .from(stageItems)
    .where(inOrg(stageItems, organisationId, inArray(stageItems.stagePlanId, planIds)))
    .orderBy(asc(stageItems.id));
}

const bare = ({ stagePlanId: _plan, ...item }: StageItem & { stagePlanId: string }) => item;

/** A project's stage plans, in order, each with what stands on it. */
export async function stagePlansOf(
  db: Database,
  organisationId: string,
  projectId: string,
): Promise<StagePlan[]> {
  const plans = await db
    .select(planShape)
    .from(stagePlans)
    .where(inOrg(stagePlans, organisationId, eq(stagePlans.projectId, projectId)))
    .orderBy(asc(stagePlans.position), asc(stagePlans.createdAt));
  const items = await itemsOf(
    db,
    organisationId,
    plans.map((p) => p.id),
  );
  return plans.map((p) => ({
    ...p,
    items: items.filter((i) => i.stagePlanId === p.id).map(bare),
  }));
}

/** The project's patch channels, as a plan links and labels them. */
export async function channelsOf(
  db: Reader,
  organisationId: string,
  projectId: string,
  ids?: string[],
): Promise<PatchedChannel[]> {
  if (ids?.length === 0) return [];
  return (
    db
      .select({
        id: patchRows.id,
        box: stageBoxes.name,
        direction: patchRows.direction,
        channel: patchRows.channel,
        source: patchRows.source,
      })
      .from(patchRows)
      .innerJoin(stageBoxes, eq(stageBoxes.id, patchRows.stageBoxId))
      // Both tables in the workspace, and the box in this project.
      .where(
        inOrg(
          patchRows,
          organisationId,
          eq(stageBoxes.organisationId, organisationId),
          eq(stageBoxes.projectId, projectId),
          ids ? inArray(patchRows.id, ids) : undefined,
        ),
      )
      .orderBy(asc(stageBoxes.position), asc(stageBoxes.createdAt), asc(patchRows.channel))
  );
}

/**
 * `/api/projects/:id/stage-plans` (#53): a project's stage plans with the patch channels they
 * may link to, for those who see the production tools, and a new plan, for those who use them.
 */
export const projectStagePlanRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/:id/stage-plans", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const { projectId } = await can(
        db,
        actorOf(c.var),
        "view_production",
        c.req.valid("param").id,
      );
      return c.json({
        plans: await stagePlansOf(db, organisationId, projectId),
        channels: await channelsOf(db, organisationId, projectId),
      });
    })
    .post("/:id/stage-plans", idParam, zValidator("json", stagePlanInput), async (c) => {
      const organisationId = c.var.organisationId;
      const { projectId } = await can(
        db,
        actorOf(c.var),
        "edit_production",
        c.req.valid("param").id,
      );
      try {
        const plan = await db.transaction(async (tx) => {
          await lockLiveProject(tx, organisationId, projectId);
          const [last] = await tx
            .select({ position: max(stagePlans.position) })
            .from(stagePlans)
            .where(inOrg(stagePlans, organisationId, eq(stagePlans.projectId, projectId)));
          const [made] = await tx
            .insert(stagePlans)
            .values({
              organisationId,
              projectId,
              ...c.req.valid("json"),
              position: (last?.position ?? -1) + 1,
            })
            .returning(planShape);
          return made;
        });
        return c.json({ plan: { ...plan, items: [] } }, 201);
      } catch (error) {
        if (violates(error, "stage_plans_name_idx")) throw nameTaken();
        throw error;
      }
    });

/** The plan, and the project it belongs to, for someone who may change it. */
async function planFor(
  db: Database,
  vars: TenantVariables,
  id: string,
  needs: "edit_production" | "view_production" = "edit_production",
) {
  const [plan] = await db
    .select({ id: stagePlans.id, projectId: stagePlans.projectId })
    .from(stagePlans)
    .where(inOrg(stagePlans, vars.organisationId, eq(stagePlans.id, id)));
  if (!plan) throw new NotFound("Stage plan");
  await can(db, actorOf(vars), needs, plan.projectId);
  return plan;
}

const group = z.string().max(40);
/** The label groups left off a print, as the plan has them hidden: `?hide=Main pair&hide=…`. */
const hideQuery = zValidator(
  "query",
  z.object({ hide: z.union([group, z.array(group).max(100)]).optional() }),
);

/** An export is for whoever asked: nothing between them and it keeps a copy. */
const PRIVATE = { "cache-control": "no-store, private", "x-content-type-options": "nosniff" };

/**
 * `/api/stage-plans/:id`: resizing or renaming a plan, removing it, and editing what is on it,
 * a step at a time.
 */
export const stagePlanRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    /** The plan as it is printed (#53): A3 or A4 landscape, to scale, for those who see it. */
    .get("/:id/pdf/:paper{a3|a4}", idParam, hideQuery, async (c) => {
      const organisationId = c.var.organisationId;
      const { projectId, id } = await planFor(
        db,
        c.var,
        c.req.valid("param").id,
        "view_production",
      );
      const [project] = await db
        .select({ name: projects.name })
        .from(projects)
        .where(inOrg(projects, organisationId, eq(projects.id, projectId)));
      const plan = (await stagePlansOf(db, organisationId, projectId)).find((p) => p.id === id);
      if (!plan) throw new NotFound("Stage plan");
      const { hide } = c.req.valid("query");
      const paper = c.req.param("paper") === "a3" ? "a3" : "a4";
      const pdf = textPdfOf([
        stagePlanPage(
          project?.name ?? "Project",
          plan,
          await channelsOf(db, organisationId, projectId),
          paper,
          hide === undefined ? [] : [hide].flat(),
        ),
      ]);
      return c.body(new Uint8Array(pdf), 200, {
        ...PRIVATE,
        "content-type": "application/pdf",
        "content-disposition": attachment(
          `${project?.name ?? "Project"} ${plan.name} stage plan.pdf`,
        ),
      });
    })
    .patch("/:id", idParam, zValidator("json", stagePlanChangeInput), async (c) => {
      const organisationId = c.var.organisationId;
      const plan = await planFor(db, c.var, c.req.valid("param").id);
      try {
        const changed = await db.transaction(async (tx) => {
          await lockLiveProject(tx, organisationId, plan.projectId);
          const [updated] = await tx
            .update(stagePlans)
            .set({ ...c.req.valid("json"), updatedAt: new Date() })
            .where(inOrg(stagePlans, organisationId, eq(stagePlans.id, plan.id)))
            .returning(planShape);
          return updated;
        });
        return c.json({ plan: changed });
      } catch (error) {
        if (violates(error, "stage_plans_name_idx")) throw nameTaken();
        throw error;
      }
    })
    .delete("/:id", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const plan = await planFor(db, c.var, c.req.valid("param").id);
      await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, plan.projectId);
        await tx
          .delete(stagePlans)
          .where(inOrg(stagePlans, organisationId, eq(stagePlans.id, plan.id)));
      });
      return c.body(null, 204);
    })
    /**
     * One step (#53): what it adds, changes and removes, all or nothing, so an undo on the
     * client sends its inverse as one step too. A change or removal of an item no longer there
     * does nothing; an item added twice (a step sent again) is added once.
     */
    .post("/:id/edits", idParam, zValidator("json", stageEditInput), async (c) => {
      const organisationId = c.var.organisationId;
      const plan = await planFor(db, c.var, c.req.valid("param").id);
      const { add, change, remove } = c.req.valid("json");
      const items = await db
        .transaction(async (tx) => {
          await lockLiveProject(tx, organisationId, plan.projectId);
          // One step at a time on a plan, so two people's steps do not interleave.
          await tx
            .select({ id: stagePlans.id })
            .from(stagePlans)
            .where(inOrg(stagePlans, organisationId, eq(stagePlans.id, plan.id)))
            .for("update");
          const linked = [
            ...new Set([...add, ...change].flatMap((i) => (i.patchRowId ? [i.patchRowId] : []))),
          ];
          if (linked.length > 0) {
            const found = await channelsOf(tx, organisationId, plan.projectId, linked);
            if (found.length !== linked.length)
              throw new HTTPException(400, {
                message: "That channel is not in this project's patch list",
              });
          }
          const onPlan = (more: SQL) =>
            inOrg(stageItems, organisationId, eq(stageItems.stagePlanId, plan.id), more);
          if (remove.length > 0)
            await tx.delete(stageItems).where(onPlan(inArray(stageItems.id, remove)));
          const now = new Date();
          for (const { id, ...fields } of change) {
            await tx
              .update(stageItems)
              .set({ ...fields, updatedAt: now })
              .where(onPlan(eq(stageItems.id, id)));
          }
          if (add.length > 0)
            await tx
              .insert(stageItems)
              .values(add.map((i) => ({ ...i, organisationId, stagePlanId: plan.id })))
              .onConflictDoNothing({ target: stageItems.id });
          return (await itemsOf(tx, organisationId, [plan.id])).map(bare);
        })
        .catch((error: unknown) => {
          // A change that leaves something other than a cable without a size, all of it undone.
          const cause = (error as { cause?: { code?: string; constraint_name?: string } }).cause;
          if (cause?.code === "23514" && cause.constraint_name === "stage_items_size")
            throw new HTTPException(400, { message: "Only a cable run goes without a size" });
          throw error;
        });
      return c.json({ items });
    });

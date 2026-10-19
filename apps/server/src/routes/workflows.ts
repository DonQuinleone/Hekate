import { type Database, inOrg, schema } from "@hekate/db";
import {
  projectStatuses,
  type WorkflowDefinition,
  type WorkflowSummary,
  workflowChangeInput,
  workflowInput,
  workflowProblems,
  workflowStatusesInput,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, can, lockLiveProject } from "../access.ts";
import { NotFound } from "../errors.ts";
import type { TenantVariables } from "../tenancy.ts";

const { projects, tracks, workflows } = schema;

const idParam = zValidator("param", z.object({ id: z.uuid() }));

const summaryOf = (row: typeof workflows.$inferSelect): WorkflowSummary => ({
  id: row.id,
  projectId: row.projectId,
  trackId: row.trackId,
  name: row.name,
  active: row.active,
  version: row.version,
  definition: row.definition,
  problems: workflowProblems(row.definition),
  updatedAt: row.updatedAt.toISOString(),
});

/** A workflow that would run must break no rule; the first it breaks is the refusal. */
function mustRun(definition: WorkflowDefinition) {
  const error = workflowProblems(definition).find((p) => p.level === "error");
  if (error) throw new HTTPException(422, { message: `This workflow cannot run: ${error.text}` });
}

/** A workflow of this workspace; not found otherwise. */
async function workflowOf(db: Database, organisationId: string, id: string) {
  const [row] = await db
    .select()
    .from(workflows)
    .where(inOrg(workflows, organisationId, eq(workflows.id, id)));
  if (!row) throw new NotFound("Workflow");
  return row;
}

/** A project's statuses (#26): its set, then any its workflows' steps set that it lacks. */
async function statusesOf(db: Pick<Database, "select">, organisationId: string, projectId: string) {
  const [[project], flows] = await Promise.all([
    db
      .select({ set: projects.workflowStatuses })
      .from(projects)
      .where(inOrg(projects, organisationId, eq(projects.id, projectId))),
    db
      .select({ definition: workflows.definition })
      .from(workflows)
      .where(inOrg(workflows, organisationId, eq(workflows.projectId, projectId)))
      .orderBy(sql`${workflows.trackId} is not null`, asc(workflows.createdAt)),
  ]);
  if (!project) throw new NotFound("Project");
  return projectStatuses(
    project.set,
    flows.map((f) => f.definition),
  );
}

/**
 * A project's workflows (#25), under `/api/projects/:id/workflows`: its own and the tracks'
 * overrides, and making one. Seeing them needs `view_workflows`; changing them,
 * `edit_workflows`.
 */
export const projectWorkflowRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/:id/workflows", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const projectId = c.req.valid("param").id;
      await can(db, actorOf(c.var), "view_workflows", projectId);
      const rows = await db
        .select()
        .from(workflows)
        .where(inOrg(workflows, organisationId, eq(workflows.projectId, projectId)))
        // The project's own first, then the tracks' overrides; each in the order made.
        .orderBy(sql`${workflows.trackId} is not null`, asc(workflows.createdAt));
      return c.json({ workflows: rows.map(summaryOf) });
    })
    // Its status set (#26): what the board's columns are, and what a step may set.
    .get("/:id/workflow-statuses", idParam, async (c) => {
      const projectId = c.req.valid("param").id;
      await can(db, actorOf(c.var), "view_workflows", projectId);
      return c.json({ statuses: await statusesOf(db, c.var.organisationId, projectId) });
    })
    .put(
      "/:id/workflow-statuses",
      idParam,
      zValidator("json", workflowStatusesInput),
      async (c) => {
        const organisationId = c.var.organisationId;
        const projectId = c.req.valid("param").id;
        await can(db, actorOf(c.var), "edit_workflows", projectId);
        const statuses = await db.transaction(async (tx) => {
          await lockLiveProject(tx, organisationId, projectId);
          await tx
            .update(projects)
            .set({ workflowStatuses: c.req.valid("json").statuses })
            .where(inOrg(projects, organisationId, eq(projects.id, projectId)));
          return statusesOf(tx, organisationId, projectId);
        });
        return c.json({ statuses });
      },
    )
    .post("/:id/workflows", idParam, zValidator("json", workflowInput), async (c) => {
      const organisationId = c.var.organisationId;
      const projectId = c.req.valid("param").id;
      await can(db, actorOf(c.var), "edit_workflows", projectId);
      const input = c.req.valid("json");
      const made = await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, projectId);
        if (input.trackId) {
          const [track] = await tx
            .select({ id: tracks.id })
            .from(tracks)
            .where(
              inOrg(
                tracks,
                organisationId,
                eq(tracks.id, input.trackId),
                eq(tracks.projectId, projectId),
              ),
            );
          if (!track) throw new NotFound("Track");
        }
        const [row] = await tx
          .insert(workflows)
          .values({
            organisationId,
            projectId,
            trackId: input.trackId ?? null,
            name: input.name,
            definition: input.definition,
            createdBy: c.var.userId,
          })
          .returning();
        if (!row) throw new NotFound("Workflow");
        return row;
      });
      return c.json({ workflow: summaryOf(made) }, 201);
    });

/** `/api/workflows/:id`: one workflow, changing it (and switching it on or off), or removing it. */
export const workflowRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/:id", idParam, async (c) => {
      const row = await workflowOf(db, c.var.organisationId, c.req.valid("param").id);
      await can(db, actorOf(c.var), "view_workflows", row.projectId);
      return c.json({ workflow: summaryOf(row) });
    })
    .patch("/:id", idParam, zValidator("json", workflowChangeInput), async (c) => {
      const organisationId = c.var.organisationId;
      const row = await workflowOf(db, organisationId, c.req.valid("param").id);
      await can(db, actorOf(c.var), "edit_workflows", row.projectId);
      const { version, ...change } = c.req.valid("json");
      const changed = await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, row.projectId);
        const [current] = await tx
          .select()
          .from(workflows)
          .where(inOrg(workflows, organisationId, eq(workflows.id, row.id)))
          .for("update");
        if (!current) throw new NotFound("Workflow");
        if (version !== undefined && version !== current.version)
          throw new HTTPException(409, {
            message: "Someone changed this workflow since you opened it: reload it to see theirs",
          });
        const definition = change.definition ?? current.definition;
        if (change.active ?? current.active) mustRun(definition);
        const [updated] = await tx
          .update(workflows)
          .set({
            ...change,
            version: current.version + 1,
            updatedAt: new Date(),
          })
          .where(inOrg(workflows, organisationId, eq(workflows.id, row.id)))
          .returning();
        if (!updated) throw new NotFound("Workflow");
        return updated;
      });
      return c.json({ workflow: summaryOf(changed) });
    })
    .delete("/:id", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const row = await workflowOf(db, organisationId, c.req.valid("param").id);
      await can(db, actorOf(c.var), "edit_workflows", row.projectId);
      await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, row.projectId);
        await tx
          .delete(workflows)
          .where(inOrg(workflows, organisationId, eq(workflows.id, row.id)));
      });
      return c.body(null, 204);
    });

import { type Database, inOrg, schema } from "@hekate/db";
import {
  nextStep,
  projectStatuses,
  sameStatus,
  type WorkflowRunSummary,
  type WorkflowStanding,
  workflowRunStartInput,
  workflowStepInput,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, can } from "../access.ts";
import { NotFound } from "../errors.ts";
import type { TenantVariables } from "../tenancy.ts";
import { completeStep, type RunnerDeps, runsOf, startByHand } from "../workflow-runner.ts";

const { projects, tracks, workflowRuns, workflows } = schema;

const idParam = zValidator("param", z.object({ id: z.uuid() }));

type Logged = Awaited<ReturnType<typeof runsOf>>[number];

const summaryOf = ({ run, steps }: Logged): WorkflowRunSummary => ({
  id: run.id,
  workflowId: run.workflowId,
  workflowName: run.workflowName,
  workflowVersion: run.workflowVersion,
  trackId: run.trackId,
  state: run.state,
  status: run.engine.status,
  waiting: run.engine.active.flatMap((id) => {
    const node = run.definition.nodes.find((n) => n.id === id);
    return node ? [{ nodeId: id, name: node.name, type: node.type }] : [];
  }),
  steps: steps.map((s) => ({
    nodeId: s.nodeId,
    outcome: s.outcome,
    effects: s.effects,
    byUserId: s.byUserId,
    at: s.createdAt.toISOString(),
  })),
  startedAt: run.createdAt.toISOString(),
  endedAt: run.endedAt?.toISOString() ?? null,
});

async function trackOf(db: Database, organisationId: string, id: string) {
  const [track] = await db
    .select({ id: tracks.id, projectId: tracks.projectId })
    .from(tracks)
    .where(inOrg(tracks, organisationId, eq(tracks.id, id)));
  if (!track) throw new NotFound("Track");
  return track;
}

/**
 * A track's workflow runs (#25), under `/api/tracks/:id/workflow-runs`: seeing them, with each
 * one's log (`view_workflows`), and starting one by hand (`edit_workflows`).
 */
export const trackWorkflowRunRoutes = (runner: RunnerDeps) => {
  const { db } = runner;
  return (
    new Hono<{ Variables: TenantVariables }>()
      // Where it stands (#26), for whoever sees the track, as its page says it: the status its
      // workflow gave it, the step its run waits at, and the step after.
      .get("/:id/workflow-standing", idParam, async (c) => {
        const organisationId = c.var.organisationId;
        const track = await trackOf(db, organisationId, c.req.valid("param").id);
        await can(db, actorOf(c.var), "view", track.projectId);
        const [[row], [run], [project], flows] = await Promise.all([
          db
            .select({ status: tracks.workflowStatus })
            .from(tracks)
            .where(inOrg(tracks, organisationId, eq(tracks.id, track.id))),
          db
            .select({ engine: workflowRuns.engine, definition: workflowRuns.definition })
            .from(workflowRuns)
            .where(
              inOrg(
                workflowRuns,
                organisationId,
                and(eq(workflowRuns.trackId, track.id), eq(workflowRuns.state, "running")),
              ),
            )
            .orderBy(desc(workflowRuns.createdAt))
            .limit(1),
          db
            .select({ set: projects.workflowStatuses })
            .from(projects)
            .where(inOrg(projects, organisationId, eq(projects.id, track.projectId))),
          db
            .select({ definition: workflows.definition })
            .from(workflows)
            .where(
              inOrg(
                workflows,
                organisationId,
                eq(workflows.projectId, track.projectId),
                eq(workflows.active, true),
              ),
            ),
        ]);
        const status = row?.status ?? null;
        // How the project's status set reads it; one no workflow sets now, as under way.
        const category = status
          ? (projectStatuses(
              project?.set ?? [],
              flows.map((f) => f.definition),
            ).find((x) => sameStatus(x.name, status))?.category ?? "in_progress")
          : null;
        const at = run?.engine.active[0];
        const stage = at ? run?.definition.nodes.find((n) => n.id === at) : undefined;
        const next = run && at ? nextStep(run.definition, at) : null;
        const standing: WorkflowStanding = {
          status,
          category,
          stage: stage?.name ?? null,
          next: next?.name ?? null,
        };
        return c.json(standing);
      })
      .get("/:id/workflow-runs", idParam, async (c) => {
        const organisationId = c.var.organisationId;
        const track = await trackOf(db, organisationId, c.req.valid("param").id);
        await can(db, actorOf(c.var), "view_workflows", track.projectId);
        const runs = await runsOf(db, organisationId, track.id);
        return c.json({ runs: runs.map(summaryOf) });
      })
      .post("/:id/workflow-runs", idParam, zValidator("json", workflowRunStartInput), async (c) => {
        const organisationId = c.var.organisationId;
        const track = await trackOf(db, organisationId, c.req.valid("param").id);
        await can(db, actorOf(c.var), "edit_workflows", track.projectId);
        const [workflow] = await db
          .select()
          .from(workflows)
          .where(
            inOrg(
              workflows,
              organisationId,
              eq(workflows.id, c.req.valid("json").workflowId),
              eq(workflows.projectId, track.projectId),
            ),
          );
        // A workflow of another track, or one switched off, does not run here.
        if (!workflow || (workflow.trackId && workflow.trackId !== track.id))
          throw new NotFound("Workflow");
        if (!workflow.active)
          throw new HTTPException(409, { message: "This workflow is switched off" });
        const run = await startByHand(
          runner,
          { organisationId, projectId: track.projectId, trackId: track.id, userId: c.var.userId },
          workflow,
        );
        const [logged] = (await runsOf(db, organisationId, track.id)).filter(
          (r) => r.run.id === run.id,
        );
        return c.json({ run: logged ? summaryOf(logged) : null }, 201);
      })
  );
};

/** `/api/workflow-runs/:id/steps`: a step the run waits on, ended by hand (`edit_workflows`). */
export const workflowRunRoutes = (runner: RunnerDeps) => {
  const { db } = runner;
  return new Hono<{ Variables: TenantVariables }>().post(
    "/:id/steps",
    idParam,
    zValidator("json", workflowStepInput),
    async (c) => {
      const organisationId = c.var.organisationId;
      const [run] = await db
        .select({ projectId: workflowRuns.projectId, trackId: workflowRuns.trackId })
        .from(workflowRuns)
        .where(inOrg(workflowRuns, organisationId, eq(workflowRuns.id, c.req.valid("param").id)));
      if (!run) throw new NotFound("Run");
      await can(db, actorOf(c.var), "edit_workflows", run.projectId);
      const { nodeId, outcome } = c.req.valid("json");
      const moved = await completeStep(runner, {
        organisationId,
        runId: c.req.valid("param").id,
        nodeId,
        outcome,
        userId: c.var.userId,
      });
      const [logged] = (await runsOf(db, organisationId, run.trackId)).filter(
        (r) => r.run.id === moved?.id,
      );
      return c.json({ run: logged ? summaryOf(logged) : null });
    },
  );
};

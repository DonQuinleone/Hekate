import { type Database, inOrg, schema } from "@hekate/db";
import {
  checksOutcome,
  completeNode,
  type MeasuredFile,
  measuredState,
  stageClock,
  startRun,
  triggersOf,
  type WorkflowContext,
  type WorkflowDefinition,
  type WorkflowEffect,
  type WorkflowRun,
} from "@hekate/shared";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { lockLiveProject } from "./access.ts";
import { NotFound } from "./errors.ts";
import type { Jobs } from "./jobs.ts";
import { projectPeople, recordNotification } from "./notifications.ts";
import { qaReportOf } from "./routes/qa.ts";
import type { ReviewDeps } from "./routes/reviews.ts";
import { askForStageReview, cancelStageReview, stageOutcome } from "./workflow-reviews.ts";

const {
  organisations,
  fileTags,
  files,
  folders,
  projectMembers,
  projectRoles,
  tags,
  tracks,
  variations,
  versions,
  workflowRuns,
  workflowSteps,
  workflows,
} = schema;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type RunRow = typeof workflowRuns.$inferSelect;

/**
 * Workflows at work (#25, decision 117): runs started by what happens to a track, moved on by
 * the pure engine in `packages/shared`, and what it says to do carried out, every move logged.
 */
export interface RunnerDeps {
  db: Database;
  jobs: Pick<Jobs, "send">;
  /** Where present, approval and feedback stages ask for their reviews (decision 118). */
  reviews?: ReviewDeps;
}

/**
 * The workflows that run for a track: its own, where it has any switched on, else the project's
 * (decision 040: a track's workflows replace the project's). Only those switched on.
 */
export async function workflowsFor(
  db: Database,
  organisationId: string,
  projectId: string,
  trackId: string | null,
) {
  // One read, so the track's and the project's are seen as they stood at one moment.
  const rows = await db
    .select()
    .from(workflows)
    .where(
      inOrg(
        workflows,
        organisationId,
        eq(workflows.projectId, projectId),
        eq(workflows.active, true),
        trackId === null
          ? isNull(workflows.trackId)
          : or(isNull(workflows.trackId), eq(workflows.trackId, trackId)),
      ),
    )
    .orderBy(asc(workflows.createdAt));
  const own = rows.filter((w) => trackId !== null && w.trackId === trackId);
  return own.length > 0 ? own : rows.filter((w) => w.trackId === null);
}

/** What a condition is tested against: the latest version's primary file, and its tags. */
async function contextOf(
  tx: Tx,
  organisationId: string,
  trackId: string,
  by?: WorkflowContext["by"],
): Promise<WorkflowContext> {
  const [latest] = await tx
    .select({ kind: files.kind, fileId: files.id })
    .from(versions)
    .innerJoin(
      variations,
      and(
        eq(variations.versionId, versions.id),
        eq(variations.isPrimary, true),
        eq(variations.organisationId, organisationId),
      ),
    )
    .innerJoin(
      files,
      and(eq(files.id, variations.fileId), eq(files.organisationId, organisationId)),
    )
    .where(inOrg(versions, organisationId, eq(versions.trackId, trackId)))
    .orderBy(desc(versions.number))
    .limit(1);
  if (!latest) return { item: { kind: "other", tags: [] }, ...(by ? { by } : {}) };
  const named = await tx
    .select({ name: tags.name })
    .from(fileTags)
    .innerJoin(tags, and(eq(tags.id, fileTags.tagId), eq(tags.organisationId, organisationId)))
    .where(inOrg(fileTags, organisationId, eq(fileTags.fileId, latest.fileId)));
  const kind = (["audio", "video", "document", "image"] as const).find((k) => k === latest.kind);
  return { item: { kind: kind ?? "other", tags: named.map((t) => t.name) }, ...(by ? { by } : {}) };
}

/**
 * The members a node's `to` or `who` names: everyone in the project, or those holding a role of
 * that name ("Producer"; several separated by commas).
 */
async function peopleNamed(
  tx: Tx,
  organisationId: string,
  projectId: string,
  named: string | undefined,
): Promise<string[]> {
  const wanted = (named ?? "")
    .split(",")
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  if (wanted.length === 0) return [];
  if (wanted.some((n) => n === "everyone in the project" || n === "everyone"))
    return (await projectPeople(tx, organisationId, projectId)).map((p) => p.id);
  const rows = await tx
    .select({ userId: projectMembers.userId, role: projectRoles.name })
    .from(projectMembers)
    .innerJoin(
      projectRoles,
      and(
        eq(projectRoles.id, projectMembers.roleId),
        eq(projectRoles.organisationId, organisationId),
      ),
    )
    .where(inOrg(projectMembers, organisationId, eq(projectMembers.projectId, projectId)));
  return [
    ...new Set(rows.filter((r) => wanted.includes(r.role.toLowerCase())).map((r) => r.userId)),
  ];
}

/** A job to send once the step that asks for it has committed. */
type After = () => Promise<unknown>;

/**
 * Records a run's move and carries out what it says, in the transaction that made it: the run's
 * new state, the step in its log, the track's status, the notices and assignments. Waits are
 * queued after commit.
 */
async function apply(
  tx: Tx,
  deps: RunnerDeps,
  row: Pick<
    RunRow,
    | "id"
    | "organisationId"
    | "projectId"
    | "trackId"
    | "definition"
    | "versionId"
    | "startedBy"
    | "workflowId"
  >,
  moved: { run: WorkflowRun; effects: WorkflowEffect[] },
  from: { nodeId: string | null; outcome: string | null; byUserId: string | null },
): Promise<After[]> {
  const { organisationId, projectId, trackId } = row;
  const ended = moved.run.state !== "running";
  await tx
    .update(workflowRuns)
    .set({
      engine: moved.run,
      state: moved.run.state,
      endedAt: ended ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(inOrg(workflowRuns, organisationId, eq(workflowRuns.id, row.id)));
  const [step] = await tx
    .insert(workflowSteps)
    .values({
      organisationId,
      runId: row.id,
      nodeId: from.nodeId,
      outcome: from.outcome,
      effects: moved.effects,
      byUserId: from.byUserId,
    })
    .returning({ id: workflowSteps.id });
  const [track] = await tx
    .select({ name: tracks.name })
    .from(tracks)
    .where(inOrg(tracks, organisationId, eq(tracks.id, trackId)));
  const node = (id: string) => row.definition.nodes.find((n) => n.id === id);
  const after: After[] = [];
  const tell = async (recipients: string[], text: string, detail?: string) => {
    if (recipients.length === 0) return;
    await recordNotification(tx, {
      organisationId,
      kind: "workflow",
      recipients,
      actor: null,
      projectId,
      trackId,
      text,
      detail: detail || null,
      link: `/tracks/${trackId}`,
    });
  };
  for (const effect of moved.effects) {
    if (effect.kind === "status" || (effect.kind === "finish" && effect.status)) {
      const status = effect.kind === "status" ? effect.status : effect.status;
      await tx
        .update(tracks)
        .set({ workflowStatus: status, updatedAt: new Date() })
        .where(inOrg(tracks, organisationId, eq(tracks.id, trackId)));
    } else if (effect.kind === "do" && effect.type === "notify") {
      const to = await peopleNamed(tx, organisationId, projectId, effect.config.to);
      await tell(
        to,
        `${node(effect.nodeId)?.name ?? "A workflow"}: ${track?.name ?? "a track"}`,
        effect.config.message,
      );
    } else if (effect.kind === "start" && effect.type === "checks") {
      // Ended by the quality reports of the version (decision 119), at once where they are in,
      // else when the last file has been measured.
      after.push(() => checksDue(deps, organisationId, row.id));
    } else if (effect.kind === "start" && effect.type === "task") {
      // Until tasks (#140) are wired in, whoever it names marks it done.
      const who = await peopleNamed(tx, organisationId, projectId, effect.config.who);
      await tell(
        who,
        `${node(effect.nodeId)?.name ?? "A stage"} on ${track?.name ?? "a track"} is yours`,
      );
    } else if (effect.kind === "do" && effect.type === "move") {
      try {
        await moveTrack(tx, { organisationId, projectId, trackId }, effect.config.folder);
      } catch (failure) {
        // A folder that is not there is told, and the run carries on; anything else (the
        // database failing) fails the step, as the transaction can no longer go on.
        if (!(failure instanceof MoveRefused)) throw failure;
        await tell(
          row.startedBy ? [row.startedBy] : [],
          `${node(effect.nodeId)?.name ?? "A stage"} could not move ${track?.name ?? "the track"}`,
          failure.message,
        );
      }
    } else if (
      (effect.kind === "start" && (effect.type === "approval" || effect.type === "feedback")) ||
      (effect.kind === "do" && effect.type === "share")
    ) {
      const reviews = deps.reviews;
      const kind = effect.type;
      if (reviews)
        after.push(() =>
          askForStageReview(
            { db: deps.db, reviews },
            {
              organisationId,
              projectId,
              trackId,
              runId: row.id,
              nodeId: effect.nodeId,
              nodeName: node(effect.nodeId)?.name ?? "A stage",
              kind,
              config: effect.config,
              versionId: row.versionId,
              startedBy: row.startedBy,
              workflowId: row.workflowId,
            },
          ),
        );
    } else if (effect.kind === "cancel") {
      // A review a stage asked for, the run has moved past: nobody need answer it now.
      await cancelStageReview(tx, organisationId, row.id, effect.nodeId);
    }
    // A wait, and a feedback or task stage given days until it is due, start a clock: a job
    // queued for when it runs out (decision 120).
    const clock = effect.kind === "start" ? stageClock(effect) : null;
    if (effect.kind === "start" && clock) {
      const job = { organisationId, runId: row.id, nodeId: effect.nodeId, stepId: step?.id ?? "" };
      after.push(() =>
        deps.jobs.send("workflow-wait", job, {
          singletonKey: `${row.id}:${effect.nodeId}:${job.stepId}`,
          startAfterSeconds: clock.seconds,
        }),
      );
    }
  }
  return after;
}

/** Why a move stage could not move its track: told to whoever started the run. */
class MoveRefused extends Error {}

/**
 * A move stage (decision 121): the track filed in the folder its `folder` names, by its path from
 * the top of the project ("Masters", or "Masters/2026"); an empty one is the top itself. The
 * folder is held while the track moves, so it cannot be deleted under it.
 */
async function moveTrack(
  tx: Tx,
  at: { organisationId: string; projectId: string; trackId: string },
  path: string | undefined,
) {
  const names = (path ?? "")
    .split("/")
    .map((n) => n.trim())
    .filter(Boolean);
  let folderId: string | null = null;
  for (const name of names) {
    const [folder]: { id: string }[] = await tx
      .select({ id: folders.id })
      .from(folders)
      .where(
        inOrg(
          folders,
          at.organisationId,
          eq(folders.projectId, at.projectId),
          folderId === null ? isNull(folders.parentId) : eq(folders.parentId, folderId),
          sql`lower(${folders.name}) = ${name.toLowerCase()}`,
        ),
      )
      .limit(1)
      .for("share");
    if (!folder) throw new MoveRefused(`The project has no folder ${names.join("/")}.`);
    folderId = folder.id;
  }
  await tx
    .update(tracks)
    .set({ folderId, updatedAt: new Date() })
    .where(inOrg(tracks, at.organisationId, eq(tracks.id, at.trackId)));
}

async function runAfter(after: After[]) {
  for (const send of after)
    await send().catch((failure: unknown) =>
      console.warn(`Could not queue a workflow's job: ${String(failure)}`),
    );
}

/** The run of a workflow under way for a track, locked; none when there is none. */
async function runningOf(tx: Tx, organisationId: string, workflowId: string, trackId: string) {
  const [row] = await tx
    .select()
    .from(workflowRuns)
    .where(
      inOrg(
        workflowRuns,
        organisationId,
        eq(workflowRuns.workflowId, workflowId),
        eq(workflowRuns.trackId, trackId),
        eq(workflowRuns.state, "running"),
      ),
    )
    .for("update");
  return row;
}

/** Starts a run of a workflow from one of its triggers, in the transaction given. */
async function begin(
  tx: Tx,
  deps: RunnerDeps,
  workflow: { id: string; name: string; version: number; definition: WorkflowDefinition },
  at: {
    organisationId: string;
    projectId: string;
    trackId: string;
    versionId: string | null;
    triggerId: string;
    userId: string | null;
  },
) {
  const ctx = await contextOf(tx, at.organisationId, at.trackId, at.userId ? "member" : undefined);
  const moved = startRun(workflow.definition, at.triggerId, ctx);
  const [row] = await tx
    .insert(workflowRuns)
    .values({
      organisationId: at.organisationId,
      projectId: at.projectId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      workflowVersion: workflow.version,
      definition: workflow.definition,
      trackId: at.trackId,
      versionId: at.versionId,
      state: moved.run.state,
      engine: moved.run,
      startedBy: at.userId,
    })
    .returning();
  if (!row) throw new NotFound("Run");
  return {
    row,
    after: await apply(tx, deps, row, moved, {
      nodeId: null,
      outcome: null,
      byUserId: at.userId,
    }),
  };
}

/**
 * A new version arrived on a track: each workflow that runs for it starts from its upload
 * trigger, or, where a run is under way, carries on from an upload it waits for. A run under
 * way that waits for none goes on as it was.
 */
export async function versionArrived(
  deps: RunnerDeps,
  at: {
    organisationId: string;
    projectId: string;
    trackId: string;
    versionId: string;
    userId: string;
  },
) {
  // Runs under way carry on from an upload they wait for, whatever has since become of the
  // workflow they started from: a run keeps its definition.
  const running = await deps.db
    .select({ id: workflowRuns.id, workflowId: workflowRuns.workflowId })
    .from(workflowRuns)
    .where(
      inOrg(
        workflowRuns,
        at.organisationId,
        eq(workflowRuns.trackId, at.trackId),
        eq(workflowRuns.state, "running"),
      ),
    );
  for (const { id } of running) {
    try {
      const after = await deps.db.transaction(async (tx) => {
        const [run] = await tx
          .select()
          .from(workflowRuns)
          .where(inOrg(workflowRuns, at.organisationId, eq(workflowRuns.id, id)))
          .for("update");
        if (run?.state !== "running") return [];
        const listening = run.engine.active.find(
          (node) => run.definition.nodes.find((n) => n.id === node)?.type === "upload",
        );
        if (!listening) return [];
        const ctx = await contextOf(tx, at.organisationId, at.trackId, "member");
        const moved = completeNode(run.definition, run.engine, listening, "happened", ctx);
        return apply(tx, deps, run, moved, {
          nodeId: listening,
          outcome: "happened",
          byUserId: at.userId,
        });
      });
      await runAfter(after);
    } catch (failure) {
      // One run failing to move on never keeps the version, or the other runs, back.
      console.warn(`Run ${id} could not move on: ${String(failure)}`);
    }
  }
  // The workflows that run for the track and have no run under way there start afresh.
  const busy = new Set(running.map((r) => r.workflowId));
  const flows = await workflowsFor(deps.db, at.organisationId, at.projectId, at.trackId);
  for (const flow of flows.filter((f) => !busy.has(f.id))) {
    try {
      const after = await deps.db.transaction(async (tx) => {
        if (await runningOf(tx, at.organisationId, flow.id, at.trackId)) return [];
        const trigger = triggersOf(flow.definition).find((t) => t.type === "upload");
        if (!trigger) return [];
        return (await begin(tx, deps, flow, { ...at, triggerId: trigger.id })).after;
      });
      await runAfter(after);
    } catch (failure) {
      console.warn(`Workflow ${flow.id} could not start: ${String(failure)}`);
    }
  }
}

/**
 * Starts a workflow by hand on a track, from a trigger that is started so ("manual"); refused
 * while a run of it is under way there.
 */
export async function startByHand(
  deps: RunnerDeps,
  at: { organisationId: string; projectId: string; trackId: string; userId: string },
  workflow: { id: string; name: string; version: number; definition: WorkflowDefinition },
): Promise<RunRow> {
  const trigger = triggersOf(workflow.definition).find((t) => t.type === "manual");
  if (!trigger) throw new HTTPException(422, { message: "This workflow is not started by hand" });
  const { row, after } = await deps.db.transaction(async (tx) => {
    // An archived project is read-only, even if it was archived a moment ago.
    await lockLiveProject(tx, at.organisationId, at.projectId);
    if (await runningOf(tx, at.organisationId, workflow.id, at.trackId))
      throw new HTTPException(409, { message: "This workflow is already under way on the track" });
    return begin(tx, deps, workflow, { ...at, versionId: null, triggerId: trigger.id });
  });
  await runAfter(after);
  return row;
}

/**
 * A node a run waits on ended, by hand (a task done, a stage decided before reviews are wired
 * in) or by a job (a wait elapsed). Refused when the run does not wait on it.
 */
export async function completeStep(
  deps: RunnerDeps,
  at: {
    organisationId: string;
    runId: string;
    nodeId: string;
    outcome: string;
    userId: string | null;
    /** Who decided, where it is not the person moving the run on (a guest's review). */
    by?: WorkflowContext["by"];
  },
  /** Asked with the run locked: false leaves it as it is. */
  check?: (run: RunRow, tx: Tx) => boolean | Promise<boolean>,
): Promise<RunRow | null> {
  const result = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(workflowRuns)
      .where(inOrg(workflowRuns, at.organisationId, eq(workflowRuns.id, at.runId)))
      .for("update");
    if (!row) throw new NotFound("Run");
    if (check && !(await check(row, tx))) return null;
    // A person moving a run on needs the project live; a wait elapsing does not ask.
    if (at.userId) await lockLiveProject(tx, at.organisationId, row.projectId);
    if (row.state !== "running" || !row.engine.active.includes(at.nodeId))
      throw new HTTPException(409, { message: "The run is not waiting on that step" });
    const ctx = await contextOf(
      tx,
      at.organisationId,
      row.trackId,
      at.by ?? (at.userId ? "member" : undefined),
    );
    let moved: ReturnType<typeof completeNode>;
    try {
      moved = completeNode(row.definition, row.engine, at.nodeId, at.outcome, ctx);
    } catch (failure) {
      throw new HTTPException(422, {
        message: failure instanceof Error ? failure.message : "That step cannot end so",
      });
    }
    const after = await apply(tx, deps, row, moved, {
      nodeId: at.nodeId,
      outcome: at.outcome,
      byUserId: at.userId,
    });
    const [updated] = await tx
      .select()
      .from(workflowRuns)
      .where(inOrg(workflowRuns, at.organisationId, eq(workflowRuns.id, at.runId)));
    return { updated: updated ?? row, after };
  });
  if (!result) return null;
  await runAfter(result.after);
  return result.updated;
}

/**
 * A node's clock ran out (decision 120): a wait ends elapsed, a feedback or task stage still
 * waited on ends overdue, unless the run has since moved past the step that began it.
 */
export async function clockElapsed(
  deps: RunnerDeps,
  job: { organisationId: string; runId: string; nodeId: string; stepId: string },
) {
  const [run] = await deps.db
    .select({ definition: workflowRuns.definition })
    .from(workflowRuns)
    .where(inOrg(workflowRuns, job.organisationId, eq(workflowRuns.id, job.runId)));
  const node = run?.definition.nodes.find((n) => n.id === job.nodeId);
  const clock = node ? stageClock(node) : null;
  if (!clock) return;
  await completeStep(
    deps,
    { ...job, outcome: clock.outcome, userId: null },
    // With the run locked, so a step that brings the run back to the node commits either
    // before this looks (and the clock is stale) or after it has ended the node.
    async (locked, tx) => {
      if (locked.state !== "running" || !locked.engine.active.includes(job.nodeId)) return false;
      const [latest] = await tx
        .select({ id: workflowSteps.id })
        .from(workflowSteps)
        .where(
          inOrg(
            workflowSteps,
            job.organisationId,
            eq(workflowSteps.runId, job.runId),
            sql`${workflowSteps.effects} @> ${JSON.stringify([{ kind: "start", nodeId: job.nodeId }])}::jsonb`,
          ),
        )
        .orderBy(desc(workflowSteps.createdAt), desc(workflowSteps.id))
        .limit(1);
      return latest?.id === job.stepId;
    },
  );
}

/** A track's runs, newest first, with each one's log. */
export async function runsOf(db: Database, organisationId: string, trackId: string) {
  const runs = await db
    .select()
    .from(workflowRuns)
    .where(inOrg(workflowRuns, organisationId, eq(workflowRuns.trackId, trackId)))
    .orderBy(desc(workflowRuns.createdAt));
  const steps =
    runs.length === 0
      ? []
      : await db
          .select()
          .from(workflowSteps)
          .where(
            inOrg(
              workflowSteps,
              organisationId,
              inArray(
                workflowSteps.runId,
                runs.map((r) => r.id),
              ),
            ),
          )
          .orderBy(workflowSteps.createdAt, workflowSteps.id);
  return runs.map((r) => ({ run: r, steps: steps.filter((s) => s.runId === r.id) }));
}

/**
 * The files of the version a run is about (else the track's latest), each as a checks stage
 * sees it.
 */
async function checkedFiles(db: Database, organisationId: string, run: RunRow) {
  const [version] = run.versionId
    ? [{ id: run.versionId }]
    : await db
        .select({ id: versions.id })
        .from(versions)
        .where(inOrg(versions, organisationId, eq(versions.trackId, run.trackId)))
        .orderBy(desc(versions.number))
        .limit(1);
  if (!version) return [];
  const rows = await db
    .select({
      id: files.id,
      kind: files.kind,
      mediaInfo: files.mediaInfo,
      streamStatus: files.streamStatus,
      analysisStatus: files.analysisStatus,
    })
    .from(variations)
    .innerJoin(
      files,
      and(eq(files.id, variations.fileId), eq(files.organisationId, organisationId)),
    )
    .where(inOrg(variations, organisationId, eq(variations.versionId, version.id)));
  const seen: MeasuredFile[] = [];
  for (const file of rows) {
    const state = measuredState(file);
    if (state !== "measured") {
      seen.push({ state });
      continue;
    }
    const report = await qaReportOf(db, organisationId, file.id);
    seen.push(
      report
        ? { state: "checked", severities: report.findings.map((f) => f.severity) }
        : { state: "unchecked" },
    );
  }
  return seen;
}

/**
 * The checks stages a run waits on (decision 119), ended by the quality reports of its version
 * once every file has been measured: passed, warnings or failed. Returns how many ended.
 */
export async function checksDue(deps: RunnerDeps, organisationId: string, runId: string) {
  const [run] = await deps.db
    .select()
    .from(workflowRuns)
    .where(inOrg(workflowRuns, organisationId, eq(workflowRuns.id, runId)));
  if (run?.state !== "running") return 0;
  const waiting = run.engine.active.filter(
    (id) => run.definition.nodes.find((n) => n.id === id)?.type === "checks",
  );
  if (waiting.length === 0) return 0;
  const outcome = checksOutcome(await checkedFiles(deps.db, organisationId, run));
  if (!outcome) return 0;
  let ended = 0;
  for (const nodeId of waiting) {
    const moved = await completeStep(
      deps,
      { organisationId, runId, nodeId, outcome, userId: null },
      (now) => now.state === "running" && now.engine.active.includes(nodeId),
    );
    if (moved) ended += 1;
  }
  return ended;
}

/**
 * A file has been measured, or found not to be measurable: the checks stages waiting on a
 * version it belongs to look again.
 */
export async function fileMeasured(
  deps: RunnerDeps,
  job: { organisationId: string; fileId: string },
) {
  const { organisationId } = job;
  const runs = await deps.db
    .selectDistinct({ id: workflowRuns.id })
    .from(variations)
    .innerJoin(
      versions,
      and(eq(versions.id, variations.versionId), eq(versions.organisationId, organisationId)),
    )
    .innerJoin(
      workflowRuns,
      and(
        eq(workflowRuns.trackId, versions.trackId),
        eq(workflowRuns.organisationId, organisationId),
        eq(workflowRuns.state, "running"),
      ),
    )
    .where(inOrg(variations, organisationId, eq(variations.fileId, job.fileId)));
  for (const { id } of runs) await checksDue(deps, organisationId, id);
}

/**
 * The clocks that have run out while their run still waits on them (waits, and feedback and task
 * stages past their due date), ended: the queued job normally does it, and this hourly sweep does
 * it when the job was never queued (the queue was down, or the process stopped before it could
 * send it). Checks stages whose files have all been measured end too, should the job that would
 * have ended them have been lost.
 */
export async function sweepRuns(deps: RunnerDeps, now = new Date()) {
  let ended = 0;
  for (const workspace of await deps.db.select({ id: organisations.id }).from(organisations)) {
    const runs = await deps.db
      .select({
        id: workflowRuns.id,
        engine: workflowRuns.engine,
        definition: workflowRuns.definition,
      })
      .from(workflowRuns)
      .where(inOrg(workflowRuns, workspace.id, eq(workflowRuns.state, "running")));
    for (const run of runs) {
      const checking = run.engine.active.some(
        (id) => run.definition.nodes.find((n) => n.id === id)?.type === "checks",
      );
      if (checking)
        ended += await checksDue(deps, workspace.id, run.id).catch((failure: unknown) => {
          console.warn(`Could not end the checks on run ${run.id}: ${String(failure)}`);
          return 0;
        });
      for (const nodeId of run.engine.active) {
        const node = run.definition.nodes.find((n) => n.id === nodeId);
        const clock = node ? stageClock(node) : null;
        if (!clock) continue;
        const [began] = await deps.db
          .select({ id: workflowSteps.id, at: workflowSteps.createdAt })
          .from(workflowSteps)
          .where(
            inOrg(
              workflowSteps,
              workspace.id,
              eq(workflowSteps.runId, run.id),
              sql`${workflowSteps.effects} @> ${JSON.stringify([{ kind: "start", nodeId }])}::jsonb`,
            ),
          )
          .orderBy(desc(workflowSteps.createdAt), desc(workflowSteps.id))
          .limit(1);
        if (!began) continue;
        if (began.at.getTime() + clock.seconds * 1000 > now.getTime()) continue;
        await clockElapsed(deps, {
          organisationId: workspace.id,
          runId: run.id,
          nodeId,
          stepId: began.id,
        }).then(
          () => {
            ended += 1;
          },
          (failure: unknown) =>
            console.warn(`Could not end the clock on run ${run.id}: ${String(failure)}`),
        );
      }
    }
  }
  return ended;
}

/**
 * A review a stage asked for has an outcome (decision 118): the stage ends by it (approved,
 * changes requested, or submitted feedback), with who made the last decision, a member or a
 * guest. A run that has since moved past the stage is left as it is.
 */
export async function reviewSettled(
  deps: RunnerDeps,
  review: {
    organisationId: string;
    outcome: string | null;
    workflowRunId: string | null;
    workflowNodeId: string | null;
  },
  by: { userId: string | null; kind: "member" | "guest" },
) {
  const outcome = stageOutcome(review.outcome);
  if (!review.workflowRunId || !review.workflowNodeId || !outcome) return;
  const nodeId = review.workflowNodeId;
  await completeStep(
    deps,
    {
      organisationId: review.organisationId,
      runId: review.workflowRunId,
      nodeId,
      outcome,
      userId: by.kind === "member" ? by.userId : null,
      by: by.kind,
    },
    (run) => run.state === "running" && run.engine.active.includes(nodeId),
  ).catch((failure: unknown) =>
    console.warn(`A review's outcome could not move its run on: ${String(failure)}`),
  );
}

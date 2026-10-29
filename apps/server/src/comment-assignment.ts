import { type Database, inOrg, schema } from "@hekate/db";
import {
  type AssignableMember,
  assigneeFor,
  type CommentAssignment,
  type DeferStages,
  restartPoints,
  type WorkflowDefinition,
} from "@hekate/shared";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { projectPeople } from "./notifications.ts";

const { projectMembers, projectRoles, tracks, variants, versions, workflowRuns, workflows } =
  schema;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Reader = Database | Tx;

/**
 * A rule must name someone of this project: a member who can see it, or one of its roles.
 * Anyone or anything else, this workspace's or another's, is refused.
 */
export async function assertAssignmentRule(
  db: Reader,
  organisationId: string,
  projectId: string,
  rule: CommentAssignment | null | undefined,
) {
  if (!rule?.assign) return;
  if (rule.assign.kind === "member") {
    const people = await projectPeople(db, organisationId, projectId);
    const userId = rule.assign.userId;
    if (!people.some((p) => p.id === userId))
      throw new HTTPException(422, { message: "Assign comments to someone in this project" });
    return;
  }
  const [role] = await db
    .select({ id: projectRoles.id })
    .from(projectRoles)
    .where(
      inOrg(
        projectRoles,
        organisationId,
        eq(projectRoles.id, rule.assign.roleId),
        eq(projectRoles.projectId, projectId),
      ),
    );
  if (!role) throw new HTTPException(422, { message: "Assign comments to a role of this project" });
}

/** Every stage's rule in a workflow, checked as one of the project's. */
export async function assertDefinitionRules(
  db: Reader,
  organisationId: string,
  projectId: string,
  definition: WorkflowDefinition,
) {
  for (const node of definition.nodes) {
    if (node.assign) await assertAssignmentRule(db, organisationId, projectId, node.assign);
  }
}

/**
 * The track a file belongs to, as a variant of one of its versions; null for a loose file, a
 * score or a take's file.
 */
async function trackOfFile(db: Reader, organisationId: string, fileId: string) {
  const [row] = await db
    .select({ id: tracks.id, commentAssignment: tracks.commentAssignment })
    .from(variants)
    .innerJoin(
      versions,
      and(eq(versions.id, variants.versionId), eq(versions.organisationId, organisationId)),
    )
    .innerJoin(
      tracks,
      and(eq(tracks.id, versions.trackId), eq(tracks.organisationId, organisationId)),
    )
    .where(inOrg(variants, organisationId, eq(variants.fileId, fileId)))
    .limit(1);
  return row ?? null;
}

/**
 * The workflows that apply to a track (decision 040): its own where it has any, otherwise the
 * project's; active ones, in the order made. Without a track, the project's.
 */
async function workflowsFor(
  db: Reader,
  organisationId: string,
  projectId: string,
  trackId: string | null,
) {
  const rows = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      trackId: workflows.trackId,
      definition: workflows.definition,
    })
    .from(workflows)
    .where(
      inOrg(
        workflows,
        organisationId,
        eq(workflows.projectId, projectId),
        eq(workflows.active, true),
        trackId ? undefined : isNull(workflows.trackId),
      ),
    )
    .orderBy(asc(workflows.createdAt), asc(workflows.id));
  const own = rows.filter((w) => w.trackId === trackId);
  return trackId && own.length > 0 ? own : rows.filter((w) => w.trackId === null);
}

/** The steps a track's running workflows wait at now: by workflow, each the node's id. */
async function waitingAt(db: Reader, organisationId: string, trackId: string) {
  const runs = await db
    .select({
      workflowId: workflowRuns.workflowId,
      engine: workflowRuns.engine,
      definition: workflowRuns.definition,
    })
    .from(workflowRuns)
    .where(
      inOrg(
        workflowRuns,
        organisationId,
        eq(workflowRuns.trackId, trackId),
        eq(workflowRuns.state, "running"),
      ),
    )
    .orderBy(desc(workflowRuns.createdAt));
  return runs.map((r) => ({
    workflowId: r.workflowId,
    nodeIds: r.engine.active,
    definition: r.definition,
  }));
}

/**
 * The stages a comment on a file may be deferred to (#499): those of the workflows that apply
 * to its track (or its project), with the step a running workflow waits at marked. A stage is a
 * step a run waits at: an approval, a feedback round, a task, the checks, a wait.
 */
export async function stagesOfFile(
  db: Reader,
  organisationId: string,
  projectId: string,
  fileId: string,
): Promise<DeferStages> {
  const track = await trackOfFile(db, organisationId, fileId);
  const flows = await workflowsFor(db, organisationId, projectId, track?.id ?? null);
  const waiting = track ? await waitingAt(db, organisationId, track.id) : [];
  const currentIn = (workflowId: string) =>
    new Set(waiting.filter((w) => w.workflowId === workflowId).flatMap((w) => w.nodeIds));
  return {
    trackId: track?.id ?? null,
    workflows: flows.map((w) => {
      const current = currentIn(w.id);
      return {
        id: w.id,
        name: w.name,
        stages: restartPoints(w.definition).map((n) => ({
          nodeId: n.id,
          name: n.name,
          current: current.has(n.id),
        })),
      };
    }),
  };
}

/** The project's members in the order they joined, each with their role; owners and admins without a row hold none. */
async function membersOf(
  db: Reader,
  organisationId: string,
  projectId: string,
): Promise<AssignableMember[]> {
  const [rows, people] = await Promise.all([
    db
      .select({ userId: projectMembers.userId, roleId: projectMembers.roleId })
      .from(projectMembers)
      .where(inOrg(projectMembers, organisationId, eq(projectMembers.projectId, projectId)))
      .orderBy(asc(projectMembers.createdAt), asc(projectMembers.id)),
    projectPeople(db, organisationId, projectId),
  ]);
  const seated = new Set(rows.map((r) => r.userId));
  return [
    ...rows,
    ...people.filter((p) => !seated.has(p.id)).map((p) => ({ userId: p.id, roleId: "" })),
  ];
}

/**
 * Whom a comment opened on a file now is for (#499, decision 279): the rule of the stage its
 * track's running workflow waits at (read from the workflow as it is now, so a change in the
 * builder takes effect at once; from the run's own copy where the workflow is gone), over the
 * track's rule, over the project's; resolved against the project's members. Null for nobody.
 */
export async function assigneeOnOpening(
  db: Reader,
  organisationId: string,
  projectId: string,
  fileId: string,
  projectDefault: CommentAssignment | null,
): Promise<string | null> {
  const track = await trackOfFile(db, organisationId, fileId);
  let stageRule: CommentAssignment | undefined;
  if (track) {
    const waiting = await waitingAt(db, organisationId, track.id);
    const ids = waiting.flatMap((w) => (w.workflowId ? [w.workflowId] : []));
    const live =
      ids.length === 0
        ? []
        : await db
            .select({ id: workflows.id, definition: workflows.definition })
            .from(workflows)
            .where(inOrg(workflows, organisationId, inArray(workflows.id, ids)));
    for (const run of waiting) {
      const definition = live.find((w) => w.id === run.workflowId)?.definition ?? run.definition;
      for (const nodeId of run.nodeIds) {
        const node = definition.nodes.find((n) => n.id === nodeId);
        if (node?.assign) {
          stageRule = node.assign;
          break;
        }
      }
      if (stageRule) break;
    }
  }
  if (!stageRule && !track?.commentAssignment && !projectDefault?.assign) return null;
  return assigneeFor(
    stageRule,
    track?.commentAssignment ?? null,
    projectDefault,
    await membersOf(db, organisationId, projectId),
  );
}

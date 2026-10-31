import { z } from "zod";
import { commentAssignment } from "./comment-assignment.ts";
import type { MediaInfo } from "./media.ts";
import type { QaSeverity } from "./qa.ts";

/**
 * The workflow model and its engine (#25, decision 040), pure so the server runs exactly what
 * the builder simulates.
 *
 * A workflow is a graph. Its nodes are events (something happens) and actions (something is
 * done), each with named outcomes. Connectors wire an outcome of one node to another, and may
 * carry a condition; a connector that leads back to a node the item has already passed is a
 * loop, and needs a way out (an "until"). Groups frame nodes as a stage.
 *
 * The rules, checked by the builder and the engine alike: an action never starts a workflow, an
 * event never ends one, an action follows an outcome, a loop needs a stop, and nothing follows a
 * finish.
 */

export const EVENT_TYPES = [
  "upload",
  "folder",
  "manual",
  "review",
  "decision",
  "submitted",
  "comment",
  "resolved",
  "task_done",
  "due",
  "opened",
  "download",
  "mention",
  "recorded",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const ACTION_TYPES = [
  "approval",
  "feedback",
  "task",
  "checks",
  "notify",
  "status",
  "wait",
  "share",
  "move",
  "finish",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export type NodeType = EventType | ActionType;

interface Outcome {
  id: string;
  /** How a connector leaving by it reads ("changes requested"); empty for the only one. */
  label: string;
}

interface NodeTypeInfo {
  kind: "event" | "action";
  /**
   * What the kind is called wherever kinds are offered (#512, decision 290): a verb phrase or a
   * noun that says what it does, never two that read alike ("Approval review" asks reviewers to
   * approve; "Set status" sets one, Approved among them).
   */
  label: string;
  outcomes: Outcome[];
  /**
   * Done by Hekate at once and carried on from (notify, set a status, share, move), rather than
   * started and waited on.
   */
  immediate?: boolean;
}

const happened: Outcome[] = [{ id: "happened", label: "" }];

/**
 * What each kind of node is, and the outcomes it can end by. The stored kinds never change: the
 * QA check is stored as `checks`, as it always was (decision 290).
 */
export const nodeTypes: Record<NodeType, NodeTypeInfo> = {
  upload: { kind: "event", label: "Version uploaded", outcomes: happened },
  folder: { kind: "event", label: "File added to a folder", outcomes: happened },
  manual: { kind: "event", label: "Start by hand", outcomes: happened },
  review: { kind: "event", label: "Review requested", outcomes: happened },
  decision: { kind: "event", label: "Decision recorded", outcomes: happened },
  submitted: { kind: "event", label: "Feedback submitted", outcomes: happened },
  comment: { kind: "event", label: "Comment posted", outcomes: happened },
  resolved: { kind: "event", label: "Comments resolved", outcomes: happened },
  task_done: { kind: "event", label: "Task done", outcomes: happened },
  due: { kind: "event", label: "Due date passed", outcomes: happened },
  opened: { kind: "event", label: "Share opened", outcomes: happened },
  download: { kind: "event", label: "File downloaded", outcomes: happened },
  mention: { kind: "event", label: "Someone mentioned", outcomes: happened },
  recorded: { kind: "event", label: "Track recorded", outcomes: happened },
  approval: {
    kind: "action",
    label: "Approval review",
    outcomes: [
      { id: "approved", label: "all approved" },
      { id: "mixed", label: "some approved" },
      { id: "changes", label: "changes requested" },
    ],
  },
  feedback: {
    kind: "action",
    label: "Feedback review",
    outcomes: [
      { id: "done", label: "submitted" },
      { id: "overdue", label: "due date passed" },
    ],
  },
  task: {
    kind: "action",
    label: "Assign a task",
    outcomes: [
      { id: "done", label: "done" },
      { id: "overdue", label: "due date passed" },
    ],
  },
  checks: {
    kind: "action",
    label: "QA check",
    outcomes: [
      { id: "passed", label: "passed" },
      { id: "warnings", label: "warnings" },
      { id: "failed", label: "failed" },
    ],
  },
  notify: {
    kind: "action",
    label: "Notify",
    outcomes: [{ id: "sent", label: "" }],
    immediate: true,
  },
  status: {
    kind: "action",
    label: "Set status",
    outcomes: [{ id: "set", label: "" }],
    immediate: true,
  },
  wait: { kind: "action", label: "Wait", outcomes: [{ id: "elapsed", label: "" }] },
  share: {
    kind: "action",
    label: "Share a link",
    outcomes: [{ id: "sent", label: "" }],
    immediate: true,
  },
  move: {
    kind: "action",
    label: "Move to a folder",
    outcomes: [{ id: "moved", label: "" }],
    immediate: true,
  },
  finish: { kind: "action", label: "Finish", outcomes: [] },
};

export const outcomesOf = (type: NodeType) => nodeTypes[type].outcomes;

const ident = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "Letters, digits, hyphens and underscores");

/**
 * A connector's own condition, on top of the outcome it leaves by: on the item (its kind, or a
 * tag it carries) or on who made the decision. `not` turns it round.
 */
export const workflowCondition = z.discriminatedUnion("test", [
  z.object({
    test: z.literal("kind"),
    is: z.enum(["audio", "video", "document", "image"]),
    not: z.boolean().optional(),
  }),
  z.object({
    test: z.literal("tag"),
    is: z.string().trim().min(1).max(60),
    not: z.boolean().optional(),
  }),
  z.object({ test: z.literal("by"), is: z.enum(["member", "guest"]), not: z.boolean().optional() }),
]);
export type WorkflowCondition = z.infer<typeof workflowCondition>;

export const workflowNode = z.object({
  id: ident,
  type: z.enum([...EVENT_TYPES, ...ACTION_TYPES]),
  name: z.string().trim().min(1).max(120),
  /** Position on the canvas, the top left corner, in pixels. */
  x: z.number().finite(),
  y: z.number().finite(),
  /**
   * The node's settings as the builder's inspector sets them: who, order, rule, the status it
   * sets (`status`), days until it is due (`due`), days to wait (`days`), and so on.
   */
  config: z.record(z.string().max(64), z.string().max(2000)).default({}),
  groupId: ident.optional(),
  /**
   * Whom a comment opened while a track waits at this stage is for (#499, decision 279): a
   * member or a role, nobody, or, left out, whatever the track and the project say.
   */
  assign: commentAssignment.optional(),
});
export type WorkflowNode = z.infer<typeof workflowNode>;

export const workflowConnector = z.object({
  id: ident,
  from: ident,
  /** Which outcome of `from` it leaves by. */
  outcome: ident,
  to: ident,
  condition: workflowCondition.optional(),
  /** For a loop, its way out: taken at most this many times in a run. */
  until: z.object({ times: z.number().int().min(1).max(100) }).optional(),
});
export type WorkflowConnector = z.infer<typeof workflowConnector>;

export const workflowDefinition = z.object({
  nodes: z.array(workflowNode).max(500),
  connectors: z.array(workflowConnector).max(2000),
  groups: z
    .array(z.object({ id: ident, name: z.string().trim().min(1).max(120) }))
    .max(100)
    .default([]),
});
export type WorkflowDefinition = z.infer<typeof workflowDefinition>;

const kindOf = (type: NodeType) => nodeTypes[type].kind;

/* ---------- Reading the graph ---------- */

/**
 * The events with nothing before them: where the workflow starts. A workflow has one (#514,
 * decision 292); a second is a warning, not an error, so a workflow made before that rule
 * keeps running.
 */
export const triggersOf = (flow: WorkflowDefinition) =>
  flow.nodes.filter(
    (n) => kindOf(n.type) === "event" && !flow.connectors.some((c) => c.to === n.id),
  );

/** The start node's setting that names what else starts the workflow, as event kinds. */
export const START_TRIGGERS = "triggers";

/**
 * What starts a workflow at a start node (#514): its own event, and any other its `triggers`
 * setting names, separated by commas ("manual, recorded"). A start that several things begin
 * stays one node, not one per entry point. Unknown names are left out, as are repeats.
 */
export function startsOn(node: Pick<WorkflowNode, "type" | "config">): EventType[] {
  const named = (node.config[START_TRIGGERS] ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t): t is EventType => (EVENT_TYPES as readonly string[]).includes(t));
  const own = kindOf(node.type) === "event" ? [node.type as EventType] : [];
  return [...new Set([...own, ...named])];
}

/** The start an event of a kind begins the workflow at, if any does. */
export const startFor = (flow: WorkflowDefinition, type: EventType): WorkflowNode | undefined =>
  triggersOf(flow).find((t) => startsOn(t).includes(type));

/**
 * The nodes in the order the workflow reaches them from its triggers, and the connectors that
 * run back to a node already on the way there: the loops. Decided by the graph, not by where
 * the nodes sit on the canvas.
 */
export function flowShape(flow: WorkflowDefinition): { order: string[]; loops: Set<string> } {
  const order: string[] = [];
  const loops = new Set<string>();
  const seen = new Set<string>();
  const leaving = new Map<string, WorkflowConnector[]>();
  for (const c of flow.connectors) leaving.set(c.from, [...(leaving.get(c.from) ?? []), c]);
  const visit = (id: string, path: Set<string>) => {
    if (seen.has(id)) return;
    seen.add(id);
    order.push(id);
    path.add(id);
    for (const c of leaving.get(id) ?? []) {
      if (path.has(c.to)) loops.add(c.id);
      else visit(c.to, path);
    }
    path.delete(id);
  };
  for (const t of triggersOf(flow)) visit(t.id, new Set());
  for (const n of flow.nodes) visit(n.id, new Set());
  return { order, loops };
}

/**
 * The step an item usually reaches after the one it waits at (#26): by the step's first outcome
 * (the way most items go), past anything done at once (a notification, a status), to the next
 * step that waits, or the finish. Null where nothing follows.
 */
export function nextStep(flow: WorkflowDefinition, nodeId: string): WorkflowNode | null {
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  let at = byId.get(nodeId);
  for (let hops = 0; at && hops < flow.nodes.length; hops += 1) {
    const way: string | undefined = outcomesOf(at.type)[0]?.id;
    const from: string = at.id;
    const leaving = flow.connectors.filter((c) => c.from === from);
    const go = leaving.find((c) => c.outcome === way) ?? leaving[0];
    const next = go ? byId.get(go.to) : undefined;
    if (!next || next.id === nodeId) return null;
    if (!nodeTypes[next.type].immediate) return next;
    at = next;
  }
  return null;
}

/** Whether `from` leads on to `to` by connectors that are not loops. */
function reaches(
  flow: WorkflowDefinition,
  from: string,
  to: string,
  loops: ReadonlySet<string>,
): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const c of flow.connectors) if (c.from === id && !loops.has(c.id)) stack.push(c.to);
  }
  return false;
}

export interface WorkflowProblem {
  nodeId?: string;
  connectorId?: string;
  level: "error" | "warning";
  text: string;
}

/** The model's rules, applied: errors keep a workflow from running, warnings do not. */
export function workflowProblems(flow: WorkflowDefinition): WorkflowProblem[] {
  const out: WorkflowProblem[] = [];
  const nodes = new Map(flow.nodes.map((n) => [n.id, n]));
  const name = (id: string) => `“${nodes.get(id)?.name ?? id}”`;
  const ids = new Set<string>();
  for (const n of flow.nodes) {
    if (ids.has(n.id))
      out.push({ nodeId: n.id, level: "error", text: `Two nodes are called ${n.id}.` });
    ids.add(n.id);
  }
  // A loop's bound is counted by its connector, so no two may share an id.
  const wires = new Set<string>();
  for (const c of flow.connectors) {
    if (wires.has(c.id))
      out.push({ connectorId: c.id, level: "error", text: `Two connectors are called ${c.id}.` });
    wires.add(c.id);
  }
  const groups = new Set(flow.groups.map((g) => g.id));
  const starts = triggersOf(flow);
  if (starts.length === 0)
    out.push({
      level: "error",
      text: "Nothing starts this workflow: add an event with nothing before it.",
    });
  // One start per workflow (#514): anything else that should start it is a trigger of that
  // start, and a different path is a workflow of its own.
  for (const extra of starts.slice(1))
    out.push({
      nodeId: extra.id,
      level: "warning",
      text: `${name(extra.id)} is a second start. A workflow has one: name what else starts it on “${starts[0]?.name ?? ""}”, connect something before this, or make it a workflow of its own.`,
    });
  const incoming = (id: string) => flow.connectors.filter((c) => c.to === id);
  const outgoing = (id: string) => flow.connectors.filter((c) => c.from === id);
  for (const n of flow.nodes) {
    const info = nodeTypes[n.type];
    if (n.groupId && !groups.has(n.groupId))
      out.push({ nodeId: n.id, level: "error", text: `${name(n.id)} is in a group that is gone.` });
    if (info.kind === "action" && incoming(n.id).length === 0)
      out.push({
        nodeId: n.id,
        level: "error",
        text: `${name(n.id)} is an action with nothing before it. An action never starts a workflow.`,
      });
    if (info.kind === "event" && outgoing(n.id).length === 0)
      out.push({
        nodeId: n.id,
        level: "error",
        text: `Nothing follows ${name(n.id)}. An event never ends a workflow.`,
      });
    if (info.kind === "action" && info.outcomes.length > 0 && outgoing(n.id).length === 0)
      out.push({
        nodeId: n.id,
        level: "warning",
        text: `${name(n.id)} leads nowhere: the item would stop here without a finish.`,
      });
    // A review that names nobody cannot ask anyone (#513): it would wait to be ended by hand.
    if ((n.type === "approval" || n.type === "feedback") && namedPeople(n.config.who).length === 0)
      out.push({
        nodeId: n.id,
        level: "warning",
        text: `${name(n.id)} asks nobody: choose who reviews, or it waits to be ended by hand.`,
      });
    if (info.outcomes.length === 0 && outgoing(n.id).length > 0)
      out.push({
        nodeId: n.id,
        level: "error",
        text: `${name(n.id)} is a finish: nothing can follow it.`,
      });
  }
  const { loops } = flowShape(flow);
  for (const c of flow.connectors) {
    const from = nodes.get(c.from);
    if (!from || !nodes.has(c.to)) {
      out.push({
        connectorId: c.id,
        level: "error",
        text: "A connector joins a node that is gone.",
      });
      continue;
    }
    if (!outcomesOf(from.type).some((o) => o.id === c.outcome))
      out.push({
        connectorId: c.id,
        level: "error",
        text: `A connector leaves ${name(c.from)} by an outcome it does not have.`,
      });
    if (loops.has(c.id) && !c.until)
      out.push({
        connectorId: c.id,
        level: "warning",
        text: `The loop back to ${name(c.to)} has no way out: give it a bound.`,
      });
  }
  return out;
}

/* ---------- Running ---------- */

/** What a condition is tested against: the item, and who made the decision that led here. */
export interface WorkflowContext {
  item: { kind: "audio" | "video" | "document" | "image" | "other"; tags: string[] };
  by?: "member" | "guest";
}

export function conditionHolds(condition: WorkflowCondition, ctx: WorkflowContext): boolean {
  const holds =
    condition.test === "kind"
      ? ctx.item.kind === condition.is
      : condition.test === "tag"
        ? ctx.item.tags.some((t) => t.toLowerCase() === condition.is.toLowerCase())
        : ctx.by === condition.is;
  return condition.not ? !holds : holds;
}

/** Where a run stands: the nodes it waits on, those waiting for their other branches, and so on. */
export interface WorkflowRun {
  state: "running" | "finished" | "stopped";
  /** Nodes started and waited on: an approval asked for, a task assigned, an event listened for. */
  active: string[];
  /** Nodes reached by one branch, waiting for the others that can still reach them. */
  joining: string[];
  /** How many times each connector has been taken, for the loops' bounds. */
  taken: Record<string, number>;
  /** The item's status, as the last action to set one left it. */
  status: string | null;
}

/** What Hekate is to do as a run moves on; the server carries each out and logs it. */
export type WorkflowEffect =
  | { kind: "start"; nodeId: string; type: ActionType; config: Record<string, string> }
  | { kind: "listen"; nodeId: string; type: EventType; config: Record<string, string> }
  | { kind: "do"; nodeId: string; type: ActionType; config: Record<string, string> }
  | { kind: "status"; nodeId: string; status: string }
  | { kind: "cancel"; nodeId: string }
  | { kind: "finish"; nodeId: string; status: string | null }
  | { kind: "stopped" };

export class WorkflowError extends Error {}

/** A safety bound on any one loop, with or without an until of its own. */
const LOOP_CAP = 100;
/** A safety bound on the nodes one step may pass through. */
const STEP_CAP = 2000;

/**
 * Starts a run from one of the workflow's triggers, as its event has happened; the result is
 * the run and what to do. Refused when the trigger is not one.
 */
export function startRun(
  flow: WorkflowDefinition,
  triggerId: string,
  ctx: WorkflowContext,
): { run: WorkflowRun; effects: WorkflowEffect[] } {
  const error = workflowProblems(flow).find((p) => p.level === "error");
  if (error) throw new WorkflowError(error.text);
  if (!triggersOf(flow).some((t) => t.id === triggerId))
    throw new WorkflowError(`${triggerId} does not start this workflow`);
  const run: WorkflowRun = { state: "running", active: [], joining: [], taken: {}, status: null };
  return step(flow, run, triggerId, "happened", ctx);
}

/**
 * The stages a new version may start a workflow again from (#25), in the order a run reaches
 * them: the steps a run waits at (an approval, feedback, a task, a QA check, a wait).
 */
export function restartPoints(flow: WorkflowDefinition): WorkflowNode[] {
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  return flowShape(flow).order.flatMap((id) => {
    const node = byId.get(id);
    if (!node) return [];
    const info = nodeTypes[node.type];
    return info.kind === "action" && !info.immediate && node.type !== "finish" ? [node] : [];
  });
}

/**
 * Starts a run at one of its stages, as if the workflow had just reached it (a new version
 * restarting it there, #25); the result is the run and what to do. Refused for a step that is
 * not one of its `restartPoints`.
 */
export function startRunAt(
  flow: WorkflowDefinition,
  nodeId: string,
  ctx: WorkflowContext,
): { run: WorkflowRun; effects: WorkflowEffect[] } {
  const error = workflowProblems(flow).find((p) => p.level === "error");
  if (error) throw new WorkflowError(error.text);
  if (!restartPoints(flow).some((n) => n.id === nodeId))
    throw new WorkflowError(`${nodeId} is not a stage this workflow can start again from`);
  const run: WorkflowRun = { state: "running", active: [], joining: [], taken: {}, status: null };
  return step(flow, run, nodeId, null, ctx);
}

/**
 * A run given up for another (a new version restarting its workflow, #25): what it waits on is
 * cancelled, and it stops where it was.
 */
export function stopRun(run: WorkflowRun): { run: WorkflowRun; effects: WorkflowEffect[] } {
  if (run.state !== "running") throw new WorkflowError("The run has ended");
  return {
    run: { ...run, state: "stopped", active: [], joining: [] },
    effects: [
      ...run.active.map((nodeId): WorkflowEffect => ({ kind: "cancel", nodeId })),
      { kind: "stopped" },
    ],
  };
}

/** A new version's choice to start one of the track's workflows again from a stage (#25). */
export const workflowRestartInput = z.object({ workflowId: z.uuid(), nodeId: ident });
export type WorkflowRestartInput = z.infer<typeof workflowRestartInput>;

/**
 * A node the run waits on has ended by one of its outcomes (an approval was given, a task done,
 * the event listened for happened); the run moves on. Refused when the run is not waiting on it.
 */
export function completeNode(
  flow: WorkflowDefinition,
  run: WorkflowRun,
  nodeId: string,
  outcome: string,
  ctx: WorkflowContext,
): { run: WorkflowRun; effects: WorkflowEffect[] } {
  if (run.state !== "running") throw new WorkflowError("The run has ended");
  if (!run.active.includes(nodeId)) throw new WorkflowError(`The run is not waiting on ${nodeId}`);
  const node = flow.nodes.find((n) => n.id === nodeId);
  if (!node || !outcomesOf(node.type).some((o) => o.id === outcome))
    throw new WorkflowError(`${nodeId} cannot end by ${outcome}`);
  const next: WorkflowRun = {
    ...run,
    active: run.active.filter((id) => id !== nodeId),
    joining: [...run.joining],
    taken: { ...run.taken },
  };
  return step(flow, next, nodeId, outcome, ctx);
}

/** Carries a run on from a node's outcome until it waits on something, finishes or stops. */
function step(
  flow: WorkflowDefinition,
  run: WorkflowRun,
  fromId: string,
  outcome: string | null,
  ctx: WorkflowContext,
): { run: WorkflowRun; effects: WorkflowEffect[] } {
  const effects: WorkflowEffect[] = [];
  const nodes = new Map(flow.nodes.map((n) => [n.id, n]));
  const { loops } = flowShape(flow);
  /** Outcomes still to follow, in order; none where the run starts by entering `fromId`. */
  const queue: { from: string; outcome: string }[] =
    outcome === null ? [] : [{ from: fromId, outcome }];
  let steps = 0;

  /** Whether a node the run is on can still lead to `id` (a join waits for it). */
  /** Nodes reached by the outcome being followed and not yet entered. */
  let arriving: string[] = [];
  /**
   * Whether anything the run is on can still lead to `id`, so a join there waits for it: the
   * nodes it waits on, the other joins, the siblings arriving with it, and the immediate
   * actions whose outcomes are still to be followed.
   */
  const pendingFor = (id: string) =>
    [...run.active, ...run.joining, ...arriving, ...queue.map((q) => q.from)].some(
      (other) => other !== id && reaches(flow, other, id, loops),
    );

  const enter = (id: string) => {
    const node = nodes.get(id);
    if (!node) throw new WorkflowError(`${id} is not in this workflow`);
    if (run.active.includes(id)) return;
    const info = nodeTypes[node.type];
    if (info.kind === "event") {
      run.active.push(id);
      effects.push({
        kind: "listen",
        nodeId: id,
        type: node.type as EventType,
        config: node.config,
      });
      return;
    }
    const type = node.type as ActionType;
    const status = node.config.status?.trim();
    if (type === "finish") {
      for (const other of run.active) effects.push({ kind: "cancel", nodeId: other });
      run.active = [];
      run.joining = [];
      if (status) run.status = status;
      run.state = "finished";
      effects.push({ kind: "finish", nodeId: id, status: status || null });
      return;
    }
    if (type === "status") {
      if (status) {
        run.status = status;
        effects.push({ kind: "status", nodeId: id, status });
      }
      queue.push({ from: id, outcome: "set" });
      return;
    }
    if (status) {
      run.status = status;
      effects.push({ kind: "status", nodeId: id, status });
    }
    if (info.immediate) {
      effects.push({ kind: "do", nodeId: id, type, config: node.config });
      queue.push({ from: id, outcome: info.outcomes[0]?.id ?? "" });
      return;
    }
    run.active.push(id);
    effects.push({ kind: "start", nodeId: id, type, config: node.config });
  };

  // An action reached by several branches waits for those still under way; a finish ends the
  // workflow on the first to reach it, and an event is listened for at once.
  const arrive = (id: string) => {
    if (run.joining.includes(id)) return;
    const type = nodes.get(id)?.type;
    const joins = type !== undefined && type !== "finish" && kindOf(type) === "action";
    if (joins && pendingFor(id)) run.joining.push(id);
    else enter(id);
  };

  /** Joins no branch can reach any more go ahead, those nearest the start first. */
  const release = () => {
    for (let again = true; again && run.state === "running"; ) {
      again = false;
      for (const id of [...run.joining]) {
        if (pendingFor(id)) continue;
        run.joining = run.joining.filter((j) => j !== id);
        enter(id);
        again = true;
        break;
      }
    }
  };

  if (outcome === null) enter(fromId);
  while (run.state === "running") {
    const next = queue.shift();
    if (!next) {
      release();
      if (queue.length === 0) break;
      continue;
    }
    steps += 1;
    if (steps > STEP_CAP) throw new WorkflowError("The workflow does not settle: check its loops");
    // Every connector the outcome takes is decided first, so each node it reaches knows of
    // its siblings before a join is judged ready.
    const targets: string[] = [];
    for (const c of flow.connectors) {
      if (c.from !== next.from || c.outcome !== next.outcome) continue;
      if (c.condition && !conditionHolds(c.condition, ctx)) continue;
      const taken = run.taken[c.id] ?? 0;
      if (taken >= Math.min(c.until?.times ?? LOOP_CAP, LOOP_CAP)) continue;
      run.taken[c.id] = taken + 1;
      targets.push(c.to);
    }
    arriving = [...targets];
    for (const id of targets) {
      arriving = arriving.filter((a) => a !== id);
      arrive(id);
      if (run.state !== "running") break;
    }
    arriving = [];
  }
  if (run.state === "running" && run.active.length === 0 && run.joining.length === 0) {
    run.state = "stopped";
    effects.push({ kind: "stopped" });
  }
  return { run, effects };
}

/**
 * A workflow played through, as the builder's simulation does: started from a trigger, then
 * each node the script names ended by the outcome it gives, in turn. Each step says what Hekate
 * would do; a step the run is not waiting for is refused.
 */
export function simulateWorkflow(
  flow: WorkflowDefinition,
  triggerId: string,
  script: { nodeId: string; outcome: string }[],
  ctx: WorkflowContext,
): { run: WorkflowRun; steps: WorkflowEffect[][] } {
  let { run, effects } = startRun(flow, triggerId, ctx);
  const steps = [effects];
  for (const s of script) {
    ({ run, effects } = completeNode(flow, run, s.nodeId, s.outcome, ctx));
    steps.push(effects);
  }
  return { run, steps };
}

/* ---------- Stored ---------- */

/**
 * A workflow as made (#25): a project's own, or a track's, which then runs for that track in
 * place of the project's. It is made inactive; it runs only once it is switched on, and only
 * while it breaks no rule.
 */
export const workflowInput = z.object({
  name: z.string().trim().min(1).max(120),
  trackId: z.uuid().nullable().optional(),
  definition: workflowDefinition,
});
export type WorkflowInput = z.infer<typeof workflowInput>;

/**
 * What changes on a workflow; anything left out stays. `version`, when given, is the version
 * the change was made from, so a change made over someone else's is refused, not lost.
 */
export const workflowChangeInput = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  active: z.boolean().optional(),
  definition: workflowDefinition.optional(),
  version: z.number().int().min(1).optional(),
});
export type WorkflowChange = z.infer<typeof workflowChangeInput>;

/** Someone a stage's *who* or *to* names, as written there. */
export type NamedPerson =
  /** A role or a group of the project, by name ("Producer", "Soloists"). */
  | { kind: "name"; name: string }
  /** A guest of the workspace, by the name they are known by ("Mira Solberg (guest)"). */
  | { kind: "guest"; name: string }
  /** A guest by email ("mira@example.test", or "Mira Solberg <mira@example.test>"). */
  | { kind: "email"; email: string; name?: string };

/**
 * The people a stage's *who* or *to* names (decision 121), separated by commas: roles and groups
 * of the project by name, guests by the name they are known by followed by "(guest)", and anyone
 * by email, with their name before it in angle brackets where they are new.
 */
export function namedPeople(text: string | undefined): NamedPerson[] {
  // Read with string operations rather than patterns, which slow down on long crafted input.
  const isEmail = (s: string) => {
    const at = s.indexOf("@");
    return at > 0 && at === s.lastIndexOf("@") && at < s.length - 1 && !/[\s<>]/.test(s);
  };
  return (text ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part): NamedPerson => {
      const open = part.lastIndexOf("<");
      if (open >= 0 && part.endsWith(">")) {
        const email = part.slice(open + 1, -1).trim();
        const name = part.slice(0, open).trim();
        if (isEmail(email))
          return { kind: "email", email: email.toLowerCase(), ...(name ? { name } : {}) };
      }
      if (isEmail(part)) return { kind: "email", email: part.toLowerCase() };
      const guest = part.toLowerCase().endsWith("(guest)") ? part.slice(0, -7).trim() : "";
      if (guest) return { kind: "guest", name: guest };
      return { kind: "name", name: part };
    });
}

/**
 * The clock a node starts when a run reaches it (decision 120): a wait runs its days and ends
 * elapsed; a feedback or task stage given days until it is due ends overdue when they pass,
 * unless it has ended first. Null for a node without one.
 */
export function stageClock(node: Pick<WorkflowNode, "type" | "config">): {
  seconds: number;
  outcome: "elapsed" | "overdue";
} | null {
  const days = (value: string | undefined) => {
    const n = Number.parseFloat(value ?? "");
    return Number.isFinite(n) && n > 0 ? Math.round(n * 86_400) : 0;
  };
  if (node.type === "wait") return { seconds: days(node.config.days), outcome: "elapsed" };
  if (node.type !== "feedback" && node.type !== "task") return null;
  const due = days(node.config.due);
  return due > 0 ? { seconds: due, outcome: "overdue" } : null;
}

/**
 * A file of the version a QA check is about, as the stage sees it: still being measured, not
 * checked (it has no sound), not measurable (its probe or analysis failed), or checked, with the
 * severities of what its quality report found.
 */
export type MeasuredFile =
  | { state: "measuring" }
  | { state: "unchecked" }
  | { state: "unmeasurable" }
  | { state: "checked"; severities: QaSeverity[] };

/**
 * How far a file has been measured, for a QA check: still being measured, not checked, not
 * measurable, or measured, when its quality report is to be read. Sound and picture are measured
 * once probed. A recording whose probe found no sound, or a video in which it found neither sound
 * nor picture, could not be read; a silent video has its picture checked (#42), unless it was
 * probed before that, and a score is not checked.
 */
export function measuredState(file: {
  kind: string;
  mediaInfo: MediaInfo | null;
  streamStatus: string;
  analysisStatus: string;
}): "measuring" | "unchecked" | "unmeasurable" | "measured" {
  const media = file.kind === "audio" || file.kind === "video";
  if (!media) return "unchecked";
  if (!file.mediaInfo) return file.streamStatus === "failed" ? "unmeasurable" : "measuring";
  if (!file.mediaInfo.audio?.channels) {
    if (file.kind === "audio" || !file.mediaInfo.video) return "unmeasurable";
    // A silent video's picture is checked (#42); one probed before that was not.
    if (file.analysisStatus === "none") return "unchecked";
  }
  if (file.analysisStatus === "failed") return "unmeasurable";
  return file.analysisStatus === "ready" ? "measured" : "measuring";
}

/**
 * How a QA check ends (decision 119): null while any file is still being measured; failed
 * when any check fails or a file cannot be measured; warnings when any warns; passed otherwise,
 * a version with nothing to check included.
 */
export function checksOutcome(files: MeasuredFile[]): "passed" | "warnings" | "failed" | null {
  if (files.some((f) => f.state === "measuring")) return null;
  const found = files.flatMap((f) => (f.state === "checked" ? f.severities : []));
  if (files.some((f) => f.state === "unmeasurable") || found.includes("fail")) return "failed";
  return found.includes("warn") ? "warnings" : "passed";
}

/** A workflow as the builder and the project's settings show it, with what it breaks. */
export interface WorkflowSummary {
  id: string;
  projectId: string;
  /** The track it runs for in place of the project's workflows; null for the project's own. */
  trackId: string | null;
  name: string;
  active: boolean;
  /** Raised by every change to it; a run keeps the definition it started with. */
  version: number;
  definition: WorkflowDefinition;
  problems: WorkflowProblem[];
  updatedAt: string;
}

/** Starting a workflow by hand on a track, from its "Started by hand" trigger. */
export const workflowRunStartInput = z.object({ workflowId: z.uuid() });

/** A step a run waits on, ended by hand, by one of its outcomes. */
export const workflowStepInput = z.object({ nodeId: ident, outcome: ident });

/** Where a track stands in its workflow (#26), as its page says it. */
export interface WorkflowStanding {
  /** The status its workflow last gave it, and how the project's status set reads it. */
  status: string | null;
  category: "todo" | "in_progress" | "done" | null;
  /** The step its running workflow waits at, and the step it usually reaches next. */
  stage: string | null;
  next: string | null;
}

/** A run as a track shows it: where it stands, and every move it made. */
export interface WorkflowRunSummary {
  id: string;
  workflowId: string | null;
  workflowName: string;
  workflowVersion: number;
  trackId: string;
  state: WorkflowRun["state"] | "cancelled";
  status: string | null;
  /** The steps it waits on, by name. */
  waiting: { nodeId: string; name: string; type: NodeType }[];
  steps: {
    nodeId: string | null;
    /** The step's name as the run's workflow had it; null for the trigger that started it. */
    name: string | null;
    /** Its kind, for how its outcome reads; null for the trigger, or a step since removed. */
    type: NodeType | null;
    outcome: string | null;
    effects: WorkflowEffect[];
    byUserId: string | null;
    /** Who ended the step, by name, where someone did; null where Hekate moved it on. */
    byName: string | null;
    at: string;
  }[];
  /** Who started the run, by name, where someone did (a version uploaded, a start by hand). */
  startedBy: string | null;
  startedAt: string;
  endedAt: string | null;
}

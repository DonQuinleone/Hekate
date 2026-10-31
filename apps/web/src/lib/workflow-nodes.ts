import {
  type EventType,
  flowShape,
  type NodeType,
  nodeTypes,
  outcomesOf,
  START_TRIGGERS,
  startsOn,
  triggersOf,
  type WorkflowConnector,
  type WorkflowDefinition,
  type WorkflowEffect,
  type WorkflowNode,
} from "@hekate/shared";
import type { IconName } from "~/components/icons";
import { groupOf } from "~/lib/workflow-kinds";

/**
 * A setting a node's inspector and the basic view show (#26), as the prototype has them: its
 * own choices, or the project's people (roles and groups) to choose from, or words.
 */
export interface NodeField {
  id: string;
  label: string;
  options?: readonly string[];
  /** Chosen from the project's roles and groups, as its `who` or `to` names them. */
  people?: boolean;
  placeholder?: string;
}

/** What the builder shows of a kind of node beside the engine's own: a hint, an icon, its fields. */
export interface NodeLook {
  hint: string;
  icon: IconName;
  fields: readonly NodeField[];
}

const who: NodeField = { id: "who", label: "Who", people: true };
const order: NodeField = { id: "order", label: "Order", options: ["All at once", "In turn"] };
const status: NodeField = { id: "status", label: "Sets status", placeholder: "Editing" };
const due: NodeField = { id: "due", label: "Due in days", placeholder: "3" };

/**
 * Each kind's one-line description and icon (#512, decision 290): no two kinds share an icon
 * within a family, nor an icon and a colour across them.
 */
export const nodeLooks: Record<NodeType, NodeLook> = {
  upload: { hint: "A new version arrives, past the upload rules", icon: "upload", fields: [] },
  folder: { hint: "Any file, or one in a chosen folder", icon: "folder", fields: [] },
  manual: { hint: "Someone starts it from the track", icon: "play", fields: [] },
  review: { hint: "A review of any kind, or of one kind", icon: "inbox", fields: [] },
  decision: { hint: "A reviewer approves or asks for changes", icon: "gate", fields: [] },
  submitted: { hint: "By everyone asked, or by anyone", icon: "comment", fields: [] },
  comment: { hint: "Any comment, or one of a category", icon: "pin", fields: [] },
  resolved: { hint: "Every comment on the version", icon: "check", fields: [] },
  task_done: { hint: "Any task on the item marked done", icon: "task", fields: [] },
  due: { hint: "Of the stage, a review or a task", icon: "calendar", fields: [] },
  opened: { hint: "By anyone it was sent to", icon: "eye", fields: [] },
  download: { hint: "Of the proxy or the original", icon: "download", fields: [] },
  mention: { hint: "Someone named in a comment", icon: "user", fields: [] },
  recorded: { hint: "Every slot it has on the schedule ticked off", icon: "mic", fields: [] },
  approval: {
    hint: "Ask reviewers to approve or request changes",
    icon: "review",
    fields: [
      who,
      order,
      { id: "rule", label: "Approved when", options: ["Everyone approves", "Any one approves"] },
      status,
      due,
    ],
  },
  feedback: {
    hint: "Ask reviewers for comments; no formal decision",
    icon: "comment",
    fields: [who, order, status, due],
  },
  task: {
    hint: "Someone does the work and marks it done",
    icon: "task",
    fields: [{ ...who, label: "Role" }, status, due],
  },
  checks: { hint: "Run the project's QA rules on the version", icon: "shield", fields: [] },
  notify: {
    hint: "Tell people, then carry on",
    icon: "bell",
    fields: [
      { id: "to", label: "To", people: true },
      { id: "message", label: "Message", placeholder: "Notes are in." },
    ],
  },
  status: {
    hint: "Change the item's status, then carry on",
    icon: "flag",
    fields: [{ id: "status", label: "Status", placeholder: "Editing" }],
  },
  wait: {
    hint: "Pause for some days before carrying on",
    icon: "clock",
    fields: [{ id: "days", label: "Days", placeholder: "1" }],
  },
  share: {
    hint: "Send a link to named people; no review",
    icon: "send",
    fields: [
      { id: "to", label: "To", placeholder: "Producer, ines@example.test" },
      { id: "expires", label: "Expires in days", placeholder: "7" },
    ],
  },
  move: {
    hint: "File the item away in a folder",
    icon: "folderPlus",
    fields: [{ id: "folder", label: "Folder", placeholder: "Masters" }],
  },
  finish: {
    hint: "The workflow ends here, with a final status",
    icon: "stop",
    fields: [{ id: "status", label: "Final status", placeholder: "Approved" }],
  },
};

/** A step of the basic view: an action, and the loops that leave it for an earlier step. */
export interface BasicStep {
  node: WorkflowNode;
  loops: WorkflowConnector[];
}

/**
 * A workflow as the basic view lists it (#26): what starts it, its steps in the order a run
 * meets them (every action but a finish), and the finish it ends at.
 */
export function basicSteps(flow: WorkflowDefinition): {
  triggers: WorkflowNode[];
  steps: BasicStep[];
  finish: WorkflowNode | undefined;
} {
  const { order, loops } = flowShape(flow);
  const nodes = order
    .map((id) => flow.nodes.find((n) => n.id === id))
    .filter((n): n is WorkflowNode => Boolean(n));
  return {
    triggers: triggersOf(flow),
    steps: nodes
      .filter((n) => nodeTypes[n.type].kind === "action" && n.type !== "finish")
      .map((node) => ({
        node,
        loops: flow.connectors.filter((c) => c.from === node.id && loops.has(c.id)),
      })),
    finish: nodes.find((n) => n.type === "finish"),
  };
}

/**
 * A new workflow, as the prototype starts one: its start (a version arriving, unless another is
 * chosen, #514) and a finish to wire it to.
 */
export const newWorkflowDefinition = (start: NodeType = "upload"): WorkflowDefinition => ({
  nodes: [
    {
      id: "start",
      type: nodeTypes[start].kind === "event" ? start : "upload",
      name: nodeTypes[nodeTypes[start].kind === "event" ? start : "upload"].label,
      x: 0,
      y: 0,
      config: {},
    },
    { id: "end", type: "finish", name: "Finish", x: 640, y: 0, config: {} },
  ],
  connectors: [],
  groups: [],
});

/** The workflow's start, if it has one: the event with nothing before it (#514). */
export const startOf = (flow: WorkflowDefinition): WorkflowNode | undefined => triggersOf(flow)[0];

/**
 * Why a node of a kind cannot be added where asked, or null when it can (#514, decision 292).
 * An event with nothing before it would be a second start: one that starts workflows belongs
 * among the start's triggers, or begins a new workflow; one waited for follows a step.
 */
export function addRefusal(flow: WorkflowDefinition, type: NodeType, from?: string): string | null {
  if (nodeTypes[type].kind !== "event" || from) return null;
  const start = startOf(flow);
  if (!start) return null;
  return groupOf(type) === "start"
    ? `This workflow starts at “${start.name}”: name it among what starts it there, or begin a new workflow.`
    : "A wait follows a step: drop it on a step's output, or add it after one.";
}

/** A start's triggers changed: what else, besides its own event, starts the workflow there. */
export function withStartTrigger(
  flow: WorkflowDefinition,
  nodeId: string,
  type: EventType,
  on: boolean,
): WorkflowDefinition {
  const node = flow.nodes.find((n) => n.id === nodeId);
  if (!node) return flow;
  const others = startsOn(node).filter((t) => t !== node.type && t !== type);
  const next = on && type !== node.type ? [...others, type] : others;
  return withConfig(flow, nodeId, { [START_TRIGGERS]: next.join(", ") });
}

/** A node's settings changed: the rest of the workflow as it was. */
export const withConfig = (
  flow: WorkflowDefinition,
  nodeId: string,
  config: Record<string, string>,
): WorkflowDefinition => ({
  ...flow,
  nodes: flow.nodes.map((n) => {
    if (n.id !== nodeId) return n;
    const next = { ...n.config };
    // An emptied setting is taken away rather than kept as nothing.
    for (const [key, value] of Object.entries(config)) {
      if (value.trim()) next[key] = value;
      else delete next[key];
    }
    return { ...n, config: next };
  }),
});

/** A connector changed: where a loop leads back to, or how many times it may be taken. */
export const withConnector = (
  flow: WorkflowDefinition,
  id: string,
  change: Partial<Pick<WorkflowConnector, "to" | "until">>,
): WorkflowDefinition => ({
  ...flow,
  connectors: flow.connectors.map((c) => {
    if (c.id !== id) return c;
    const next = { ...c, ...change };
    if ("until" in change && change.until === undefined) delete next.until;
    return next;
  }),
});

/* ---------- The canvas (#26): its geometry and its edits, as the prototype draws them ---------- */

export const NODE_W = 208;
export const NODE_H = 60;
/** The space between one workflow and the next on the canvas. */
export const BAND_GAP = 180;
/** Between one outcome's port and the next: room for the chips beside them. */
const PORT_STEP = 22;

export interface Pt {
  x: number;
  y: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

type Placed = Pick<WorkflowNode, "type" | "x" | "y">;

const portY = (n: Placed, i: number, k: number) => n.y + NODE_H / 2 + (i - (k - 1) / 2) * PORT_STEP;

/** Where a node's outcome leaves it: one port each, down its right edge. */
export function outPort(n: Placed, outcome: string): Pt {
  const outs = outcomesOf(n.type);
  const i = Math.max(
    0,
    outs.findIndex((o) => o.id === outcome),
  );
  return { x: n.x + NODE_W, y: portY(n, i, outs.length) };
}

/** A port's offset from its node's top, for drawing it on the node. */
export const portTop = (type: NodeType, i: number) =>
  NODE_H / 2 + (i - (outcomesOf(type).length - 1) / 2) * PORT_STEP;

export const inPort = (n: Placed): Pt => ({ x: n.x, y: n.y + NODE_H / 2 });

/** How a connector's line is drawn: where a loop's bottom run lies, and how it clears others. */
export interface Route {
  loop: boolean;
  /** The height of a loop's bottom run, below the workflow. */
  floor: number;
  /** How far it runs straight out of its port before turning: past the chips beside it. */
  lead?: number;
  /** Extra room before a loop drops, and before it rises into its node, so loops leaving or
   * entering the same node run side by side rather than on top of each other. */
  out?: number;
  into?: number;
}

/**
 * A connector's line: straight out of its port past its chip, then a forward one curves into its
 * node; a loop drops below the workflow and comes back in from the left.
 */
export function connectorPath(a: Pt, b: Pt, route: Route): string {
  const { loop, floor, lead = 28, out = 0, into = 0 } = route;
  const start = a.x + lead;
  if (!loop && b.x >= start + 48) {
    const dx = Math.max(40, (b.x - start) / 2);
    return `M${a.x},${a.y} H${start} C${start + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
  }
  const r = 12;
  const x1 = start + out;
  const x2 = b.x - 28 - into;
  return [
    `M${a.x},${a.y}`,
    `H${x1 - r} Q${x1},${a.y} ${x1},${a.y + r}`,
    `V${floor - r} Q${x1},${floor} ${x1 - r},${floor}`,
    `H${x2 + r} Q${x2},${floor} ${x2},${floor - r}`,
    `V${b.y + r} Q${x2},${b.y} ${x2 + r},${b.y}`,
    `H${b.x}`,
  ].join(" ");
}

export function boundsOf(nodes: { x: number; y: number }[]): Bounds {
  if (nodes.length === 0) return { minX: 0, minY: 0, maxX: NODE_W, maxY: NODE_H };
  return {
    minX: Math.min(...nodes.map((n) => n.x)),
    minY: Math.min(...nodes.map((n) => n.y)),
    maxX: Math.max(...nodes.map((n) => n.x)) + NODE_W,
    maxY: Math.max(...nodes.map((n) => n.y)) + NODE_H,
  };
}

/** A fresh id for a node or a connector, as the model's identifiers allow. */
export const freshId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

const snap = (v: number) => Math.round(v / 10) * 10;

/**
 * A node added at a place on the canvas, named after its kind; from a node, wired from its
 * first outcome not yet wired (else its first).
 */
export function withNode(
  flow: WorkflowDefinition,
  type: NodeType,
  at: Pt,
  from?: string,
  id = freshId("n"),
): WorkflowDefinition {
  // Never a second start (#514): such a node is refused, the workflow left as it was.
  if (addRefusal(flow, type, from)) return flow;
  const node: WorkflowNode = {
    id,
    type,
    name: nodeTypes[type].label,
    x: snap(at.x),
    y: snap(at.y),
    config: {},
  };
  const connectors = [...flow.connectors];
  const source = from ? flow.nodes.find((n) => n.id === from) : undefined;
  if (source) {
    const outs = outcomesOf(source.type);
    const free = outs.find(
      (o) => !connectors.some((c) => c.from === source.id && c.outcome === o.id),
    );
    const outcome = free ?? outs[0];
    if (outcome)
      connectors.push({ id: freshId("c"), from: source.id, outcome: outcome.id, to: id });
  }
  return { ...flow, nodes: [...flow.nodes, node], connectors };
}

/** A connector from a node's outcome to another node; once only, and never to itself. */
export function withLink(
  flow: WorkflowDefinition,
  from: string,
  outcome: string,
  to: string,
): WorkflowDefinition {
  if (from === to) return flow;
  if (flow.connectors.some((c) => c.from === from && c.outcome === outcome && c.to === to))
    return flow;
  return { ...flow, connectors: [...flow.connectors, { id: freshId("c"), from, outcome, to }] };
}

/** A node taken away, with every connector to or from it. */
export const withoutNode = (flow: WorkflowDefinition, id: string): WorkflowDefinition => ({
  ...flow,
  nodes: flow.nodes.filter((n) => n.id !== id),
  connectors: flow.connectors.filter((c) => c.from !== id && c.to !== id),
});

export const withoutConnector = (flow: WorkflowDefinition, id: string): WorkflowDefinition => ({
  ...flow,
  connectors: flow.connectors.filter((c) => c.id !== id),
});

/** A copy of a node beside it, unwired. */
export function withCopy(flow: WorkflowDefinition, id: string, copyId = freshId("n")) {
  const n = flow.nodes.find((x) => x.id === id);
  if (!n) return flow;
  return {
    ...flow,
    nodes: [
      ...flow.nodes,
      { ...n, id: copyId, name: `${n.name} (copy)`, x: n.x + 40, y: n.y + 80 },
    ],
  };
}

/** A node changed in place: its name, settings, place or stage. */
export const withNodeChange = (
  flow: WorkflowDefinition,
  id: string,
  change: Partial<Omit<WorkflowNode, "id" | "type">>,
): WorkflowDefinition => ({
  ...flow,
  nodes: flow.nodes.map((n) => (n.id === id ? { ...n, ...change } : n)),
});

/** A connector's own condition, as it reads on the canvas: "if video", "unless tagged Live". */
export function conditionText(c: WorkflowConnector): string | null {
  const k = c.condition;
  const parts: string[] = [];
  if (k) {
    const what =
      k.test === "kind"
        ? `${k.is}`
        : k.test === "tag"
          ? `tagged ${k.is}`
          : k.is === "guest"
            ? "a guest decided"
            : "a member decided";
    parts.push(`${k.not ? "unless" : "if"} ${what}`);
  }
  if (c.until) parts.push(`at most ${c.until.times}×`);
  return parts.length > 0 ? parts.join(", ") : null;
}

/* ---------- Walking an item through (#26), by the engine itself ---------- */

const quoted = (flow: WorkflowDefinition, id: string) =>
  `“${flow.nodes.find((n) => n.id === id)?.name ?? id}”`;

/** What an outcome reads as in the walk: "Approved", "It happens", "It is done". */
export function outcomeWords(type: NodeType, outcome: string): string {
  const label = outcomesOf(type).find((o) => o.id === outcome)?.label;
  if (label) return `${label[0]?.toUpperCase()}${label.slice(1)}`;
  return nodeTypes[type].kind === "event" ? "It happens" : "It is done";
}

/**
 * What a walk must ask beyond the item's kind: the tags the workflow's conditions test (each
 * once, as first written), and whether any condition asks who made the decision.
 */
export function walkQuestions(flow: WorkflowDefinition): { tags: string[]; asksWho: boolean } {
  const tags = new Map<string, string>();
  let asksWho = false;
  for (const c of flow.connectors) {
    if (c.condition?.test === "tag") {
      const key = c.condition.is.toLowerCase();
      if (!tags.has(key)) tags.set(key, c.condition.is);
    }
    if (c.condition?.test === "by") asksWho = true;
  }
  return { tags: [...tags.values()], asksWho };
}

/** One thing a run does, as the walk tells it; null for what needs no telling. */
export function walkLine(flow: WorkflowDefinition, effect: WorkflowEffect): string | null {
  switch (effect.kind) {
    case "start":
      return `${quoted(flow, effect.nodeId)} begins; the item waits on it.`;
    case "listen":
      return `It waits for ${quoted(flow, effect.nodeId)}.`;
    case "do":
      if (effect.type === "notify")
        return `${quoted(flow, effect.nodeId)}: ${effect.config.to || "nobody named"} told.`;
      if (effect.type === "share")
        return `${quoted(flow, effect.nodeId)}: shared with ${effect.config.to || "nobody named"}.`;
      if (effect.type === "move")
        return `${quoted(flow, effect.nodeId)}: filed in ${effect.config.folder || "the top of the project"}.`;
      return effect.type === "status" ? null : `${quoted(flow, effect.nodeId)} is done.`;
    case "status":
      return `Its status is now ${effect.status}.`;
    case "cancel":
      return `${quoted(flow, effect.nodeId)} is no longer waited on.`;
    case "finish":
      return `It finishes at ${quoted(flow, effect.nodeId)}${effect.status ? `, ${effect.status}` : ""}.`;
    case "stopped":
      return "Nothing follows: the item stops here.";
  }
}

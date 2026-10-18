import {
  flowShape,
  type NodeType,
  nodeTypes,
  outcomesOf,
  triggersOf,
  type WorkflowConnector,
  type WorkflowDefinition,
  type WorkflowEffect,
  type WorkflowNode,
} from "@hekate/shared";
import type { IconName } from "~/components/icons";

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

export const nodeLooks: Record<NodeType, NodeLook> = {
  upload: { hint: "Checked at the door by the upload rules", icon: "upload", fields: [] },
  folder: { hint: "Any file, or a chosen folder", icon: "folder", fields: [] },
  manual: { hint: "From the track", icon: "play", fields: [] },
  review: { hint: "Of any kind, or one kind", icon: "review", fields: [] },
  decision: { hint: "Approved or changes requested", icon: "check", fields: [] },
  submitted: { hint: "By everyone, or anyone", icon: "comment", fields: [] },
  comment: { hint: "Any, or one category", icon: "comment", fields: [] },
  resolved: { hint: "On the version", icon: "check", fields: [] },
  task_done: { hint: "Any task on the item", icon: "task", fields: [] },
  due: { hint: "Of the stage, or of a review", icon: "clock", fields: [] },
  opened: { hint: "By anyone it was sent to", icon: "eye", fields: [] },
  download: { hint: "Of the proxy or the original", icon: "download", fields: [] },
  mention: { hint: "In a comment", icon: "user", fields: [] },
  approval: {
    hint: "Each reviewer records approved or changes requested",
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
    hint: "Comments, then submitted; no formal decision",
    icon: "comment",
    fields: [who, order, status, due],
  },
  task: {
    hint: "Someone does the work and marks it done",
    icon: "task",
    fields: [{ ...who, label: "Role" }, status, due],
  },
  checks: { hint: "The project's QA rules on the item", icon: "shield", fields: [] },
  notify: {
    hint: "Tell someone, then carry on",
    icon: "bell",
    fields: [
      { id: "to", label: "To", people: true },
      { id: "message", label: "Message", placeholder: "Notes are in." },
    ],
  },
  status: {
    hint: "Mark the item",
    icon: "flag",
    fields: [{ id: "status", label: "Status", placeholder: "Editing" }],
  },
  wait: {
    hint: "A pause before carrying on",
    icon: "clock",
    fields: [{ id: "days", label: "Days", placeholder: "1" }],
  },
  share: {
    hint: "A link to named people, no review",
    icon: "send",
    fields: [
      { id: "to", label: "To", placeholder: "Producer, ines@example.test" },
      { id: "expires", label: "Expires in days", placeholder: "7" },
    ],
  },
  move: {
    hint: "File the item away",
    icon: "folderPlus",
    fields: [{ id: "folder", label: "Folder", placeholder: "Masters" }],
  },
  finish: {
    hint: "The workflow ends here",
    icon: "stop",
    fields: [{ id: "status", label: "Final status", placeholder: "Approved" }],
  },
};

/** The six families nodes come in, each with a shape and a colour (as in the prototype). */
export type Family = "event" | "review" | "work" | "comm" | "flow" | "finish";

export const familyOf = (t: NodeType): Family =>
  nodeTypes[t].kind === "event"
    ? "event"
    : t === "approval" || t === "feedback"
      ? "review"
      : t === "task" || t === "checks"
        ? "work"
        : t === "notify" || t === "share"
          ? "comm"
          : t === "finish"
            ? "finish"
            : "flow";

export const familyTiles: Record<Family, string> = {
  event: "bg-node-event/15 text-node-event",
  review: "bg-node-review/15 text-node-review",
  work: "bg-node-work/15 text-node-work",
  comm: "bg-node-comm/15 text-node-comm",
  flow: "bg-node-flow/15 text-node-flow",
  finish: "bg-ink text-ground",
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

/** A new workflow, as the prototype starts one: a version arriving, and a finish to wire it to. */
export const newWorkflowDefinition = (): WorkflowDefinition => ({
  nodes: [
    { id: "start", type: "upload", name: "A version is uploaded", x: 0, y: 0, config: {} },
    { id: "end", type: "finish", name: "Finish", x: 640, y: 0, config: {} },
  ],
  connectors: [],
  groups: [],
});

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
const PORT_STEP = 18;

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

/**
 * A connector's line: a forward one curves; a loop goes right, drops below the workflow, and
 * comes back in from the left.
 */
export function connectorPath(a: Pt, b: Pt, loop: boolean, floor: number): string {
  if (!loop && b.x >= a.x + 48) {
    const dx = Math.max(60, (b.x - a.x) / 2);
    return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
  }
  const r = 12;
  const x1 = a.x + 28;
  const x2 = b.x - 28;
  return [
    `M${a.x},${a.y}`,
    `H${x1 - r} Q${x1},${a.y} ${x1},${a.y + r}`,
    `V${floor - r} Q${x1},${floor} ${x1 - r},${floor}`,
    `H${x2 + r} Q${x2},${floor} ${x2},${floor - r}`,
    `V${b.y + r} Q${x2},${b.y} ${x2 + r},${b.y}`,
    `H${b.x}`,
  ].join(" ");
}

/** Where a connector's label sits: the middle of a curve, the bottom run of a loop. */
export function labelAt(a: Pt, b: Pt, loop: boolean, floor: number): Pt {
  if (!loop && b.x >= a.x + 48) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return { x: (a.x + 28 + b.x - 28) / 2, y: floor };
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

/** What the picker offers, grouped as the prototype groups it. */
export const pickerGroups: { group: string; types: NodeType[] }[] = [
  { group: "Review", types: ["approval", "feedback"] },
  { group: "Work", types: ["task", "checks", "notify", "share", "move"] },
  { group: "Flow", types: ["wait", "status", "finish"] },
  {
    group: "Events: start on, or wait for",
    types: (Object.keys(nodeTypes) as NodeType[]).filter((t) => nodeTypes[t].kind === "event"),
  },
];

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

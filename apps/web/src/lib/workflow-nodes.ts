import {
  flowShape,
  type NodeType,
  nodeTypes,
  triggersOf,
  type WorkflowConnector,
  type WorkflowDefinition,
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

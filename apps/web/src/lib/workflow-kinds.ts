import { type NodeType, nodeTypes } from "@hekate/shared";

/**
 * The kinds of workflow node as people meet them (#512, decision 290): each in a family with a
 * colour of the app's own set (a start in the signal colour, reviews blue, a QA check warm,
 * tasks green, a wait in quiet ink, statuses teal, messages violet, the finish in ink), and
 * each with an icon of its own (`nodeLooks`), so no two kinds are drawn alike. A family is
 * also what the Add button offers first (#511), in the order a workflow reads, left to right.
 */
export type KindGroup =
  | "start"
  | "qa"
  | "review"
  | "task"
  | "wait"
  | "status"
  | "notify"
  | "finish";

export interface GroupLook {
  label: string;
  /** What the family is for, in a line. */
  hint: string;
  /** The colour token its kinds are drawn in. */
  colour: string;
  /** Its kinds' icon tile. */
  tile: string;
  /** Its kinds' mark on the map of the canvas. */
  fill: string;
  /** A swatch of its shape and colour, for the legend. */
  swatch: string;
  /** Its actions' shape on the canvas; an event keeps the start's. */
  shape: string;
}

/** An event's shape, whatever its family: a D, as a start is drawn. */
export const EVENT_SHAPE = "rounded-l-full rounded-r-panel pl-4";
const slanted = "rounded-panel [clip-path:polygon(10px_0,100%_0,calc(100%-10px)_100%,0_100%)] pl-5";

export const groups: Record<KindGroup, GroupLook> = {
  start: {
    label: "Start",
    hint: "What begins the workflow",
    colour: "node-event",
    tile: "bg-node-event/15 text-node-event",
    fill: "fill-node-event/70",
    swatch: "rounded-l-full rounded-r-[3px] bg-node-event/70",
    shape: EVENT_SHAPE,
  },
  qa: {
    label: "QA",
    hint: "Check the version against the project's QA rules",
    colour: "node-qa",
    tile: "bg-node-qa/15 text-node-qa",
    fill: "fill-node-qa/70",
    swatch: "rounded-[2px] border-t-[3px] border-t-node-qa bg-node-qa/30",
    shape: "rounded-control border-t-[3px] border-t-node-qa",
  },
  review: {
    label: "Review",
    hint: "Ask people to approve, or for their comments",
    colour: "node-review",
    tile: "bg-node-review/15 text-node-review",
    fill: "fill-node-review/70",
    swatch: "rounded-[3px] border-l-[3px] border-l-node-review bg-node-review/30",
    shape: "rounded-panel-lg border-l-[3px] border-l-node-review",
  },
  task: {
    label: "Task",
    hint: "Someone does a piece of work",
    colour: "node-work",
    tile: "bg-node-work/15 text-node-work",
    fill: "fill-node-work/70",
    swatch: "rounded-[2px] bg-node-work/60",
    shape: "rounded-control",
  },
  wait: {
    label: "Wait",
    hint: "Pause, or wait for something to happen",
    colour: "node-wait",
    tile: "bg-node-wait/15 text-node-wait",
    fill: "fill-node-wait/70",
    swatch: "rounded-l-full rounded-r-[3px] bg-node-wait/60",
    shape: slanted,
  },
  status: {
    label: "Status",
    hint: "Change where the item stands, or where it is filed",
    colour: "node-flow",
    tile: "bg-node-flow/15 text-node-flow",
    fill: "fill-node-flow/70",
    swatch: "[clip-path:polygon(4px_0,100%_0,calc(100%-4px)_100%,0_100%)] bg-node-flow/60",
    shape: slanted,
  },
  notify: {
    label: "Notify",
    hint: "Tell people, or send them a link",
    colour: "node-comm",
    tile: "bg-node-comm/15 text-node-comm",
    fill: "fill-node-comm/70",
    swatch: "rounded-full bg-node-comm/60",
    shape: "rounded-full pl-4",
  },
  finish: {
    label: "Finish",
    hint: "End the workflow, with a final status",
    colour: "ink",
    tile: "bg-ink text-ground",
    fill: "fill-ink/70",
    swatch: "rounded-r-full rounded-l-[3px] bg-ink/70",
    shape: "rounded-r-full rounded-l-panel pr-4",
  },
};

/** The families in the order a workflow reads, left to right. */
export const GROUP_ORDER: readonly KindGroup[] = [
  "start",
  "qa",
  "review",
  "task",
  "wait",
  "status",
  "notify",
  "finish",
];

/**
 * Each family's kinds, in the order they are met: every kind in exactly one. A start is a
 * version arriving, a start by hand, a track recorded, a file filed or a review asked for; a
 * wait is a pause or any other event a run waits for.
 */
export const kindsByGroup: Record<KindGroup, readonly NodeType[]> = {
  start: ["upload", "manual", "recorded", "folder", "review"],
  qa: ["checks"],
  review: ["feedback", "approval"],
  task: ["task"],
  wait: [
    "wait",
    "decision",
    "submitted",
    "comment",
    "resolved",
    "task_done",
    "due",
    "opened",
    "download",
    "mention",
  ],
  status: ["status", "move"],
  notify: ["notify", "share"],
  finish: ["finish"],
};

const home = new Map<NodeType, KindGroup>(
  GROUP_ORDER.flatMap((g) => kindsByGroup[g].map((t): [NodeType, KindGroup] => [t, g])),
);

/** The family a kind belongs to, which gives it its colour. */
export const groupOf = (t: NodeType): KindGroup => home.get(t) ?? "wait";

/** A node's shape on the canvas: an event's D, or its family's. */
export const shapeOf = (t: NodeType) =>
  nodeTypes[t].kind === "event" ? EVENT_SHAPE : groups[groupOf(t)].shape;

/**
 * What a node is, in a line beside its name where nodes are offered by name (the inspector's
 * Then list): its kind, and for a status, the status it sets, so a step named "Approve" reads
 * "Set status: Approved" and never as the approval review beside it.
 */
export function kindLine(node: { type: NodeType; config: Record<string, string> }): string {
  const label = nodeTypes[node.type].label;
  const status = node.config.status?.trim();
  if (node.type === "status" && status) return `${label}: ${status}`;
  if (node.type === "finish" && status) return `${label}: ${status}`;
  return label;
}

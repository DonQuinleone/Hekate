/**
 * The workflow model.
 *
 * A workflow is a graph. Its nodes are events (something happens) and actions (something is done).
 * Connectors wire an outcome of one node to the input of another, and may carry a condition of
 * their own; a connector that leads back to an earlier node is a loop and needs a way out.
 * Groups frame nodes as a stage, for reading and for the basic view.
 *
 * What may sit where is a rule of the model, not of the canvas:
 *   an action never starts a workflow (it needs an incoming connector);
 *   an event with nothing before it is a trigger, and a workflow needs one;
 *   an event never ends a workflow (something must follow it);
 *   an action follows an outcome of an event or another action;
 *   a loop needs a stop (a condition or a bound);
 *   a finish has no outcomes, so nothing follows it.
 */

export type EventType =
  | "upload"
  | "folder"
  | "manual"
  | "review"
  | "decision"
  | "submitted"
  | "comment"
  | "resolved"
  | "task_done"
  | "due"
  | "opened"
  | "download"
  | "mention"
  | "recorded";

export type ActionType =
  | "approval"
  | "feedback"
  | "task"
  | "checks"
  | "notify"
  | "status"
  | "wait"
  | "share"
  | "move"
  | "finish";

export type NodeType = EventType | ActionType;

export interface FlowNode {
  id: string;
  kind: "event" | "action";
  type: NodeType;
  name: string;
  /** Canvas position in pixels, the top left corner. */
  x: number;
  y: number;
  config: Record<string, string>;
  groupId?: string;
}

export interface Outcome {
  id: string;
  label: string;
}

export interface Connector {
  id: string;
  from: string;
  /** Which outcome of `from` it leaves. */
  outcome: string;
  to: string;
  /** A condition of the connector's own, on top of the outcome: "if the file is video". */
  condition?: string;
  /** For a loop: the way out, such as "at most 3 times" or "until the due date". */
  until?: string;
}

export interface FlowGroup {
  id: string;
  name: string;
}

export interface Flow {
  id: string;
  projectId: string;
  name: string;
  active: boolean;
  nodes: FlowNode[];
  connectors: Connector[];
  groups: FlowGroup[];
}

export const NODE_W = 208;
export const NODE_H = 60;

/* ---------- What each type is ---------- */

export interface TypeMeta {
  kind: "event" | "action";
  label: string;
  hint: string;
  /** Icon name in the icon set. */
  icon: string;
  outcomes: Outcome[];
  /** Setting fields the inspector shows. */
  fields: { id: string; label: string; options?: string[]; hint?: string }[];
}

const happened: Outcome[] = [{ id: "happened", label: "" }];

export const eventTypes: Record<EventType, TypeMeta> = {
  upload: {
    kind: "event",
    label: "Version uploaded",
    hint: "A new version arrives, past the upload rules",
    icon: "upload",
    outcomes: happened,
    fields: [
      {
        id: "applies",
        label: "Applies to",
        options: ["Every track", "Tracks without a workflow", "One folder"],
      },
    ],
  },
  folder: {
    kind: "event",
    label: "File added to a folder",
    hint: "Any file, or one in a chosen folder",
    icon: "folder",
    outcomes: happened,
    fields: [{ id: "folder", label: "Folder", options: ["Any", "Scores", "Artwork and notes"] }],
  },
  manual: {
    kind: "event",
    label: "Start by hand",
    hint: "Someone starts it from the track or the board",
    icon: "play",
    outcomes: happened,
    fields: [{ id: "who", label: "Who may start it", options: ["Producer", "Any member"] }],
  },
  review: {
    kind: "event",
    label: "Review requested",
    hint: "A review of any kind, or of one kind",
    icon: "inbox",
    outcomes: happened,
    fields: [{ id: "kind", label: "Kind", options: ["Any", "Approval", "Feedback"] }],
  },
  decision: {
    kind: "event",
    label: "Decision recorded",
    hint: "A reviewer approves or asks for changes",
    icon: "gate",
    outcomes: happened,
    fields: [{ id: "which", label: "Which", options: ["Any", "Approved", "Changes requested"] }],
  },
  submitted: {
    kind: "event",
    label: "Feedback submitted",
    hint: "By everyone asked, or by anyone",
    icon: "comment",
    outcomes: happened,
    fields: [{ id: "by", label: "By", options: ["Everyone asked", "Anyone"] }],
  },
  comment: {
    kind: "event",
    label: "Comment posted",
    hint: "Any comment, or one of a category",
    icon: "pin",
    outcomes: happened,
    fields: [{ id: "category", label: "Category", options: ["Any", "Edit", "Noise", "Musical"] }],
  },
  resolved: {
    kind: "event",
    label: "Comments resolved",
    hint: "Every comment on the version",
    icon: "check",
    outcomes: happened,
    fields: [],
  },
  task_done: {
    kind: "event",
    label: "Task done",
    hint: "Any task on the item marked done",
    icon: "task",
    outcomes: happened,
    fields: [],
  },
  due: {
    kind: "event",
    label: "Due date passed",
    hint: "Of the stage, a review or a task",
    icon: "calendar",
    outcomes: happened,
    fields: [{ id: "of", label: "Of", options: ["The stage", "A review", "A task"] }],
  },
  opened: {
    kind: "event",
    label: "Share opened",
    hint: "By anyone it was sent to",
    icon: "eye",
    outcomes: happened,
    fields: [],
  },
  download: {
    kind: "event",
    label: "File downloaded",
    hint: "Of the proxy or the original",
    icon: "download",
    outcomes: happened,
    fields: [{ id: "of", label: "Of", options: ["Anything", "The original"] }],
  },
  mention: {
    kind: "event",
    label: "Someone mentioned",
    hint: "Someone named in a comment",
    icon: "user",
    outcomes: happened,
    fields: [],
  },
  recorded: {
    kind: "event",
    label: "Track recorded",
    hint: "Every slot it has on the schedule ticked off",
    icon: "mic",
    outcomes: happened,
    fields: [],
  },
};

export const actionTypes: Record<ActionType, TypeMeta> = {
  approval: {
    kind: "action",
    label: "Approval review",
    hint: "Ask reviewers to approve or request changes",
    icon: "review",
    outcomes: [
      { id: "approved", label: "all approved" },
      { id: "mixed", label: "some approved" },
      { id: "changes", label: "changes requested" },
    ],
    fields: [
      { id: "who", label: "Who", options: ["Label group", "Producer", "Mira Solberg (guest)"] },
      { id: "order", label: "Order", options: ["All at once", "In turn"] },
      { id: "rule", label: "Approved when", options: ["Everyone approves", "Any one approves"] },
      { id: "status", label: "Sets status" },
      { id: "due", label: "Due in days" },
    ],
  },
  feedback: {
    kind: "action",
    label: "Feedback review",
    hint: "Ask reviewers for comments; no formal decision",
    icon: "comment",
    outcomes: [
      { id: "done", label: "submitted" },
      { id: "overdue", label: "due date passed" },
    ],
    fields: [
      { id: "who", label: "Who", options: ["Mira Solberg (guest)", "Soloists group", "Producer"] },
      { id: "order", label: "Order", options: ["All at once", "In turn"] },
      { id: "status", label: "Sets status" },
      { id: "due", label: "Due in days" },
    ],
  },
  task: {
    kind: "action",
    label: "Assign a task",
    hint: "Someone does the work and marks it done",
    icon: "task",
    outcomes: [
      { id: "done", label: "done" },
      { id: "overdue", label: "due date passed" },
    ],
    fields: [
      { id: "who", label: "Role", options: ["Producer", "Engineer", "Editor"] },
      { id: "status", label: "Sets status" },
      { id: "due", label: "Due in days" },
    ],
  },
  checks: {
    kind: "action",
    label: "QA check",
    hint: "Run the project's QA rules on the version",
    icon: "shield",
    outcomes: [
      { id: "passed", label: "passed" },
      { id: "warnings", label: "warnings" },
      { id: "failed", label: "failed" },
    ],
    fields: [],
  },
  notify: {
    kind: "action",
    label: "Notify",
    hint: "Tell people, then carry on",
    icon: "bell",
    outcomes: [{ id: "sent", label: "" }],
    fields: [
      { id: "to", label: "To", options: ["Producer", "Engineer", "Everyone in the project"] },
      { id: "message", label: "Message" },
    ],
  },
  status: {
    kind: "action",
    label: "Set status",
    hint: "Change the item's status, then carry on",
    icon: "flag",
    outcomes: [{ id: "set", label: "" }],
    fields: [{ id: "status", label: "Status" }],
  },
  wait: {
    kind: "action",
    label: "Wait",
    hint: "Pause for some days before carrying on",
    icon: "clock",
    outcomes: [{ id: "elapsed", label: "" }],
    fields: [{ id: "days", label: "Days" }],
  },
  share: {
    kind: "action",
    label: "Share a link",
    hint: "Send a link to named people; no review",
    icon: "send",
    outcomes: [{ id: "sent", label: "" }],
    fields: [
      { id: "to", label: "To" },
      { id: "expires", label: "Expires in days" },
    ],
  },
  move: {
    kind: "action",
    label: "Move to a folder",
    hint: "File the item away in a folder",
    icon: "folderPlus",
    outcomes: [{ id: "moved", label: "" }],
    fields: [{ id: "folder", label: "Folder", options: ["Masters", "Archive"] }],
  },
  finish: {
    kind: "action",
    label: "Finish",
    hint: "The workflow ends here, with a final status",
    icon: "stop",
    outcomes: [],
    fields: [{ id: "status", label: "Final status" }],
  },
};

export const typeMeta = (type: NodeType): TypeMeta =>
  type in eventTypes ? eventTypes[type as EventType] : actionTypes[type as ActionType];

export const outcomesOf = (node: FlowNode): Outcome[] => typeMeta(node.type).outcomes;

/* ---------- The sample flows ---------- */

const COL = 320;
const ROW = 120;
const at = (col: number, row: number) => ({ x: col * COL, y: row * ROW });

function node(
  id: string,
  type: NodeType,
  name: string,
  col: number,
  row: number,
  config: Record<string, string> = {},
  groupId?: string,
): FlowNode {
  return { id, kind: typeMeta(type).kind, type, name, ...at(col, row), config, groupId };
}

const wire = (
  id: string,
  from: string,
  outcome: string,
  to: string,
  extra: Partial<Connector> = {},
): Connector => ({ id, from, outcome, to, ...extra });

export const flows: Flow[] = [
  {
    id: "wf-joplin",
    projectId: "proj-joplin",
    name: "Album review",
    active: true,
    groups: [
      { id: "g-first", name: "Conductor's round" },
      { id: "g-edit", name: "Editing" },
      { id: "g-second", name: "Second round" },
      { id: "g-sign", name: "Sign-off" },
    ],
    nodes: [
      node("start", "upload", "A version is uploaded", 0, 1, { applies: "Every track" }),
      node(
        "c1",
        "feedback",
        "Conductor, round one",
        1,
        1,
        { who: "Mira Solberg (guest)", status: "With conductor", due: "5", order: "All at once" },
        "g-first",
      ),
      node(
        "triage",
        "task",
        "Producer triages",
        2,
        1,
        { who: "Producer", status: "Triage", due: "2" },
        "g-edit",
      ),
      node(
        "edit",
        "task",
        "Engineer edits",
        3,
        1,
        { who: "Engineer", status: "Editing", due: "7" },
        "g-edit",
      ),
      node(
        "c2",
        "feedback",
        "Conductor, round two",
        4,
        0,
        { who: "Mira Solberg (guest)", status: "With conductor", due: "5", order: "All at once" },
        "g-second",
      ),
      node(
        "sol",
        "feedback",
        "Soloists",
        4,
        2,
        { who: "Soloists group", status: "With conductor", due: "7", order: "In turn" },
        "g-second",
      ),
      node(
        "approve",
        "approval",
        "Label approval",
        5,
        1,
        {
          who: "Label group",
          order: "All at once",
          rule: "Everyone approves",
          status: "Approved",
          due: "7",
        },
        "g-sign",
      ),
      node(
        "noise",
        "task",
        "Noise reduction",
        8,
        0,
        { who: "Engineer", status: "Noise reduction", due: "3" },
        "g-sign",
      ),
      node("done", "finish", "Approved and delivered", 9, 0, { status: "Approved" }, "g-sign"),
      node(
        "ask",
        "notify",
        "Ask the producer",
        6,
        2,
        { to: "Producer", message: "Some approved: decide." },
        "g-sign",
      ),
      node(
        "decide",
        "task",
        "Producer decides",
        7,
        2,
        { who: "Producer", status: "Triage", due: "2" },
        "g-sign",
      ),
      node(
        "tell",
        "notify",
        "Tell the engineer",
        6,
        3,
        { to: "Engineer", message: "Changes requested." },
        "g-sign",
      ),
    ],
    connectors: [
      wire("e1", "start", "happened", "c1"),
      wire("e2", "c1", "done", "triage"),
      wire("e3", "triage", "done", "edit"),
      wire("e4", "edit", "done", "c2"),
      wire("e5", "edit", "done", "sol", { condition: "if the track has soloists" }),
      wire("e6", "c2", "done", "approve"),
      wire("e7", "sol", "done", "approve"),
      wire("e8", "approve", "approved", "noise"),
      wire("e9", "noise", "done", "done"),
      wire("e10", "approve", "mixed", "ask"),
      wire("e11", "ask", "sent", "decide"),
      wire("e12", "decide", "done", "noise"),
      wire("e13", "approve", "changes", "tell"),
      wire("e14", "tell", "sent", "edit", { until: "at most 3 rounds" }),
    ],
  },
  {
    id: "wf-joplin-art",
    projectId: "proj-joplin",
    name: "Artwork sign-off",
    active: true,
    groups: [],
    nodes: [
      node("a-start", "folder", "Artwork arrives", 0, 0, { folder: "Artwork and notes" }),
      node("a-checks", "checks", "Check the file", 1, 0),
      node("a-approve", "approval", "Producer signs off", 2, 0, {
        who: "Producer",
        rule: "Any one approves",
        status: "Approved",
        due: "3",
      }),
      node("a-done", "finish", "Approved", 3, 0, { status: "Approved" }),
      node("a-tell", "notify", "Ask for a new export", 3, 1, {
        to: "Editor",
        message: "The artwork failed its checks.",
      }),
    ],
    connectors: [
      wire("a1", "a-start", "happened", "a-checks"),
      wire("a0", "a-tell", "sent", "a-checks", { until: "until it passes" }),
      wire("a2", "a-checks", "passed", "a-approve"),
      wire("a3", "a-checks", "warnings", "a-approve"),
      wire("a4", "a-checks", "failed", "a-tell"),
      wire("a5", "a-approve", "approved", "a-done"),
      wire("a6", "a-approve", "changes", "a-tell"),
    ],
  },
  {
    id: "wf-titles",
    projectId: "proj-titles",
    name: "Picture lock",
    active: true,
    groups: [{ id: "t-cut", name: "Cutting" }],
    nodes: [
      node("t-start", "upload", "A cut is uploaded", 0, 0, { applies: "Every track" }),
      node(
        "t-dir",
        "feedback",
        "Director notes",
        1,
        0,
        { who: "Mira Solberg (guest)", status: "With director", due: "3" },
        "t-cut",
      ),
      node(
        "t-recut",
        "task",
        "Editor recuts",
        2,
        0,
        { who: "Editor", status: "Cutting", due: "5" },
        "t-cut",
      ),
      node("t-lock", "approval", "Lock", 3, 0, {
        who: "Producer",
        rule: "Any one approves",
        status: "Picture locked",
        due: "2",
      }),
      node("t-done", "finish", "Picture locked", 4, 0, { status: "Picture locked" }),
    ],
    connectors: [
      wire("f1", "t-start", "happened", "t-dir"),
      wire("f2", "t-dir", "done", "t-recut"),
      wire("f3", "t-recut", "done", "t-lock"),
      wire("f4", "t-lock", "approved", "t-done"),
      wire("f5", "t-lock", "changes", "t-recut", { until: "at most 4 cuts" }),
      wire("f6", "t-lock", "mixed", "t-recut", { until: "at most 4 cuts" }),
    ],
  },
];

export const flowsFor = (projectId: string) => flows.filter((f) => f.projectId === projectId);

/* ---------- Reading the graph ---------- */

export const triggersOf = (flow: Flow) =>
  flow.nodes.filter((n) => n.kind === "event" && !flow.connectors.some((c) => c.to === n.id));

/** Nodes in the order the flow reaches them from its triggers, forward connectors only. */
export function flowOrder(flow: Flow): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const visit = (id: string, path: Set<string>) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
    for (const c of flow.connectors.filter((x) => x.from === id)) {
      if (path.has(c.to)) continue;
      visit(c.to, new Set([...path, id]));
    }
  };
  for (const t of triggersOf(flow)) visit(t.id, new Set());
  for (const n of flow.nodes) visit(n.id, new Set());
  return out;
}

/** A connector is a loop when it runs back to the left: the item returns to something it passed. */
export function isLoop(flow: Flow, c: Connector): boolean {
  const from = flow.nodes.find((n) => n.id === c.from);
  const to = flow.nodes.find((n) => n.id === c.to);
  return Boolean(from && to && to.x < from.x);
}

export interface Problem {
  nodeId?: string;
  connectorId?: string;
  level: "error" | "warning";
  text: string;
}

/** The model's rules, applied. */
export function flowProblems(flow: Flow): Problem[] {
  const out: Problem[] = [];
  const incoming = (id: string) => flow.connectors.filter((c) => c.to === id);
  const outgoing = (id: string) => flow.connectors.filter((c) => c.from === id);
  if (triggersOf(flow).length === 0)
    out.push({
      level: "error",
      text: "Nothing starts this workflow: add an event with nothing before it.",
    });
  for (const n of flow.nodes) {
    const meta = typeMeta(n.type);
    if (n.kind === "action" && incoming(n.id).length === 0)
      out.push({
        nodeId: n.id,
        level: "error",
        text: `“${n.name}” is an action with nothing before it. An action never starts a workflow.`,
      });
    if (n.kind === "event" && outgoing(n.id).length === 0)
      out.push({
        nodeId: n.id,
        level: "error",
        text: `Nothing follows “${n.name}”. An event never ends a workflow.`,
      });
    if (n.kind === "action" && meta.outcomes.length > 0 && outgoing(n.id).length === 0)
      out.push({
        nodeId: n.id,
        level: "warning",
        text: `“${n.name}” leads nowhere: the item would stop here without a finish.`,
      });
    if (meta.outcomes.length === 0 && outgoing(n.id).length > 0)
      out.push({
        nodeId: n.id,
        level: "error",
        text: `“${n.name}” is a finish: nothing can follow it.`,
      });
  }
  for (const c of flow.connectors) {
    const from = flow.nodes.find((n) => n.id === c.from);
    if (from && !outcomesOf(from).some((o) => o.id === c.outcome))
      out.push({
        connectorId: c.id,
        level: "error",
        text: `A connector leaves “${from.name}” by an outcome it does not have.`,
      });
    if (isLoop(flow, c) && !c.until)
      out.push({
        connectorId: c.id,
        level: "warning",
        text: `The loop back to “${flow.nodes.find((n) => n.id === c.to)?.name}” has no way out: give it a bound.`,
      });
  }
  return out;
}

/* ---------- As code ---------- */

const q = (s: string) => (/^[\w .,'()-]+$/.test(s) && !/^\d/.test(s) ? s : JSON.stringify(s));

/**
 * The workflow as YAML: what is stored, shared and imported, in the product's format (#145,
 * `packages/shared/src/workflow-files.ts`). Neither the project nor whether it is active travels
 * with it.
 */
export function toYaml(flow: Flow): string {
  const lines: string[] = [];
  lines.push("# A Hekate workflow: https://donquinleone.github.io/Hekate/use/workflow-files/");
  lines.push("hekate: workflow/1");
  lines.push(`name: ${q(flow.name)}`);
  if (flow.groups.length) {
    lines.push("groups:");
    for (const g of flow.groups) lines.push(`  ${g.id}: ${q(g.name)}`);
  }
  lines.push("nodes:");
  for (const n of flow.nodes) {
    lines.push(`  - id: ${n.id}`);
    lines.push(`    ${n.kind}: ${n.type}`);
    lines.push(`    name: ${q(n.name)}`);
    if (n.groupId) lines.push(`    group: ${n.groupId}`);
    const keys = Object.keys(n.config);
    if (keys.length) {
      lines.push("    with:");
      for (const k of keys) lines.push(`      ${k}: ${q(n.config[k] ?? "")}`);
    }
    lines.push(`    at: [${n.x}, ${n.y}]`);
  }
  lines.push("connectors:");
  for (const c of flow.connectors) {
    lines.push(`  - id: ${c.id}`);
    lines.push(`    from: ${c.from}.${c.outcome}`);
    lines.push(`    to: ${c.to}`);
    if (c.condition) lines.push(`    when: ${q(c.condition)}`);
    // A loop's bound is how many times it may be taken.
    if (c.until) lines.push(`    until: ${c.until.match(/\d+/)?.[0] ?? q(c.until)}`);
  }
  return `${lines.join("\n")}\n`;
}

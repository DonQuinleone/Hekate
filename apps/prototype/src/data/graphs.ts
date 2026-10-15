/**
 * Workflows as graphs: nodes on a canvas joined by edges, each edge leaving a named output.
 * A condition node has several outputs; an edge that leads back to an earlier node is a loop.
 */
export type NodeKind =
  | "start"
  | "approval"
  | "feedback"
  | "task"
  | "condition"
  | "notify"
  | "status"
  | "end";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  /** What the node says under its name. */
  detail?: string;
  /** Grid position: columns and rows. */
  col: number;
  row: number;
  outputs: { id: string; label?: string }[];
  config?: Record<string, string>;
}

export interface GraphEdge {
  id: string;
  from: string;
  output: string;
  to: string;
}

export interface Graph {
  workflowId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const one = [{ id: "out" }];

export const graphs: Graph[] = [
  {
    workflowId: "wf-joplin",
    nodes: [
      {
        id: "n-start",
        kind: "start",
        name: "A version is uploaded",
        detail: "or restarted by hand",
        col: 0,
        row: 1,
        outputs: one,
      },
      {
        id: "n-c1",
        kind: "feedback",
        name: "Conductor, round one",
        detail: "Mira Solberg (guest)",
        col: 1,
        row: 1,
        outputs: one,
        config: { status: "With conductor", due: "5", order: "parallel" },
      },
      {
        id: "n-triage",
        kind: "task",
        name: "Producer triages",
        detail: "Producer",
        col: 2,
        row: 1,
        outputs: one,
        config: { status: "Triage", due: "2" },
      },
      {
        id: "n-edit",
        kind: "task",
        name: "Engineer edits",
        detail: "Engineer",
        col: 3,
        row: 1,
        outputs: one,
        config: { status: "Editing", due: "7" },
      },
      {
        id: "n-c2",
        kind: "feedback",
        name: "Conductor, round two",
        detail: "Mira Solberg (guest)",
        col: 4,
        row: 0,
        outputs: one,
        config: { status: "With conductor", due: "5", order: "parallel" },
      },
      {
        id: "n-sol",
        kind: "feedback",
        name: "Soloists",
        detail: "Soloists group, in turn",
        col: 4,
        row: 2,
        outputs: one,
        config: { status: "With conductor", due: "7", order: "sequence" },
      },
      {
        id: "n-approve",
        kind: "approval",
        name: "Label approval",
        detail: "Label group, everyone",
        col: 5,
        row: 1,
        outputs: one,
        config: { status: "Approved", due: "7", rule: "all", order: "parallel" },
      },
      {
        id: "n-cond",
        kind: "condition",
        name: "Decisions",
        detail: "from Label approval",
        col: 6,
        row: 1,
        outputs: [
          { id: "all", label: "all approved" },
          { id: "some", label: "some approved" },
          { id: "none", label: "else" },
        ],
      },
      {
        id: "n-noise",
        kind: "task",
        name: "Noise reduction",
        detail: "Engineer",
        col: 7,
        row: 0,
        outputs: one,
        config: { status: "Noise reduction", due: "3" },
      },
      {
        id: "n-done",
        kind: "status",
        name: "Approved",
        detail: "and delivered",
        col: 8,
        row: 0,
        outputs: [],
      },
      {
        id: "n-ask",
        kind: "notify",
        name: "Ask the producer",
        detail: "in the app and by mail",
        col: 7,
        row: 1,
        outputs: one,
        config: { channel: "app, mail", to: "Producer" },
      },
      {
        id: "n-decide",
        kind: "task",
        name: "Producer decides",
        detail: "Producer",
        col: 8,
        row: 1,
        outputs: one,
        config: { status: "Triage", due: "2" },
      },
      {
        id: "n-tell",
        kind: "notify",
        name: "Tell the engineer",
        detail: "by mail, with the notes",
        col: 7,
        row: 2,
        outputs: one,
        config: { channel: "mail", to: "Engineer" },
      },
    ],
    edges: [
      { id: "e1", from: "n-start", output: "out", to: "n-c1" },
      { id: "e2", from: "n-c1", output: "out", to: "n-triage" },
      { id: "e3", from: "n-triage", output: "out", to: "n-edit" },
      { id: "e4", from: "n-edit", output: "out", to: "n-c2" },
      { id: "e5", from: "n-edit", output: "out", to: "n-sol" },
      { id: "e6", from: "n-c2", output: "out", to: "n-approve" },
      { id: "e7", from: "n-sol", output: "out", to: "n-approve" },
      { id: "e8", from: "n-approve", output: "out", to: "n-cond" },
      { id: "e9", from: "n-cond", output: "all", to: "n-noise" },
      { id: "e10", from: "n-noise", output: "out", to: "n-done" },
      { id: "e11", from: "n-cond", output: "some", to: "n-ask" },
      { id: "e12", from: "n-ask", output: "out", to: "n-decide" },
      { id: "e13", from: "n-decide", output: "out", to: "n-noise" },
      { id: "e14", from: "n-cond", output: "none", to: "n-tell" },
      { id: "e15", from: "n-tell", output: "out", to: "n-edit" },
    ],
  },
  {
    workflowId: "wf-titles",
    nodes: [
      { id: "t-start", kind: "start", name: "A cut is uploaded", col: 0, row: 0, outputs: one },
      {
        id: "t-dir",
        kind: "feedback",
        name: "Director notes",
        detail: "Mira Solberg",
        col: 1,
        row: 0,
        outputs: one,
        config: { status: "With director", due: "3" },
      },
      {
        id: "t-recut",
        kind: "task",
        name: "Editor recuts",
        detail: "Editor",
        col: 2,
        row: 0,
        outputs: one,
        config: { status: "Cutting", due: "5" },
      },
      {
        id: "t-lock",
        kind: "approval",
        name: "Lock",
        detail: "Producer, any one",
        col: 3,
        row: 0,
        outputs: one,
        config: { status: "Picture locked", rule: "any" },
      },
      {
        id: "t-cond",
        kind: "condition",
        name: "Decision",
        col: 4,
        row: 0,
        outputs: [
          { id: "ok", label: "approved" },
          { id: "no", label: "else" },
        ],
      },
      { id: "t-done", kind: "status", name: "Picture locked", col: 5, row: 0, outputs: [] },
    ],
    edges: [
      { id: "f1", from: "t-start", output: "out", to: "t-dir" },
      { id: "f2", from: "t-dir", output: "out", to: "t-recut" },
      { id: "f3", from: "t-recut", output: "out", to: "t-lock" },
      { id: "f4", from: "t-lock", output: "out", to: "t-cond" },
      { id: "f5", from: "t-cond", output: "ok", to: "t-done" },
      { id: "f6", from: "t-cond", output: "no", to: "t-recut" },
    ],
  },
];

export const graphFor = (workflowId: string) => graphs.find((g) => g.workflowId === workflowId);

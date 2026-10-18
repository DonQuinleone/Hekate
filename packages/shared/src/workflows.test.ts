import { describe, expect, it } from "vitest";
import {
  completeNode,
  flowShape,
  simulateWorkflow,
  startRun,
  type WorkflowConnector,
  type WorkflowContext,
  type WorkflowDefinition,
  type WorkflowEffect,
  WorkflowError,
  type WorkflowNode,
  workflowDefinition,
  workflowProblems,
} from "./workflows.ts";

const node = (
  id: string,
  type: WorkflowNode["type"],
  name: string,
  col: number,
  config: Record<string, string> = {},
): WorkflowNode => ({ id, type, name, x: col * 320, y: 0, config });
const wire = (
  id: string,
  from: string,
  outcome: string,
  to: string,
  extra: Partial<WorkflowConnector> = {},
): WorkflowConnector => ({ id, from, outcome, to, ...extra });

// The prototype's album review: the conductor's round, triage and editing, a second round with
// the soloists alongside where the track has them, the label's approval, and noise reduction.
const album: WorkflowDefinition = workflowDefinition.parse({
  nodes: [
    node("start", "upload", "A version is uploaded", 0),
    node("c1", "feedback", "Conductor, round one", 1, { status: "With conductor" }),
    node("triage", "task", "Producer triages", 2, { status: "Triage" }),
    node("edit", "task", "Engineer edits", 3, { status: "Editing" }),
    node("c2", "feedback", "Conductor, round two", 4, { status: "With conductor" }),
    node("sol", "feedback", "Soloists", 4),
    node("approve", "approval", "Label approval", 5, { status: "With the label" }),
    node("noise", "task", "Noise reduction", 8, { status: "Noise reduction" }),
    node("done", "finish", "Approved and delivered", 9, { status: "Approved" }),
    node("ask", "notify", "Ask the producer", 6, { to: "Producer" }),
    node("decide", "task", "Producer decides", 7),
    node("tell", "notify", "Tell the engineer", 6, { to: "Engineer" }),
  ],
  connectors: [
    wire("e1", "start", "happened", "c1"),
    wire("e2", "c1", "done", "triage"),
    wire("e3", "triage", "done", "edit"),
    wire("e4", "edit", "done", "c2"),
    wire("e5", "edit", "done", "sol", { condition: { test: "tag", is: "Soloists" } }),
    wire("e6", "c2", "done", "approve"),
    wire("e7", "sol", "done", "approve"),
    wire("e8", "approve", "approved", "noise"),
    wire("e9", "noise", "done", "done"),
    wire("e10", "approve", "mixed", "ask"),
    wire("e11", "ask", "sent", "decide"),
    wire("e12", "decide", "done", "noise"),
    wire("e13", "approve", "changes", "tell"),
    wire("e14", "tell", "sent", "edit", { until: { times: 3 } }),
  ],
});

const plain: WorkflowContext = { item: { kind: "audio", tags: [] } };
const soloists: WorkflowContext = { item: { kind: "audio", tags: ["soloists"] } };

/** Effects as short strings, to read a run at a glance. */
const read = (effects: WorkflowEffect[]) =>
  effects.map((e) =>
    e.kind === "status"
      ? `status ${e.status}`
      : e.kind === "finish"
        ? `finish ${e.status}`
        : e.kind === "stopped"
          ? "stopped"
          : `${e.kind} ${e.nodeId}`,
  );

describe("a workflow's rules (#25, decision 040)", () => {
  it("finds nothing wrong with the album review, and knows its loop by the graph", () => {
    expect(workflowProblems(album)).toEqual([]);
    const { order, loops } = flowShape(album);
    expect([...loops]).toEqual(["e14"]);
    expect(order.slice(0, 4)).toEqual(["start", "c1", "triage", "edit"]);
  });

  it("names each broken rule", () => {
    const broken: WorkflowDefinition = {
      groups: [],
      nodes: [
        node("a", "upload", "Uploaded", 0),
        node("b", "task", "Edit", 1),
        node("lost", "notify", "Stray notice", 1),
        node("end", "finish", "Done", 2),
        node("after", "status", "After the end", 3),
        node("idle", "comment", "A comment", 2),
      ],
      connectors: [
        wire("1", "a", "happened", "b"),
        wire("2", "b", "approved", "end"),
        wire("3", "b", "done", "end"),
        wire("4", "end", "set", "after"),
        wire("5", "after", "set", "b"),
        wire("6", "b", "done", "gone"),
        wire("7", "lost", "sent", "idle"),
        wire("7", "a", "happened", "end"),
      ],
    };
    const texts = workflowProblems(broken).map((p) => `${p.level}: ${p.text}`);
    expect(texts).toEqual(
      expect.arrayContaining([
        "error: “Stray notice” is an action with nothing before it. An action never starts a workflow.",
        "error: Nothing follows “A comment”. An event never ends a workflow.",
        "error: “Done” is a finish: nothing can follow it.",
        "error: A connector leaves “Edit” by an outcome it does not have.",
        "error: A connector joins a node that is gone.",
        "warning: The loop back to “Edit” has no way out: give it a bound.",
        "error: Two connectors are called 7.",
      ]),
    );
    expect(workflowProblems({ groups: [], nodes: [], connectors: [] })[0]?.text).toBe(
      "Nothing starts this workflow: add an event with nothing before it.",
    );
  });
});

describe("running a workflow (#25)", () => {
  it("takes a track through every stage to its finish", () => {
    const { run, steps } = simulateWorkflow(
      album,
      "start",
      [
        { nodeId: "c1", outcome: "done" },
        { nodeId: "triage", outcome: "done" },
        { nodeId: "edit", outcome: "done" },
        { nodeId: "c2", outcome: "done" },
        { nodeId: "approve", outcome: "approved" },
        { nodeId: "noise", outcome: "done" },
      ],
      plain,
    );
    expect(steps.map(read)).toEqual([
      ["status With conductor", "start c1"],
      ["status Triage", "start triage"],
      ["status Editing", "start edit"],
      // No soloists on this track: the second round is the conductor's alone.
      ["status With conductor", "start c2"],
      ["status With the label", "start approve"],
      ["status Noise reduction", "start noise"],
      ["finish Approved"],
    ]);
    expect(run).toMatchObject({ state: "finished", status: "Approved", active: [] });
  });

  it("waits for every branch still under way before an action they both lead to", () => {
    let { run } = simulateWorkflow(
      album,
      "start",
      [
        { nodeId: "c1", outcome: "done" },
        { nodeId: "triage", outcome: "done" },
      ],
      soloists,
    );
    let effects: WorkflowEffect[];
    ({ run, effects } = completeNode(album, run, "edit", "done", soloists));
    expect(read(effects)).toEqual(["status With conductor", "start c2", "start sol"]);
    // The conductor is done first: the approval waits for the soloists.
    ({ run, effects } = completeNode(album, run, "c2", "done", soloists));
    expect(read(effects)).toEqual([]);
    expect(run).toMatchObject({ active: ["sol"], joining: ["approve"] });
    ({ run, effects } = completeNode(album, run, "sol", "done", soloists));
    expect(read(effects)).toEqual(["status With the label", "start approve"]);
  });

  it("does what is immediate and carries on, and loops back no more than its bound", () => {
    let { run } = simulateWorkflow(
      album,
      "start",
      [
        { nodeId: "c1", outcome: "done" },
        { nodeId: "triage", outcome: "done" },
        { nodeId: "edit", outcome: "done" },
        { nodeId: "c2", outcome: "done" },
      ],
      plain,
    );
    let effects: WorkflowEffect[];
    ({ run, effects } = completeNode(album, run, "approve", "mixed", plain));
    expect(read(effects)).toEqual(["do ask", "start decide"]);
    ({ run } = simulateWorkflow(
      album,
      "start",
      [
        { nodeId: "c1", outcome: "done" },
        { nodeId: "triage", outcome: "done" },
      ],
      plain,
    ));
    // Three rounds of changes go back to the engineer; the fourth has no way left.
    for (let round = 1; round <= 3; round += 1) {
      ({ run } = completeNode(album, run, "edit", "done", plain));
      ({ run } = completeNode(album, run, "c2", "done", plain));
      ({ run, effects } = completeNode(album, run, "approve", "changes", plain));
      expect(read(effects)).toEqual(["do tell", "status Editing", "start edit"]);
    }
    ({ run } = completeNode(album, run, "edit", "done", plain));
    ({ run } = completeNode(album, run, "c2", "done", plain));
    ({ run, effects } = completeNode(album, run, "approve", "changes", plain));
    expect(read(effects)).toEqual(["do tell", "stopped"]);
    expect(run).toMatchObject({ state: "stopped", taken: { e14: 3 } });
  });

  it("listens for an event in the middle of a flow, and a finish cancels what is under way", () => {
    const flow: WorkflowDefinition = {
      groups: [],
      nodes: [
        node("s", "manual", "Started by hand", 0),
        node("fb", "feedback", "Feedback", 1),
        node("late", "due", "Due date passes", 1),
        node("end", "finish", "Done", 2, { status: "Closed" }),
      ],
      connectors: [
        wire("1", "s", "happened", "fb"),
        wire("2", "s", "happened", "late"),
        wire("3", "late", "happened", "end"),
        wire("4", "fb", "done", "end"),
      ],
    };
    let { run, effects } = startRun(flow, "s", plain);
    expect(read(effects)).toEqual(["start fb", "listen late"]);
    ({ run, effects } = completeNode(flow, run, "late", "happened", plain));
    // The finish waits for nothing once a branch reaches it: it ends the run.
    expect(read(effects)).toEqual(["cancel fb", "finish Closed"]);
    expect(run.state).toBe("finished");
  });

  it("waits at a join for a sibling branch, whichever connector comes first", () => {
    const flow: WorkflowDefinition = {
      groups: [],
      nodes: [
        node("s", "manual", "Started by hand", 0),
        node("mix", "task", "Mix", 2),
        node("notes", "task", "Sleeve notes", 1),
        node("tell", "notify", "Tell the label", 1),
        node("end", "finish", "Done", 3),
      ],
      connectors: [
        // Listed before the branch that also leads to the mix.
        wire("1", "s", "happened", "mix"),
        wire("2", "s", "happened", "notes"),
        wire("3", "s", "happened", "tell"),
        wire("4", "notes", "done", "mix"),
        wire("5", "tell", "sent", "mix"),
        wire("6", "mix", "done", "end"),
      ],
    };
    let { run, effects } = startRun(flow, "s", plain);
    // The notice is sent at once and the notes are under way: the mix waits for them.
    expect(read(effects)).toEqual(["start notes", "do tell"]);
    expect(run).toMatchObject({ active: ["notes"], joining: ["mix"] });
    ({ run, effects } = completeNode(flow, run, "notes", "done", plain));
    expect(read(effects)).toEqual(["start mix"]);
  });

  it("will not start a workflow that breaks a rule", () => {
    const flow = {
      ...album,
      connectors: [...album.connectors, wire("x", "c1", "approved", "edit")],
    };
    expect(() => startRun(flow, "start", plain)).toThrow(
      "A connector leaves “Conductor, round one” by an outcome it does not have.",
    );
  });

  it("refuses what the run is not waiting for", () => {
    const { run } = startRun(album, "start", plain);
    expect(() => completeNode(album, run, "edit", "done", plain)).toThrow(WorkflowError);
    expect(() => completeNode(album, run, "c1", "approved", plain)).toThrow(WorkflowError);
    expect(() => startRun(album, "c1", plain)).toThrow(WorkflowError);
  });

  it("tests a connector's condition on the item and on who decided", () => {
    const flow: WorkflowDefinition = {
      groups: [],
      nodes: [
        node("s", "decision", "A decision", 0),
        node("video", "notify", "Video only", 1),
        node("guest", "notify", "A guest decided", 1),
        node("member", "notify", "Not a guest", 1),
        node("end", "finish", "Done", 2),
      ],
      connectors: [
        wire("1", "s", "happened", "video", { condition: { test: "kind", is: "video" } }),
        wire("2", "s", "happened", "guest", { condition: { test: "by", is: "guest" } }),
        wire("3", "s", "happened", "member", { condition: { test: "by", is: "guest", not: true } }),
        wire("4", "video", "sent", "end"),
        wire("5", "guest", "sent", "end"),
        wire("6", "member", "sent", "end"),
      ],
    };
    const { effects } = startRun(flow, "s", { item: { kind: "audio", tags: [] }, by: "guest" });
    expect(read(effects)).toEqual(["do guest", "finish null"]);
  });
});

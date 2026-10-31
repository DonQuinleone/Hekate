import {
  ACTION_TYPES,
  completeNode,
  EVENT_TYPES,
  startRun,
  triggersOf,
  type WorkflowDefinition,
} from "@hekate/shared";
import { describe, expect, it } from "vitest";
import {
  addRefusal,
  basicSteps,
  conditionText,
  connectorPath,
  inPort,
  NODE_H,
  NODE_W,
  newWorkflowDefinition,
  outcomeWords,
  outPort,
  startOf,
  walkLine,
  walkQuestions,
  withConfig,
  withConnector,
  withCopy,
  withLink,
  withNode,
  withoutConnector,
  withoutNode,
  withStartTrigger,
} from "./workflow-nodes";

const at = (id: string, type: WorkflowDefinition["nodes"][number]["type"], name: string) => ({
  id,
  type,
  name,
  x: 0,
  y: 0,
  config: {},
});

// A version arrives; the conductor gives feedback; the engineer edits until it is approved,
// going back to the conductor at most twice.
const album: WorkflowDefinition = {
  groups: [],
  nodes: [
    at("end", "finish", "Approved"),
    at("edit", "task", "Engineer edits"),
    at("start", "upload", "A version is uploaded"),
    at("fb", "feedback", "Conductor"),
    at("ok", "approval", "Label approval"),
  ],
  connectors: [
    { id: "1", from: "start", outcome: "happened", to: "fb" },
    { id: "2", from: "fb", outcome: "done", to: "edit" },
    { id: "3", from: "edit", outcome: "done", to: "ok" },
    { id: "4", from: "ok", outcome: "approved", to: "end" },
    { id: "5", from: "ok", outcome: "changes", to: "fb", until: { times: 2 } },
  ],
};

describe("basicSteps", () => {
  it("lists the steps in the order a run meets them, with the loops that leave each", () => {
    const { triggers, steps, finish } = basicSteps(album);
    expect(triggers.map((t) => t.id)).toEqual(["start"]);
    expect(steps.map((s) => s.node.id)).toEqual(["fb", "edit", "ok"]);
    expect(steps.find((s) => s.node.id === "ok")?.loops.map((c) => c.id)).toEqual(["5"]);
    expect(steps.find((s) => s.node.id === "fb")?.loops).toEqual([]);
    expect(finish?.id).toBe("end");
  });

  it("shows a new workflow as a start and a finish, nothing between", () => {
    const { triggers, steps, finish } = basicSteps(newWorkflowDefinition());
    expect(triggers.map((t) => t.type)).toEqual(["upload"]);
    expect(steps).toEqual([]);
    expect(finish?.type).toBe("finish");
  });
});

describe("changing a workflow", () => {
  it("sets a step's settings, and takes away one emptied", () => {
    const set = withConfig(album, "fb", { who: "Conductor", due: "3" });
    expect(set.nodes.find((n) => n.id === "fb")?.config).toEqual({ who: "Conductor", due: "3" });
    const emptied = withConfig(set, "fb", { due: " " });
    expect(emptied.nodes.find((n) => n.id === "fb")?.config).toEqual({ who: "Conductor" });
    expect(emptied.nodes.find((n) => n.id === "edit")).toBe(album.nodes[1]);
  });

  it("moves a loop, and sets or takes away its limit", () => {
    const moved = withConnector(album, "5", { to: "edit" });
    expect(moved.connectors.find((c) => c.id === "5")).toMatchObject({
      to: "edit",
      until: { times: 2 },
    });
    const unlimited = withConnector(moved, "5", { until: undefined });
    expect(unlimited.connectors.find((c) => c.id === "5")).not.toHaveProperty("until");
    expect(withConnector(album, "5", { until: { times: 4 } }).connectors[4]?.until).toEqual({
      times: 4,
    });
  });
});

describe("the canvas", () => {
  it("adds a node where it is dropped, wired from the first outcome left free", () => {
    const added = withNode(album, "notify", { x: 1234, y: 87 }, "ok", "tell");
    expect(added.nodes.at(-1)).toMatchObject({
      id: "tell",
      type: "notify",
      name: "Notify",
      x: 1230,
      y: 90,
    });
    // Approved and changes are wired already; some approved is the first free.
    expect(added.connectors.at(-1)).toMatchObject({ from: "ok", outcome: "mixed", to: "tell" });
    const loose = withNode(album, "wait", { x: 0, y: 0 }, undefined, "rest");
    expect(loose.connectors).toHaveLength(album.connectors.length);
  });

  it("never leaves a workflow with two starts (#514)", () => {
    // A start kind with nothing before it is refused while the workflow has its start.
    expect(addRefusal(album, "manual")).toMatch(/starts at “A version is uploaded”/);
    expect(withNode(album, "manual", { x: 0, y: 300 })).toBe(album);
    expect(withNode(album, "upload", { x: 0, y: 300 })).toBe(album);
    // An event waited for follows a step, so it needs one to follow.
    expect(addRefusal(album, "comment")).toMatch(/follows a step/);
    expect(withNode(album, "comment", { x: 0, y: 0 }, "ok", "heard").nodes.at(-1)?.id).toBe(
      "heard",
    );
    // A workflow with no start yet takes one, and only one.
    const empty: WorkflowDefinition = { groups: [], nodes: [], connectors: [] };
    const started = withNode(empty, "upload", { x: 0, y: 0 }, undefined, "s");
    expect(triggersOf(started).map((n) => n.id)).toEqual(["s"]);
    expect(triggersOf(withNode(started, "manual", { x: 0, y: 200 }))).toHaveLength(1);
    // Every kind added anywhere leaves at most one start.
    for (const type of [...EVENT_TYPES, ...ACTION_TYPES])
      expect(triggersOf(withNode(album, type, { x: 900, y: 400 })).length).toBeLessThanOrEqual(1);
  });

  it("names what else starts a workflow on its one start, and a new one by its start", () => {
    const both = withStartTrigger(album, "start", "manual", true);
    expect(both.nodes.find((n) => n.id === "start")?.config).toEqual({ triggers: "manual" });
    const three = withStartTrigger(both, "start", "recorded", true);
    expect(three.nodes.find((n) => n.id === "start")?.config.triggers).toBe("manual, recorded");
    expect(withStartTrigger(three, "start", "upload", true)).toEqual(three);
    const back = withStartTrigger(
      withStartTrigger(three, "start", "manual", false),
      "start",
      "recorded",
      false,
    );
    expect(back.nodes.find((n) => n.id === "start")?.config).toEqual({});
    expect(newWorkflowDefinition("manual").nodes[0]).toMatchObject({
      type: "manual",
      name: "Start by hand",
    });
    expect(startOf(newWorkflowDefinition())?.type).toBe("upload");
  });

  it("links an outcome to a node once, and never a node to itself", () => {
    const linked = withLink(album, "fb", "overdue", "ok");
    expect(linked.connectors.at(-1)).toMatchObject({ from: "fb", outcome: "overdue", to: "ok" });
    expect(withLink(linked, "fb", "overdue", "ok")).toBe(linked);
    expect(withLink(album, "fb", "done", "fb")).toBe(album);
  });

  it("takes a node away with its connectors, and copies one beside itself", () => {
    const gone = withoutNode(album, "edit");
    expect(gone.nodes.map((n) => n.id)).not.toContain("edit");
    expect(gone.connectors.map((c) => c.id)).toEqual(["1", "4", "5"]);
    expect(withoutConnector(album, "5").connectors.map((c) => c.id)).toEqual(["1", "2", "3", "4"]);
    const copied = withCopy(album, "fb", "fb2");
    expect(copied.nodes.at(-1)).toMatchObject({
      id: "fb2",
      name: "Conductor (copy)",
      x: 40,
      y: 80,
    });
  });

  it("places ports down a node's right edge, and curves a forward connector", () => {
    const node = { type: "approval" as const, x: 100, y: 200 };
    expect(outPort(node, "approved")).toEqual({ x: 100 + NODE_W, y: 200 + NODE_H / 2 - 22 });
    expect(outPort(node, "changes")).toEqual({ x: 100 + NODE_W, y: 200 + NODE_H / 2 + 22 });
    expect(inPort(node)).toEqual({ x: 100, y: 200 + NODE_H / 2 });
    expect(connectorPath({ x: 0, y: 0 }, { x: 200, y: 0 }, { loop: false, floor: 0 })).toMatch(
      /^M0,0 H28 C/,
    );
    // Backwards, it goes round underneath.
    expect(connectorPath({ x: 200, y: 0 }, { x: 0, y: 0 }, { loop: true, floor: 300 })).toContain(
      "V288",
    );
  });

  it("says a connector's condition and its limit as they read on the canvas", () => {
    expect(conditionText({ id: "x", from: "a", outcome: "done", to: "b" })).toBeNull();
    expect(
      conditionText({
        id: "x",
        from: "a",
        outcome: "done",
        to: "b",
        condition: { test: "kind", is: "video" },
      }),
    ).toBe("if video");
    expect(
      conditionText({
        id: "x",
        from: "a",
        outcome: "done",
        to: "b",
        condition: { test: "tag", is: "Live", not: true },
        until: { times: 3 },
      }),
    ).toBe("unless tagged Live, at most 3×");
  });
});

describe("walking an item through", () => {
  it("names each outcome as the walk offers it", () => {
    expect(outcomeWords("approval", "changes")).toBe("Changes requested");
    expect(outcomeWords("upload", "happened")).toBe("It happens");
    expect(outcomeWords("notify", "sent")).toBe("It is done");
  });

  it("tells what the engine does at each step, in words", () => {
    const flow: WorkflowDefinition = {
      ...album,
      nodes: album.nodes.map((n) =>
        n.id === "end" ? { ...n, config: { status: "Approved" } } : n,
      ),
    };
    const ctx = { item: { kind: "audio" as const, tags: [] } };
    const begun = startRun(flow, "start", ctx);
    expect(begun.effects.flatMap((e) => walkLine(flow, e) ?? [])).toEqual([
      "“Conductor” begins; the item waits on it.",
    ]);
    let run = completeNode(flow, begun.run, "fb", "done", ctx).run;
    run = completeNode(flow, run, "edit", "done", ctx).run;
    const ended = completeNode(flow, run, "ok", "approved", ctx);
    expect(ended.effects.flatMap((e) => walkLine(flow, e) ?? [])).toEqual([
      "It finishes at “Approved”, Approved.",
    ]);
    expect(walkLine(flow, { kind: "stopped" })).toBe("Nothing follows: the item stops here.");
    expect(
      walkLine(flow, { kind: "do", nodeId: "fb", type: "notify", config: { to: "Producer" } }),
    ).toBe("“Conductor”: Producer told.");
  });

  it("asks for the tags and the decider its conditions test, each once", () => {
    const flow: WorkflowDefinition = {
      ...newWorkflowDefinition(),
      connectors: [
        { id: "c1", from: "a", outcome: "x", to: "b", condition: { test: "tag", is: "Urgent" } },
        {
          id: "c2",
          from: "a",
          outcome: "y",
          to: "c",
          condition: { test: "tag", is: "urgent", not: true },
        },
        { id: "c3", from: "b", outcome: "x", to: "c", condition: { test: "kind", is: "video" } },
      ],
    };
    expect(walkQuestions(flow)).toEqual({ tags: ["Urgent"], asksWho: false });
    const withWho: WorkflowDefinition = {
      ...flow,
      connectors: [
        ...flow.connectors,
        { id: "c4", from: "c", outcome: "x", to: "a", condition: { test: "by", is: "guest" } },
      ],
    };
    expect(walkQuestions(withWho).asksWho).toBe(true);
  });
});

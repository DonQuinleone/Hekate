import type { WorkflowDefinition } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import {
  basicSteps,
  familyOf,
  newWorkflowDefinition,
  withConfig,
  withConnector,
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

describe("familyOf", () => {
  it("puts each kind of node in its family", () => {
    expect(familyOf("upload")).toBe("event");
    expect(familyOf("approval")).toBe("review");
    expect(familyOf("checks")).toBe("work");
    expect(familyOf("share")).toBe("comm");
    expect(familyOf("wait")).toBe("flow");
    expect(familyOf("finish")).toBe("finish");
  });
});

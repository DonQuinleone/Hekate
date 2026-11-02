import { describe, expect, it } from "vitest";
import { newWorkflowDefinition } from "./workflow-nodes";
import { problemsOf, stepsOf } from "./workflow-summary";

describe("workflow summary", () => {
  it("counts the steps between the start and the finish, not every node", () => {
    const flow = newWorkflowDefinition();
    expect(flow.nodes.length).toBeGreaterThan(0);
    expect(stepsOf(flow)).toMatch(/^\d+ steps?$/);
    expect(stepsOf({ nodes: [], connectors: [], groups: [] })).toBe("0 steps");
  });

  it("says problems and warnings apart, by level", () => {
    expect(problemsOf([])).toBe("");
    expect(problemsOf([{ level: "error" }])).toBe("1 problem");
    expect(problemsOf([{ level: "warning" }, { level: "warning" }])).toBe("2 warnings");
    expect(problemsOf([{ level: "error" }, { level: "warning" }])).toBe("1 problem, 1 warning");
  });
});

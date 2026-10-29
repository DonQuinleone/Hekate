import type { WorkflowRunSummary } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { movesOf } from "./status-moves";

const run = (
  id: string,
  state: WorkflowRunSummary["state"],
  waiting: WorkflowRunSummary["waiting"],
): WorkflowRunSummary => ({
  id,
  workflowId: "w1",
  workflowName: "Mix review",
  workflowVersion: 1,
  trackId: "t1",
  state,
  status: null,
  waiting,
  steps: [],
  startedBy: null,
  startedAt: "2026-10-14T09:04:00.000Z",
  endedAt: null,
});

describe("movesOf", () => {
  it("offers each outcome of every step a running workflow waits on someone to end", () => {
    const moves = movesOf([
      run("r1", "running", [
        { nodeId: "n1", name: "Producer's approval", type: "approval" },
        { nodeId: "n2", name: "Tidy the edit", type: "task" },
      ]),
    ]);
    expect(moves.map((m) => [m.runId, m.nodeId, m.step, m.outcome, m.label])).toEqual([
      ["r1", "n1", "Producer's approval", "approved", "All approved"],
      ["r1", "n1", "Producer's approval", "mixed", "Some approved"],
      ["r1", "n1", "Producer's approval", "changes", "Changes requested"],
      ["r1", "n2", "Tidy the edit", "done", "Done"],
      ["r1", "n2", "Tidy the edit", "overdue", "Due date passed"],
    ]);
  });

  it("offers nothing for a finished or cancelled run", () => {
    const waiting = [{ nodeId: "n1", name: "Approval", type: "approval" as const }];
    expect(movesOf([run("r1", "finished", waiting), run("r2", "cancelled", waiting)])).toEqual([]);
  });

  it("leaves events and immediate actions alone: Hekate ends those itself", () => {
    expect(
      movesOf([
        run("r1", "running", [
          { nodeId: "n1", name: "A decision is recorded", type: "decision" },
          { nodeId: "n2", name: "Due date", type: "due" },
          { nodeId: "n3", name: "Tell the producer", type: "notify" },
          { nodeId: "n4", name: "Mark mixed", type: "status" },
        ]),
      ]),
    ).toEqual([]);
  });

  it("names an outcome by its id where it has no words of its own", () => {
    expect(
      movesOf([run("r1", "running", [{ nodeId: "n1", name: "Hold", type: "wait" }])]).map(
        (m) => m.label,
      ),
    ).toEqual(["Elapsed"]);
  });
});

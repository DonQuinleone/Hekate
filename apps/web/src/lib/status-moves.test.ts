import type { WorkflowRunSummary } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { moveLabel, movesOf } from "./status-moves";

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
  it("offers each outcome a person decides of every step a running workflow waits on", () => {
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
    ]);
  });

  it("names each move by where it leads, from what the server says (#566)", () => {
    const moves = movesOf([
      run("r1", "running", [
        {
          nodeId: "n2",
          name: "Tidy the edit",
          type: "task",
          choices: [
            { outcome: "done", leadsTo: "Mastering" },
            // Never offered, whatever an older answer says: the clock raises it.
            { outcome: "overdue", leadsTo: "Chase" },
          ],
        },
      ]),
    ]);
    expect(moves.map(moveLabel)).toEqual(["Done, to Mastering"]);
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

  it("never offers what only the clock raises", () => {
    expect(movesOf([run("r1", "running", [{ nodeId: "n1", name: "Hold", type: "wait" }])])).toEqual(
      [],
    );
  });
});

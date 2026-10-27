import type { WorkflowRunSummary } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { runState, transitionsOf } from "./workflow-history";

const run = (over: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary => ({
  id: "run-1",
  workflowId: "wf-1",
  workflowName: "Album review",
  workflowVersion: 2,
  trackId: "track-1",
  state: "running",
  status: "Editing",
  waiting: [{ nodeId: "edit", name: "Engineer edits", type: "task" }],
  steps: [],
  startedBy: "Tomas Varga",
  startedAt: "2026-10-02T10:20:00Z",
  endedAt: null,
  ...over,
});

const step = (over: Partial<WorkflowRunSummary["steps"][number]>) => ({
  nodeId: null,
  name: null,
  type: null,
  outcome: null,
  effects: [],
  byUserId: null,
  byName: null,
  at: "2026-10-02T10:20:00Z",
  ...over,
});

describe("a track's workflow history", () => {
  it("says each move, the status it set and who made it", () => {
    const lines = transitionsOf(
      run({
        steps: [
          step({
            effects: [{ kind: "status", nodeId: "fb", status: "With conductor" }],
            byUserId: "u-1",
            byName: "Tomas Varga",
          }),
          step({
            nodeId: "fb",
            name: "Conductor",
            type: "feedback",
            outcome: "done",
            effects: [{ kind: "status", nodeId: "edit", status: "Editing" }],
            byName: "Mira Solberg",
          }),
          step({ nodeId: "rest", name: "Let it rest", type: "wait", outcome: "elapsed" }),
          step({
            nodeId: "done",
            name: "Approved",
            type: "approval",
            outcome: "changes",
            effects: [{ kind: "finish", nodeId: "end", status: "Approved" }],
          }),
          step({ effects: [{ kind: "stopped" }], byName: "Ines Arlow" }),
        ],
      }),
    );
    expect(lines.map((l) => [l.text, l.status, l.by])).toEqual([
      ["Started", "With conductor", "Tomas Varga"],
      ["Conductor · submitted", "Editing", "Mira Solberg"],
      // A wait's outcome has no words of its own, and nobody ended it.
      ["Let it rest", null, null],
      ["Approved · changes requested", "Approved", "A reviewer"],
      ["Stopped", null, "Ines Arlow"],
    ]);
  });

  it("gives a review's stage ended with no member named to a reviewer, its due date to Hekate", () => {
    const lines = transitionsOf(
      run({
        steps: [
          step({ nodeId: "a", name: "Label approval", type: "approval", outcome: "approved" }),
          step({ nodeId: "f", name: "Conductor", type: "feedback", outcome: "overdue" }),
        ],
      }),
    );
    expect(lines.map((l) => [l.text, l.by])).toEqual([
      ["Label approval · all approved", "A reviewer"],
      ["Conductor · due date passed", null],
    ]);
  });

  it("names a step since removed by its id", () => {
    const [line] = transitionsOf(run({ steps: [step({ nodeId: "gone", outcome: "done" })] }));
    expect(line?.text).toBe("gone");
  });

  it("says where a run under way waits, and how one ended", () => {
    expect(runState(run())).toBe("Under way, at Engineer edits");
    expect(runState(run({ state: "finished", waiting: [] }))).toBe("Finished");
    expect(runState(run({ state: "stopped" }))).toBe("Stopped");
  });
});

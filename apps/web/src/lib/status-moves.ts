import { capital, nodeTypes, type WorkflowRunSummary } from "@hekate/shared";

/** A move the workflow allows from here: a step the run waits on, ended by one of its outcomes. */
export interface StatusMove {
  runId: string;
  nodeId: string;
  step: string;
  outcome: string;
  label: string;
}

/**
 * The moves a track's running workflow allows from where it is: each step it waits on that
 * someone ends (a task done, an approval decided), by each outcome; events it waits for
 * (a decision recorded, a due date passed) are not ended by hand.
 */
export function movesOf(runs: readonly WorkflowRunSummary[]): StatusMove[] {
  return runs
    .filter((run) => run.state === "running")
    .flatMap((run) =>
      run.waiting.flatMap((step) => {
        const info = nodeTypes[step.type];
        if (info.kind !== "action" || info.immediate) return [];
        return info.outcomes.map((o) => ({
          runId: run.id,
          nodeId: step.nodeId,
          step: step.name,
          outcome: o.id,
          label: capital(o.label || o.id),
        }));
      }),
    );
}

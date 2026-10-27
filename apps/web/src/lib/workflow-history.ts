import { outcomesOf, type WorkflowRunSummary } from "@hekate/shared";

/** One move of a track's workflow run, as its history shows it. */
export interface Transition {
  key: string;
  at: string;
  /** What happened: a step and how it ended, or the run starting or stopping. */
  text: string;
  /** The status the move set, if it set one. */
  status: string | null;
  /** Who moved it on; null where Hekate did (a wait elapsed, a due date passed). */
  by: string | null;
  /** Their account, for their avatar's colour. */
  byId: string | null;
}

const runWords: Record<WorkflowRunSummary["state"], string> = {
  running: "Under way",
  finished: "Finished",
  stopped: "Stopped",
  cancelled: "Cancelled",
};

/** How a run stands, in a few words: "Under way, at Conductor", "Finished". */
export function runState(run: WorkflowRunSummary): string {
  const at = run.waiting.map((w) => w.name).join(", ");
  return run.state === "running" && at ? `${runWords.running}, at ${at}` : runWords[run.state];
}

/**
 * A run's transitions in order (#25): each step that ended, by its name and outcome as the
 * workflow builder words it ("Conductor · submitted"), the status it set, and who ended it.
 * A step with no node is the run starting (the first) or being stopped.
 */
export function transitionsOf(run: WorkflowRunSummary): Transition[] {
  return run.steps.map((step, i) => {
    const status =
      step.effects
        .flatMap((e) =>
          e.kind === "status" ? [e.status] : e.kind === "finish" && e.status ? [e.status] : [],
        )
        .at(-1) ?? null;
    let text: string;
    if (step.nodeId === null) {
      text = step.effects.some((e) => e.kind === "stopped")
        ? "Stopped"
        : i === 0
          ? "Started"
          : "Moved on";
    } else {
      const name = step.name ?? step.nodeId;
      const label =
        step.type && step.outcome
          ? outcomesOf(step.type).find((o) => o.id === step.outcome)?.label
          : undefined;
      text = label ? `${name} · ${label}` : name;
    }
    // A review's stage ended by its reviewers' decisions with no member named was a guest's
    // (or someone's since removed): a reviewer, not Hekate. Only its due date passing is Hekate's.
    const reviewed =
      (step.type === "approval" || step.type === "feedback") && step.outcome !== "overdue";
    return {
      key: `${run.id}:${i}`,
      at: step.at,
      text,
      status,
      by: step.byName ?? (reviewed ? "A reviewer" : null),
      byId: step.byUserId,
    };
  });
}

import { capital, choosableOutcome, nodeTypes, type WorkflowRunSummary } from "@hekate/shared";

/** A move the workflow allows from here: a step the run waits on, ended by one of its outcomes. */
export interface StatusMove {
  runId: string;
  nodeId: string;
  step: string;
  outcome: string;
  /** The outcome in words, named by where it leads (#566): "Done, to Mastering". */
  label: string;
  /** The step it leads to, where one follows. */
  leadsTo: string | null;
}

/**
 * The moves a track's running workflow allows from where it is (#566): each step it waits on
 * that someone ends (a task done, an approval decided), by each outcome a person decides, named
 * by where it leads. Events it waits for and outcomes only an event raises (a due date passed,
 * a wait elapsed, what the checks found) are not chosen by hand.
 */
export function movesOf(runs: readonly WorkflowRunSummary[]): StatusMove[] {
  return runs
    .filter((run) => run.state === "running")
    .flatMap((run) =>
      run.waiting.flatMap((step) => {
        const info = nodeTypes[step.type];
        const choices =
          step.choices ??
          info.outcomes
            .filter((o) => choosableOutcome(step.type, o.id))
            .map((o) => ({ outcome: o.id, leadsTo: null }));
        return choices.flatMap((choice) => {
          if (!choosableOutcome(step.type, choice.outcome)) return [];
          const words = info.outcomes.find((o) => o.id === choice.outcome)?.label || choice.outcome;
          return [
            {
              runId: run.id,
              nodeId: step.nodeId,
              step: step.name,
              outcome: choice.outcome,
              label: capital(words),
              leadsTo: choice.leadsTo,
            },
          ];
        });
      }),
    );
}

/** A move as its menu item says it: its outcome, then where it leads. */
export const moveLabel = (move: StatusMove) =>
  move.leadsTo ? `${move.label}, to ${move.leadsTo}` : move.label;

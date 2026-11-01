import type { WorkflowDefinition, WorkflowProblem } from "@hekate/shared";
import { basicSteps } from "./workflow-nodes";

/**
 * "4 steps" (#582): a workflow counted as its basic view lists it, the steps between its start
 * and its finish, in every view and dialog alike.
 */
export function stepsOf(definition: WorkflowDefinition): string {
  const n = basicSteps(definition).steps.length;
  return `${n} ${n === 1 ? "step" : "steps"}`;
}

/** "1 problem", "2 warnings": what a workflow breaks, by level (#582); empty for nothing. */
export function problemsOf(problems: readonly Pick<WorkflowProblem, "level">[]): string {
  const errors = problems.filter((p) => p.level === "error").length;
  const warnings = problems.length - errors;
  return [
    errors > 0 ? `${errors} ${errors === 1 ? "problem" : "problems"}` : null,
    warnings > 0 ? `${warnings} ${warnings === 1 ? "warning" : "warnings"}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

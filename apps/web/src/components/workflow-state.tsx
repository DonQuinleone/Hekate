import { cn } from "~/lib/cn";

/**
 * Whether a workflow runs (#582), told by the status dot's shape and fill as everything else
 * is (brand.md), never by green: an ink dot when it is active, a ring while it is a draft.
 */
export function WorkflowDot({ active }: { active: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-[7px] shrink-0 rounded-full",
        active ? "bg-ink" : "border-[1.5px] border-ink-3",
      )}
    />
  );
}

/** The dot with its word, "Active" or "Draft", as a workflow's state reads in a list. */
export function WorkflowState({ active, className }: { active: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-[7px] text-[13px] text-ink-2", className)}>
      <WorkflowDot active={active} />
      {active ? "Active" : "Draft"}
    </span>
  );
}

import type { Decision, ReviewerState, ReviewStatus, Severity } from "~/data/types";
import { cn } from "~/lib/cn";

/** Status is told apart by dot shape and fill, never by a traffic-light palette. */
export type DotState =
  | "in_review"
  | "changes_requested"
  | "approved"
  | "submitted"
  | "cancelled"
  | "invited"
  | "waiting"
  | "passed";

export function Dot({ state, className }: { state: DotState; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-[8px] shrink-0 rounded-full",
        state === "in_review" && "border-[1.5px] border-ink",
        state === "changes_requested" && "bg-signal",
        state === "approved" && "bg-ink",
        state === "submitted" && "bg-ink-3",
        state === "invited" && "border-[1.5px] border-dashed border-ink-3",
        state === "waiting" && "border-[1.5px] border-dotted border-edge-strong",
        state === "cancelled" && "size-[6px] bg-edge-strong",
        state === "passed" && "size-[4px] bg-ink-3",
        className,
      )}
    />
  );
}

export const reviewerDot = (state: ReviewerState, decision?: Decision): DotState => {
  if (decision === "approved") return "approved";
  if (decision === "changes_requested") return "changes_requested";
  if (state === "submitted") return "submitted";
  if (state === "waiting") return "waiting";
  if (state === "invited") return "invited";
  return "in_review";
};

export const reviewerCopy: Record<ReviewerState, string> = {
  waiting: "Waiting their turn",
  invited: "Invited",
  viewed: "Opened",
  in_progress: "In progress",
  submitted: "Responded",
  observing: "Following along",
};

export function reviewDot(status: ReviewStatus, outcome: Decision | "submitted" | null): DotState {
  if (status === "cancelled") return "cancelled";
  if (outcome === "approved") return "approved";
  if (outcome === "changes_requested") return "changes_requested";
  if (status === "completed") return "submitted";
  return "in_review";
}

export function Pill({
  state,
  children,
  className,
}: {
  state: DotState;
  children: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-[7px] rounded-full border border-hairline px-2.5 text-xs text-ink-2",
        className,
      )}
    >
      <Dot state={state} />
      {children}
    </span>
  );
}

/** Severity by shape and fill: a filled signal dot fails, a ring warns, a small dot informs, a tick passes. */
export function SeverityDot({ severity, className }: { severity: Severity; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-[9px] shrink-0 items-center justify-center rounded-full",
        severity === "fail" && "bg-signal",
        severity === "warn" && "border-[1.5px] border-signal",
        severity === "info" && "border-[1.5px] border-ink-3",
        severity === "pass" && "size-[5px] bg-ink-3",
        className,
      )}
    />
  );
}

export const severityCopy: Record<Severity, string> = {
  fail: "Fails",
  warn: "Issue",
  info: "Advisory",
  pass: "Passed",
};

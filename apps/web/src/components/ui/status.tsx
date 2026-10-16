import { cn } from "~/lib/cn";

export type ReviewState =
  | "in_review"
  | "changes_requested"
  | "approved"
  | "submitted"
  | "cancelled";

const copy: Record<ReviewState, string> = {
  in_review: "In review",
  changes_requested: "Changes requested",
  approved: "Approved",
  submitted: "Feedback in",
  cancelled: "Cancelled",
};

/** Status is told apart by dot shape and fill, never by a traffic-light palette. */
export function StatusDot({ state }: { state: ReviewState }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-[7px] shrink-0 rounded-full",
        state === "in_review" && "border-[1.5px] border-ink-3",
        state === "changes_requested" && "bg-signal",
        state === "approved" && "bg-ink",
        state === "submitted" && "bg-ink-3",
        state === "cancelled" && "border-[1.5px] border-dashed border-edge",
      )}
    />
  );
}

export function StatusPill({ state }: { state: ReviewState }) {
  return (
    <span className="inline-flex h-6 items-center gap-[7px] rounded-full border border-hairline px-2.5 text-xs text-ink-2">
      <StatusDot state={state} />
      {copy[state]}
    </span>
  );
}

/** Where a reviewer has got to, or an item: the same shapes, with the steps before a response. */
export type ReviewerDotState =
  | "approved"
  | "changes_requested"
  | "submitted"
  | "in_review"
  | "invited"
  | "waiting"
  | "passed";

export function ReviewerDot({ state }: { state: ReviewerDotState }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-[7px] shrink-0 rounded-full",
        state === "approved" && "bg-ink",
        state === "changes_requested" && "bg-signal",
        state === "submitted" && "bg-ink-3",
        state === "in_review" && "border-[1.5px] border-ink-3",
        state === "invited" && "border-[1.5px] border-dashed border-ink-3",
        state === "waiting" && "border-[1.5px] border-dotted border-edge",
        state === "passed" && "size-[5px] bg-ink-3",
      )}
    />
  );
}

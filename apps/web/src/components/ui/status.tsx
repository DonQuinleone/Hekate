import { cn } from "~/lib/cn";

export type ReviewState = "in_review" | "changes_requested" | "approved";

const copy: Record<ReviewState, string> = {
  in_review: "In review",
  changes_requested: "Changes requested",
  approved: "Approved",
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

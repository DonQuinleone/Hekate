import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { cn } from "~/lib/cn";
import { dueIn } from "~/lib/home";
import { type ReviewDetail, reviewQuery, useReviewActions } from "~/lib/queries";
import { useViewer } from "~/lib/viewer";
import { Button } from "./ui/button";
import { ReviewerDot } from "./ui/status";

/** What the strip offers a reviewer: their answer, a way to give it, or why they cannot yet. */
export type StripState =
  | { kind: "answered"; decision: "approved" | "changes_requested" | "submitted" }
  | { kind: "decide" }
  | { kind: "submit" }
  | { kind: "observing" }
  | { kind: "waiting" };

/** Where a reviewer stands in an open review, for the strip on the file page (#15). */
export function stripState(review: ReviewDetail): StripState | null {
  const me = review.reviewers.find((r) => r.id === review.you.reviewerId);
  if (!me || review.status !== "open") return null;
  if (me.state === "observing") return { kind: "observing" };
  if (me.state === "waiting") return { kind: "waiting" };
  if (review.kind === "approval" && me.decision) return { kind: "answered", decision: me.decision };
  if (review.kind === "feedback" && me.submittedAt)
    return { kind: "answered", decision: "submitted" };
  if (review.kind === "approval" && review.you.canDecide) return { kind: "decide" };
  if (review.kind === "feedback" && review.you.canSubmit) return { kind: "submit" };
  return null;
}

const answered = {
  approved: "You approved",
  changes_requested: "You requested changes",
  submitted: "Feedback submitted",
} as const;

/**
 * On a file opened from a review: the review, when it is due, and the reviewer's decision
 * where they listen, so they need not go back to the review page to give it.
 */
export function DecisionStrip({ reviewId }: { reviewId: string }) {
  const { guest } = useViewer();
  const { data: review } = useQuery(reviewQuery(reviewId));
  const { decide, submit } = useReviewActions(reviewId);
  const [again, setAgain] = useState(false);
  if (!review) return null;
  const state = stripState(review);
  if (!state) return null;
  const due = review.dueAt ? dueIn(review.dueAt) : null;
  const error = decide.error ?? submit.error;
  const record = (decision: "approved" | "changes_requested") =>
    decide.mutate({ decision }, { onSuccess: () => setAgain(false) });
  const choosing = state.kind === "decide" || (again && review.you.canDecide);
  return (
    <section
      aria-label="Your decision"
      className="flex flex-col gap-2 rounded-panel border border-line bg-raised/30 px-3 py-2.5"
    >
      <div className="flex min-w-0 items-center gap-2 text-[12px] text-ink-3">
        <Link
          to={guest ? "/g/reviews/$reviewId" : "/reviews/$reviewId"}
          params={{ reviewId }}
          className="block min-w-0 truncate py-0.5 leading-5 font-medium text-ink-2 no-underline hover:text-ink"
        >
          {review.title}
        </Link>
        {due && (
          <span className={cn("ml-auto shrink-0", due.days < 0 && "text-signal")}>
            {due.days < 0 || due.days === 0 ? due.label : `Due in ${due.label}`}
          </span>
        )}
      </div>
      {state.kind === "answered" && !choosing ? (
        <p className="m-0 flex items-center gap-2 text-[13px] text-ink">
          <ReviewerDot state={state.decision} />
          {answered[state.decision]}
          {state.decision !== "submitted" && review.you.canDecide && (
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setAgain(true)}>
              Again
            </Button>
          )}
        </p>
      ) : choosing ? (
        <div className="flex flex-wrap gap-1.5">
          <Button
            variant="primary"
            size="sm"
            disabled={decide.isPending}
            onClick={() => record("approved")}
          >
            Approve
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={decide.isPending}
            onClick={() => record("changes_requested")}
          >
            Request changes
          </Button>
          {again && (
            <Button variant="ghost" size="sm" onClick={() => setAgain(false)}>
              Keep my decision
            </Button>
          )}
        </div>
      ) : state.kind === "submit" ? (
        <div className="flex flex-wrap gap-1.5">
          <Button
            variant="primary"
            size="sm"
            disabled={submit.isPending}
            onClick={() => submit.mutate({})}
          >
            Submit feedback
          </Button>
        </div>
      ) : (
        <p className="m-0 text-[12px] text-ink-3">
          {state.kind === "observing"
            ? "You comment; the decision rests with others."
            : "Your turn comes once those before you have responded."}
        </p>
      )}
      {error && <p className="m-0 text-[12px] text-signal">{error.message}</p>}
    </section>
  );
}

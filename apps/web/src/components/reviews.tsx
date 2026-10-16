import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { formatDates } from "~/lib/locale";
import { projectReviewsQuery, type ReviewSummary, useProjectCan } from "~/lib/queries";
import { Button } from "./ui/button";
import { type ReviewState, StatusPill } from "./ui/status";

const dateFormat = formatDates({ day: "numeric", month: "short" });

/** A review's status as the pill shows it. */
export function reviewState(review: Pick<ReviewSummary, "status" | "outcome">): ReviewState {
  if (review.status === "cancelled") return "cancelled";
  if (review.status === "open") return "in_review";
  return review.outcome === "submitted" ? "submitted" : (review.outcome ?? "in_review");
}

/** A project's reviews, newest first, and requesting a new one. */
export function ProjectReviews({ projectId }: { projectId: string }) {
  const { data: reviews, error } = useQuery(projectReviewsQuery(projectId));
  const can = useProjectCan(projectId);
  return (
    <section aria-label="Reviews" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="m-0 text-[15px] font-medium">Reviews</h2>
        {can("request_reviews") && (
          <Button asChild>
            <Link to="/projects/$projectId/reviews/new" params={{ projectId }}>
              Request a review
            </Link>
          </Button>
        )}
      </div>
      {error && <p className="m-0 text-xs text-signal">{error.message}</p>}
      {reviews && reviews.length === 0 && (
        <p className="m-0 text-[13px] text-ink-3">
          No reviews yet. A review asks people to approve, or to give feedback on, tracks and files.
        </p>
      )}
      {reviews && reviews.length > 0 && (
        <ul className="m-0 flex list-none flex-col border-t border-hairline p-0">
          {reviews.map((review) => (
            <li
              key={review.id}
              className="grid min-h-row-min grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-hairline py-row-tight sm:grid-cols-[minmax(0,1fr)_120px_100px_auto]"
            >
              <span className="flex min-w-0 flex-col">
                <Link
                  to="/reviews/$reviewId"
                  params={{ reviewId: review.id }}
                  className="truncate text-sm font-medium text-ink no-underline hover:text-signal"
                >
                  {review.title}
                </Link>
                <span className="text-xs text-ink-3">
                  {review.kind === "approval" ? "Approval" : "Feedback"}
                  {review.youReview && review.status === "open" ? " · you are a reviewer" : ""}
                </span>
              </span>
              <span className="tabular hidden text-xs text-ink-2 sm:block">
                {review.submitted} of {review.reviewers} responded
              </span>
              <span className="tabular hidden text-xs text-ink-3 sm:block">
                {review.dueAt ? `Due ${dateFormat.format(new Date(review.dueAt))}` : ""}
              </span>
              <StatusPill state={reviewState(review)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

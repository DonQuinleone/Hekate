import { reviewKindNames } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { formatDates } from "~/lib/locale";
import { projectReviewsQuery, type ReviewSummary, useProjectCan } from "~/lib/queries";
import { Icon } from "./icons";
import { ShareDialog } from "./share";
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
  const { data: all, error } = useQuery(projectReviewsQuery(projectId));
  const can = useProjectCan(projectId);
  const [sharing, setSharing] = useState(false);
  // Sharing is not reviewing (#138): shares are listed apart, as the prototype lists them.
  const reviews = all?.filter((r) => r.kind !== "share");
  const shares = all?.filter((r) => r.kind === "share") ?? [];
  return (
    <section aria-label="Reviews" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="m-0 flex items-baseline gap-2 text-[15px] font-medium">
          Reviews
          {all && (
            <span className="text-[13px] font-normal text-ink-3">
              {count(reviews?.length ?? 0, "review")}, {count(shares.length, "share", false)}
            </span>
          )}
        </h2>
        {can("request_reviews") && (
          <span className="flex gap-1.5">
            <Button variant="secondary" onClick={() => setSharing(true)}>
              <Icon name="link" size={14} />
              Share
            </Button>
            <Button asChild>
              <Link to="/projects/$projectId/reviews/new" params={{ projectId }}>
                Request a review
              </Link>
            </Button>
          </span>
        )}
      </div>
      {error && <p className="m-0 text-xs text-signal">{error.message}</p>}
      {reviews && reviews.length === 0 && (
        <p className="m-0 text-[13px] text-ink-3">
          No reviews yet. A review asks people to approve, or to give feedback on, tracks and files.
          Sharing, for those who only need to listen, is separate.
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
                  {reviewKindNames[review.kind]}
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
      {shares.length > 0 && (
        <section aria-label="Shared" className="flex flex-col gap-2 pt-2">
          <h3 className="m-0 text-[14px] font-medium">Shared</h3>
          <ul className="m-0 flex list-none flex-col border-t border-hairline p-0">
            {shares.map((share) => (
              <li
                key={share.id}
                className="flex min-h-row-min items-center gap-3 border-b border-hairline py-row-tight"
              >
                <Icon name="link" size={14} className="shrink-0 text-ink-3" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <Link
                    to="/reviews/$reviewId"
                    params={{ reviewId: share.id }}
                    className="truncate text-sm font-medium text-ink no-underline hover:text-signal"
                  >
                    {share.title}
                  </Link>
                  <span className="truncate text-xs text-ink-3">
                    {count(share.items ?? 0, "item")} · {share.opened} of {share.reviewers} opened
                    {share.status === "open" && share.until
                      ? ` · until ${dateFormat.format(new Date(share.until))}`
                      : ""}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-ink-3">
                  {share.status === "open" ? "Shared" : "No longer shared"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {sharing && <ShareDialog projectId={projectId} onClose={() => setSharing(false)} />}
    </section>
  );
}

/** "One item", "3 items"; "one item" further into a sentence. */
const count = (n: number, word: string, first = true) =>
  `${n === 1 ? (first ? "One" : "one") : n} ${word}${n === 1 ? "" : "s"}`;

import { reviewKindNames } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Empty } from "~/components/empty";
import { Card, SectionHead } from "~/components/page";
import { Failed, Loading } from "~/components/ui/states";
import { cn } from "~/lib/cn";
import { dueIn } from "~/lib/home";
import { formatDates } from "~/lib/locale";
import { projectReviewsQuery, type ReviewSummary, useProjectCan } from "~/lib/queries";
import { Icon } from "./icons";
import { Button } from "./ui/button";
import { type ReviewState, reviewStateLabels, StatusDot } from "./ui/status";

const dateFormat = formatDates({ day: "numeric", month: "short" });

/** A review's status as the pill shows it. */
export function reviewState(review: Pick<ReviewSummary, "status" | "outcome">): ReviewState {
  if (review.status === "cancelled") return "cancelled";
  if (review.status === "open") return "in_review";
  return review.outcome === "submitted" ? "submitted" : (review.outcome ?? "in_review");
}

const rowClass =
  "grid items-center gap-3.5 rounded-panel px-2.5 py-2.5 transition-colors hover:bg-raised/60 focus-visible:bg-raised/60";

/** When a review is due, as the overview writes it: late in signal while it is open. */
function Due({ review }: { review: ReviewSummary }) {
  if (!review.dueAt) return <span />;
  const open = review.status === "open";
  const due = dueIn(review.dueAt);
  const late = open && due.days < 0;
  return (
    <span className={cn("tabular truncate text-[13px]", late ? "text-signal" : "text-ink-3")}>
      {late ? due.label : `Due ${dateFormat.format(new Date(review.dueAt))}`}
    </span>
  );
}

/** Where a review stands, in words: how many have answered while open, else how it ended. */
const standing = (review: ReviewSummary) =>
  review.status === "open"
    ? `${review.submitted} of ${review.reviewers} responded`
    : reviewStateLabels[reviewState(review)];

/**
 * A project's reviews, as the prototype lists them: open ones, then finished ones, then what
 * has been shared, each under its own head, newest first; every row opens the review.
 */
export function ProjectReviews({ projectId }: { projectId: string }) {
  const { data: all, error, refetch } = useQuery(projectReviewsQuery(projectId));
  const can = useProjectCan(projectId);
  // Sharing is not reviewing (#138): shares are listed apart, as the prototype lists them, and
  // start from the item shared (#489), not from here.
  const reviews = all?.filter((r) => r.kind !== "share") ?? [];
  const shares = all?.filter((r) => r.kind === "share") ?? [];
  const groups: [string, ReviewSummary[]][] = [
    ["Open", reviews.filter((r) => r.status === "open")],
    ["Finished", reviews.filter((r) => r.status !== "open")],
  ];
  return (
    <section aria-label="Reviews" className="flex flex-col gap-6">
      {/* The page is named in the trail; its toolbar holds its one primary action (#548, #609). */}
      {can("request_reviews") && (
        <div className="flex min-h-8 items-center justify-end gap-3">
          <Button variant="primary" asChild>
            <Link to="/projects/$projectId/reviews/new" params={{ projectId }}>
              <Icon name="plus" size={14} />
              Request a review
            </Link>
          </Button>
        </div>
      )}
      {error ? (
        <Failed what="The reviews" error={error} retry={refetch} size="panel" />
      ) : !all ? (
        <Loading size="panel" />
      ) : reviews.length === 0 && shares.length === 0 ? (
        <Empty
          title="No reviews yet"
          text={
            can("request_reviews")
              ? "Use Request a review to ask people to approve, or give feedback on, tracks and files. Sharing, for those who only need to listen, starts from the file or track itself."
              : "Reviews of this project's tracks and files appear here once someone asks for one."
          }
        />
      ) : (
        <>
          {groups.map(([title, rows]) =>
            rows.length === 0 ? null : (
              <section key={title} aria-label={title} className="flex flex-col gap-3">
                <SectionHead title={title} hint={String(rows.length)} />
                <Card>
                  <ul className="m-0 flex list-none flex-col p-1.5">
                    {rows.map((review) => (
                      <li key={review.id}>
                        <Link
                          to="/reviews/$reviewId"
                          params={{ reviewId: review.id }}
                          className={cn(
                            rowClass,
                            "grid-cols-[auto_minmax(0,1fr)_auto] @3xl/app:grid-cols-[auto_minmax(0,1fr)_140px_170px]",
                          )}
                        >
                          <StatusDot state={reviewState(review)} />
                          <span className="min-w-0">
                            <span className="block truncate text-[14px] font-medium text-ink">
                              {review.title}
                            </span>
                            <span className="block truncate text-[13px] text-ink-3">
                              {reviewKindNames[review.kind]}
                              {review.youReview && review.status === "open"
                                ? " · you are a reviewer"
                                : ""}
                              <span className="@3xl/app:hidden"> · {standing(review)}</span>
                            </span>
                          </span>
                          <span className="hidden min-w-0 @3xl/app:block">
                            <Due review={review} />
                          </span>
                          <span className="hidden truncate text-right text-[13px] text-ink-2 @3xl/app:block">
                            {standing(review)}
                          </span>
                          <span className="text-right @3xl/app:hidden">
                            <Due review={review} />
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Card>
              </section>
            ),
          )}
          {shares.length > 0 && (
            <section aria-label="Shared" className="flex flex-col gap-3">
              <SectionHead title="Shared" hint={String(shares.length)} />
              <Card>
                <ul className="m-0 flex list-none flex-col p-1.5">
                  {shares.map((share) => (
                    <li key={share.id}>
                      <Link
                        to="/reviews/$reviewId"
                        params={{ reviewId: share.id }}
                        className={cn(rowClass, "grid-cols-[auto_minmax(0,1fr)_auto]")}
                      >
                        <Icon name="link" size={14} className="text-ink-3" />
                        <span className="min-w-0">
                          <span className="block truncate text-[14px] font-medium text-ink">
                            {share.title}
                          </span>
                          <span className="block truncate text-[13px] text-ink-3">
                            {count(share.items ?? 0, "item")} · {share.opened} of {share.reviewers}{" "}
                            opened
                            {share.status === "open" && share.until
                              ? ` · until ${dateFormat.format(new Date(share.until))}`
                              : ""}
                          </span>
                        </span>
                        {/* Under Shared, only a share that has ended needs saying so. */}
                        <span className="text-right text-[13px] text-ink-3">
                          {share.status === "open" ? "" : "No longer shared"}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          )}
        </>
      )}
    </section>
  );
}

/** "One item", "3 items"; "one item" further into a sentence. */
const count = (n: number, word: string, first = true) =>
  `${n === 1 ? (first ? "One" : "one") : n} ${word}${n === 1 ? "" : "s"}`;

import { Link } from "@tanstack/react-router";
import { AvatarRow } from "~/components/avatar";
import { Icon } from "~/components/icons";
import { usePageHeader } from "~/components/page-header";
import { Dot, reviewDot } from "~/components/status";
import { Button } from "~/components/ui/button";
import { projectById, type Review } from "~/data";
import { dueIn, formatDate } from "~/lib/format";
import { kindCopy, needsYou, responded, reviewOutcome } from "~/lib/reviews";
import { useViewer } from "~/viewer/context";
import { Empty, StateGate } from "~/viewer/state-gate";

const outcomeCopy = (r: Review) => {
  const o = reviewOutcome(r);
  if (r.status === "cancelled") return "Cancelled";
  if (o === "approved") return "Approved";
  if (o === "changes_requested") return "Changes requested";
  if (o === "submitted") return "Feedback in";
  if (r.kind === "share") return "Shared";
  return "In review";
};

function Row({ review }: { review: Review }) {
  const viewer = useViewer();
  const me = viewer.reviewerIn(review);
  const { days, label } = review.dueAt ? dueIn(review.dueAt) : { days: 99, label: "" };
  return (
    <li className="grid grid-cols-[auto_1fr_auto] items-center gap-3 border-b border-hairline-soft px-4 py-3 last:border-b-0 @3xl/app:grid-cols-[auto_minmax(0,1fr)_140px_120px_110px]">
      <Dot state={reviewDot(review.status, reviewOutcome(review))} />
      <div className="min-w-0">
        <Link
          to="/reviews/$reviewId"
          params={{ reviewId: review.id }}
          className="block truncate text-[13px] font-medium text-ink no-underline hover:text-signal"
        >
          {review.title}
        </Link>
        <div className="truncate text-xs text-ink-3">
          {kindCopy[review.kind]}
          {review.order === "sequence" && ", in turn"} · {projectById(review.projectId)?.name}
          {me && !viewer.can(review.projectId, "request_reviews")
            ? ""
            : ` · ${responded(review)} of ${review.reviewers.length} responded`}
        </div>
      </div>
      <span className="hidden @3xl/app:block">
        <AvatarRow personIds={review.reviewers.map((r) => r.personId)} />
      </span>
      <span
        className={`tabular hidden text-xs @3xl/app:block ${review.status === "open" && days < 0 ? "text-signal" : "text-ink-3"}`}
      >
        {review.dueAt
          ? review.status === "open"
            ? `due ${formatDate(review.dueAt)}`
            : formatDate(review.dueAt)
          : "no due date"}
        {review.status === "open" && review.dueAt && days <= 3 && (
          <span className="block">{label}</span>
        )}
      </span>
      <span className="text-right text-xs text-ink-2">{outcomeCopy(review)}</span>
    </li>
  );
}

export function ReviewsPage() {
  const viewer = useViewer();
  const canRequest = viewer.projects().some((p) => viewer.can(p.id, "request_reviews"));
  usePageHeader({
    title: "Reviews",
    actions: canRequest ? (
      <Button variant="primary" size="sm" asChild>
        <Link to="/reviews/new">
          <Icon name="plus" size={14} />
          Request a review
        </Link>
      </Button>
    ) : undefined,
  });
  const mine = viewer.reviews();
  const waiting = mine.filter((r) => needsYou(r, viewer.reviewerIn(r)));
  const open = mine.filter((r) => r.status === "open" && !waiting.includes(r));
  const finished = mine.filter((r) => r.status !== "open");
  const groups: [string, Review[], string][] = [
    ["Waiting on you", waiting, "Reviews that need your decision or your feedback."],
    ["In progress", open, "Reviews you asked for, or are in, that others are still working on."],
    ["Finished", finished, "Approved, with feedback in, or cancelled."],
  ];
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-6 @3xl/app:px-6">
      <StateGate
        empty={
          <Empty
            title="Nothing to review"
            text={
              canRequest
                ? "Ask people to approve or give feedback on tracks and files. Members, guests and groups, all at once or in turn."
                : "When someone asks you to review something it appears here, and you get an email."
            }
            action={
              canRequest ? (
                <Button variant="primary" asChild>
                  <Link to="/reviews/new">Request a review</Link>
                </Button>
              ) : undefined
            }
          />
        }
      >
        {groups.map(([title, list, hint]) =>
          list.length === 0 && title !== "Waiting on you" ? null : (
            <section key={title} className="flex flex-col gap-2">
              <div className="flex items-baseline gap-2">
                <h2 className="m-0 text-[15px] font-medium">{title}</h2>
                <span className="tabular rounded-full bg-raised px-1.5 text-[11px] leading-[18px] text-ink-2">
                  {list.length}
                </span>
                <span className="hidden text-xs text-ink-3 @3xl/app:inline">{hint}</span>
              </div>
              {list.length === 0 ? (
                <p className="m-0 rounded-panel-lg border border-hairline border-dashed px-4 py-5 text-center text-ink-3">
                  You are all caught up.
                </p>
              ) : (
                <ul className="m-0 list-none rounded-panel-lg border border-hairline bg-surface p-0 shadow-1">
                  {list.map((r) => (
                    <Row key={r.id} review={r} />
                  ))}
                </ul>
              )}
            </section>
          ),
        )}
      </StateGate>
    </div>
  );
}

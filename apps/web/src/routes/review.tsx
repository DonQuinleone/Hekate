import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { reviewState } from "~/components/reviews";
import { Button } from "~/components/ui/button";
import { StatusPill } from "~/components/ui/status";
import { cn } from "~/lib/cn";
import { projectQuery, type ReviewDetail, reviewQuery, useReviewActions } from "~/lib/queries";

const dateTime = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" });

const stateCopy: Record<ReviewDetail["reviewers"][number]["state"], string> = {
  waiting: "Waiting their turn",
  invited: "Invited",
  viewed: "Viewed",
  in_progress: "In progress",
  submitted: "Responded",
};
const decisionCopy = { approved: "Approved", changes_requested: "Changes requested" } as const;

/** The reviewer's part: decide, or submit feedback, when it is their turn. */
function YourTurn({ review }: { review: ReviewDetail }) {
  const { decide, submit } = useReviewActions(review.id);
  const [note, setNote] = useState("");
  const error = decide.error ?? submit.error;
  if (review.you.canDecide) {
    const mine = review.reviewers.find((r) => r.id === review.you.reviewerId);
    return (
      <section
        aria-label="Your decision"
        className="flex flex-col gap-3 rounded-panel border border-edge bg-surface p-4"
      >
        <h2 className="m-0 text-[15px] font-medium">
          {mine?.decision ? "Change your decision" : "Your decision"}
        </h2>
        <p className="m-0 text-[13px] text-ink-3">
          Open each item, leave comments where they help, then record your decision. It is logged; a
          later decision adds to the record rather than replacing it.
        </p>
        <textarea
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="A note with your decision (optional)"
          aria-label="Note"
          className="w-full resize-y rounded-control border border-edge bg-ground px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-ink-3"
        />
        {error && <p className="m-0 text-xs text-signal">{error.message}</p>}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={decide.isPending}
            onClick={() =>
              decide.mutate(
                { decision: "approved", note: note || undefined },
                { onSuccess: () => setNote("") },
              )
            }
          >
            Approve
          </Button>
          <Button
            disabled={decide.isPending}
            onClick={() =>
              decide.mutate(
                { decision: "changes_requested", note: note || undefined },
                { onSuccess: () => setNote("") },
              )
            }
          >
            Request changes
          </Button>
        </div>
      </section>
    );
  }
  if (review.you.canSubmit) {
    return (
      <section
        aria-label="Your feedback"
        className="flex flex-col gap-3 rounded-panel border border-edge bg-surface p-4"
      >
        <h2 className="m-0 text-[15px] font-medium">Your feedback</h2>
        <p className="m-0 text-[13px] text-ink-3">
          Comment on each item as you go. When you have said everything, submit: whoever asked is
          told your feedback is in.
        </p>
        {error && <p className="m-0 text-xs text-signal">{error.message}</p>}
        <div>
          <Button variant="primary" disabled={submit.isPending} onClick={() => submit.mutate()}>
            Submit feedback
          </Button>
        </div>
      </section>
    );
  }
  if (review.you.reviewerId && review.status === "open" && !review.you.active) {
    const mine = review.reviewers.find((r) => r.id === review.you.reviewerId);
    return (
      <p className="m-0 text-[13px] text-ink-3">
        {mine?.state === "waiting"
          ? "This review goes to reviewers in turn; you will be told when it is yours."
          : "You have responded."}
      </p>
    );
  }
  return null;
}

export function ReviewPage({ reviewId }: { reviewId: string }) {
  const { data: review, error } = useQuery(reviewQuery(reviewId));
  const { data: project } = useQuery({
    ...projectQuery(review?.projectId ?? ""),
    enabled: Boolean(review),
  });
  const { viewed, cancel } = useReviewActions(reviewId);
  // A reviewer opening the review has viewed it: once per visit.
  const marked = useRef(false);
  const mine = review?.reviewers.find((r) => r.id === review.you.reviewerId);
  useEffect(() => {
    if (!marked.current && mine?.state === "invited") {
      marked.current = true;
      viewed.mutate();
    }
  }, [mine?.state, viewed]);

  if (error) return <p className="p-8 text-signal">{error.message}</p>;
  if (!review) return <p className="p-8 text-ink-3">Loading</p>;
  const responded = review.reviewers.filter((r) => r.state === "submitted").length;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8 sm:px-8">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-[13px]">
        <Link to="/" className="shrink-0 text-ink-3 no-underline hover:text-ink">
          Projects
        </Link>
        <span className="text-edge">/</span>
        <Link
          to="/projects/$projectId"
          params={{ projectId: review.projectId }}
          className="truncate text-ink-3 no-underline hover:text-ink"
        >
          {project?.name ?? "Project"}
        </Link>
        <span className="text-edge">/</span>
        <span className="truncate font-medium text-ink">{review.title}</span>
      </nav>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <span className="label">
            {review.kind === "approval"
              ? `Approval · ${review.rule === "any" ? "anyone approves" : "everyone approves"}`
              : "Feedback"}
            {review.order === "sequence" ? " · in turn" : ""}
          </span>
          <h1 className="m-0 break-words text-[28px] font-medium tracking-[-0.02em]">
            {review.title}
          </h1>
          <p className="tabular m-0 text-[13px] text-ink-2">
            Requested by {review.createdByName ?? "a former member"} on{" "}
            {day.format(new Date(review.createdAt))}
            {review.dueAt ? ` · due ${day.format(new Date(review.dueAt))}` : ""}
            {` · ${responded} of ${review.reviewers.length} responded`}
          </p>
        </div>
        <StatusPill state={reviewState(review)} />
      </div>
      {review.message && (
        <p className="m-0 max-w-prose whitespace-pre-wrap text-[14px] leading-relaxed text-ink-2">
          {review.message}
        </p>
      )}

      <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-6">
          <section aria-label="Items" className="flex flex-col gap-2">
            <h2 className="m-0 text-[15px] font-medium">Items</h2>
            <ul className="m-0 flex list-none flex-col border-t border-hairline p-0">
              {review.items.map((item) => (
                <li
                  key={item.id}
                  className="flex min-h-12 items-center justify-between gap-3 border-b border-hairline py-2"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm text-ink">{item.name}</span>
                    <span className="text-xs text-ink-3">
                      {item.kind === "track"
                        ? item.version
                          ? `Version ${item.version.number}${item.follows === "latest" ? ", the latest" : ""}`
                          : "No versions yet"
                        : "File"}
                    </span>
                  </span>
                  {item.fileId ? (
                    <Link
                      to="/files/$fileId"
                      params={{ fileId: item.fileId }}
                      className="shrink-0 text-[13px] text-ink-2 no-underline hover:text-signal"
                    >
                      Open
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
          <YourTurn review={review} />
          {review.decisions.length > 0 && (
            <section aria-label="Decisions" className="flex flex-col gap-2">
              <h2 className="m-0 text-[15px] font-medium">Decisions</h2>
              <ol className="m-0 flex list-none flex-col p-0">
                {review.decisions.map((d) => (
                  <li key={d.id} className="flex flex-col gap-0.5 border-b border-hairline py-2.5">
                    <span className="flex items-baseline gap-2 text-[13px]">
                      <span className="font-medium text-ink">{d.reviewerName ?? "A reviewer"}</span>
                      <span
                        className={cn(
                          d.decision === "changes_requested" ? "text-signal" : "text-ink-2",
                        )}
                      >
                        {decisionCopy[d.decision]}
                      </span>
                      <span className="tabular ml-auto text-xs text-ink-3">
                        {dateTime.format(new Date(d.createdAt))}
                      </span>
                    </span>
                    {d.note && <span className="text-[13px] text-ink-2">{d.note}</span>}
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
        <aside className="flex flex-col gap-3">
          <h2 className="m-0 text-[15px] font-medium">Reviewers</h2>
          <ol className="m-0 flex list-none flex-col border-t border-hairline p-0">
            {review.reviewers.map((r, i) => (
              <li
                key={r.id}
                className="flex items-center justify-between gap-3 border-b border-hairline py-2.5"
              >
                <span className="flex min-w-0 items-center gap-2">
                  {review.order === "sequence" && (
                    <span className="tabular font-mono text-[11px] text-ink-3">{i + 1}</span>
                  )}
                  <span className="truncate text-[13px] text-ink">{r.name}</span>
                </span>
                <span className="text-xs text-ink-3">
                  {r.decision ? decisionCopy[r.decision] : stateCopy[r.state]}
                </span>
              </li>
            ))}
          </ol>
          {review.you.canManage && (
            <Button
              variant="ghost"
              size="sm"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              Cancel review
            </Button>
          )}
        </aside>
      </div>
    </div>
  );
}

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { GuestFields } from "~/components/guest-fields";
import { type Crumb, PageHeader } from "~/components/page-header";
import { ReviewerPermissionsEditor } from "~/components/reviewer-permissions";
import { reviewState } from "~/components/reviews";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/input";
import { ActionMenu } from "~/components/ui/menu";
import { StatusPill } from "~/components/ui/status";
import { cn } from "~/lib/cn";
import { formatDates } from "~/lib/locale";
import { permissionSummary } from "~/lib/permissions";
import { projectQuery, type ReviewDetail, reviewQuery, useReviewActions } from "~/lib/queries";
import { useViewer } from "~/lib/viewer";

const dateTime = formatDates({
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const day = formatDates({ day: "numeric", month: "long", year: "numeric" });

const stateCopy: Record<ReviewDetail["reviewers"][number]["state"], string> = {
  waiting: "Waiting their turn",
  invited: "Invited",
  viewed: "Viewed",
  in_progress: "In progress",
  submitted: "Responded",
  observing: "Following along",
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
        <Textarea
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="A note with your decision (optional)"
          aria-label="Note"
          className="text-[13px]"
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

/** The reviewers, in order, and for those who may manage them: what each may do, guests' links and inviting more. */
function Reviewers({ review }: { review: ReviewDetail }) {
  const { addReviewer, sendLink, revoke, permissions } = useReviewActions(review.id);
  const [notice, setNotice] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  /** The reviewer whose permissions are open for editing. */
  const [editing, setEditing] = useState<string | null>(null);
  const manage = review.you.canManageReviewers && review.status === "open";
  const error = addReviewer.error ?? sendLink.error ?? revoke.error;
  // Steps numbered from one: a group's members share theirs.
  const steps = [...new Set(review.reviewers.map((r) => r.step))].sort((a, b) => a - b);
  return (
    <>
      <ol className="m-0 flex list-none flex-col border-t border-hairline p-0">
        {review.reviewers.map((r) => {
          const notes = r.permissions ? permissionSummary(r.permissions, review.kind, r.guest) : [];
          return (
            <li key={r.id} className="group flex flex-col gap-1 border-b border-hairline py-2.5">
              <span className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  {review.order === "sequence" && (
                    <span className="tabular font-mono text-[11px] text-ink-3">
                      {steps.indexOf(r.step) + 1}
                    </span>
                  )}
                  <span className="truncate text-[13px] text-ink">{r.name}</span>
                  {r.guest && (
                    <span className="shrink-0 text-xs text-ink-3">
                      {r.label ? `${r.label}, guest` : "guest"}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <span className="text-xs text-ink-3">
                    {r.decision ? decisionCopy[r.decision] : stateCopy[r.state]}
                  </span>
                  {manage && (
                    <ActionMenu
                      label={r.name}
                      actions={[
                        ...(r.permissions
                          ? [{ label: "Permissions…", onSelect: () => setEditing(r.id) }]
                          : []),
                        ...(r.guest
                          ? [
                              {
                                label: "Send a new link",
                                onSelect: () =>
                                  sendLink.mutate(r.id, {
                                    onSuccess: () =>
                                      setNotice(`A new link is on its way to ${r.name}.`),
                                  }),
                              },
                              {
                                label: "Revoke access",
                                danger: true,
                                onSelect: () =>
                                  revoke.mutate(r.id, {
                                    onSuccess: () =>
                                      setNotice(
                                        `${r.name} is signed out everywhere until sent a new link.`,
                                      ),
                                  }),
                              },
                            ]
                          : []),
                      ]}
                    />
                  )}
                </span>
              </span>
              {(r.group?.name || notes.length > 0) && (
                <span className="text-xs text-ink-3">
                  {[r.group?.name, ...notes].filter(Boolean).join(" · ")}
                </span>
              )}
              {editing === r.id && r.permissions && (
                <ReviewerPermissionsEditor
                  name={r.name}
                  kind={review.kind}
                  guest={r.guest}
                  initial={r.permissions}
                  pending={permissions.isPending}
                  error={permissions.error?.message ?? null}
                  onCancel={() => setEditing(null)}
                  onSave={(change) =>
                    permissions.mutate(
                      { reviewerId: r.id, permissions: change },
                      { onSuccess: () => setEditing(null) },
                    )
                  }
                />
              )}
            </li>
          );
        })}
      </ol>
      {notice && <p className="m-0 text-xs text-ink-2">{notice}</p>}
      {error && <p className="m-0 text-xs text-signal">{error.message}</p>}
      {manage &&
        (inviting ? (
          <GuestFields
            submitLabel="Invite"
            onAdd={(guest) =>
              addReviewer.mutate(guest, {
                onSuccess: () => {
                  setInviting(false);
                  setNotice(`${guest.name} is invited.`);
                },
              })
            }
          />
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setInviting(true)}>
            Invite a guest
          </Button>
        ))}
    </>
  );
}

/** A review on its own page, with the trail and its status in the top bar. */
export function ReviewPage({ reviewId }: { reviewId: string }) {
  return <ReviewBody reviewId={reviewId} />;
}

/**
 * A review's contents. On its own page the title and status go to the top bar; embedded (the
 * inbox's reading pane) they head the pane instead.
 */
export function ReviewBody({
  reviewId,
  embedded = false,
  titled = false,
  markViewed = true,
}: {
  reviewId: string;
  embedded?: boolean;
  /** Embedded, with the title already in the top bar: the pane leaves it out. */
  titled?: boolean;
  /** Record that you have seen it. Off for a review shown only because it came first. */
  markViewed?: boolean;
}) {
  const { data: review, error } = useQuery(reviewQuery(reviewId));
  const { guest } = useViewer();
  const { data: project } = useQuery({
    ...projectQuery(review?.projectId ?? ""),
    enabled: Boolean(review) && !guest,
  });
  const { viewed, cancel } = useReviewActions(reviewId);
  // A reviewer opening the review has viewed it: once per visit.
  const marked = useRef(false);
  const mine = review?.reviewers.find((r) => r.id === review.you.reviewerId);
  useEffect(() => {
    if (markViewed && !marked.current && mine?.state === "invited") {
      marked.current = true;
      viewed.mutate();
    }
  }, [markViewed, mine?.state, viewed]);

  if (error) return <p className="p-8 text-signal">{error.message}</p>;
  if (!review) return <p className="p-8 text-ink-3">Loading</p>;
  const responded = review.reviewers.filter((r) => r.state === "submitted").length;

  const crumbs: Crumb[] = guest
    ? [{ key: "reviews", link: <Link to="/g">Your reviews</Link> }]
    : [
        { key: "projects", link: <Link to="/projects">Projects</Link> },
        {
          key: "project",
          link: (
            <Link to="/projects/$projectId/files" params={{ projectId: review.projectId }}>
              {project?.name ?? "Project"}
            </Link>
          ),
        },
      ];
  return (
    <>
      {embedded ? null : (
        <PageHeader
          crumbs={crumbs}
          title={review.title}
          actions={<StatusPill state={reviewState(review)} />}
        />
      )}
      <div
        className={cn(
          "flex flex-col gap-6",
          embedded ? "px-6 py-5" : "mx-auto max-w-5xl px-4 py-5 sm:px-6",
        )}
      >
        {embedded && (
          <div className="flex items-start gap-3">
            {titled ? (
              <span className="flex-1" />
            ) : (
              <h2 className="title m-0 min-w-0 flex-1">{review.title}</h2>
            )}
            <StatusPill state={reviewState(review)} />
            <Button variant="ghost" size="sm" asChild>
              <Link to="/reviews/$reviewId" params={{ reviewId: review.id }}>
                Open
              </Link>
            </Button>
          </div>
        )}
        <p className="tabular m-0 text-[13px] text-ink-2">
          {review.kind === "approval"
            ? `Approval, ${review.rule === "any" ? "anyone approves" : "everyone approves"}`
            : "Feedback"}
          {review.order === "sequence" ? ", in turn" : ""}
          {` · requested by ${review.createdByName ?? "a former member"} on ${day.format(new Date(review.createdAt))}`}
          {review.dueAt ? ` · due ${day.format(new Date(review.dueAt))}` : ""}
          {` · ${responded} of ${review.reviewers.length} responded`}
        </p>
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
                        to={guest ? "/g/files/$fileId" : "/files/$fileId"}
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
            {/* On a phone what is asked of you comes first, before the items, however many. */}
            <div className="order-first empty:hidden @3xl/app:order-none">
              <YourTurn review={review} />
            </div>
            {review.decisions.length > 0 && (
              <section aria-label="Decisions" className="flex flex-col gap-2">
                <h2 className="m-0 text-[15px] font-medium">Decisions</h2>
                <ol className="m-0 flex list-none flex-col p-0">
                  {review.decisions.map((d) => (
                    <li
                      key={d.id}
                      className="flex flex-col gap-0.5 border-b border-hairline py-2.5"
                    >
                      <span className="flex items-baseline gap-2 text-[13px]">
                        <span className="font-medium text-ink">
                          {d.reviewerName ?? "A reviewer"}
                        </span>
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
            <Reviewers review={review} />
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
    </>
  );
}

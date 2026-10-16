import {
  gateCounts,
  gateState,
  type ReviewerState,
  reviewSteps,
  type StepState,
  withinWindow,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Avatar } from "~/components/avatar";
import { GuestFields } from "~/components/guest-fields";
import { Icon, type IconName } from "~/components/icons";
import { Card, SectionHead } from "~/components/page";
import { type Crumb, PageHeader } from "~/components/page-header";
import { Property } from "~/components/property";
import { ReviewerPermissionsEditor } from "~/components/reviewer-permissions";
import { reviewState } from "~/components/reviews";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input, Textarea } from "~/components/ui/input";
import { ActionMenu } from "~/components/ui/menu";
import { ReviewerDot, type ReviewerDotState, StatusDot } from "~/components/ui/status";
import { cn } from "~/lib/cn";
import { ago } from "~/lib/comments";
import { dueIn } from "~/lib/home";
import { formatDates } from "~/lib/locale";
import { permissionSummary, toLocalInput } from "~/lib/permissions";
import {
  projectQuery,
  type ReviewActivity,
  type ReviewDetail,
  reviewQuery,
  useReviewActions,
} from "~/lib/queries";
import { useViewer } from "~/lib/viewer";

const shortDate = formatDates({ day: "numeric", month: "short" });
const longDate = formatDates({ day: "numeric", month: "long", year: "numeric" });
const time = formatDates({ hour: "2-digit", minute: "2-digit" });

type Reviewer = ReviewDetail["reviewers"][number];

const outcomeCopy = {
  in_review: "In review",
  approved: "Approved",
  changes_requested: "Changes requested",
  submitted: "Feedback in",
  cancelled: "Cancelled",
} as const;

const reviewerCopy: Record<ReviewerState, string> = {
  waiting: "Waiting their turn",
  invited: "Invited",
  viewed: "Opened",
  in_progress: "In progress",
  submitted: "Responded",
  observing: "Following",
};

const ruleCopy = (review: ReviewDetail) =>
  review.kind === "approval"
    ? review.rule === "any"
      ? "anyone approves"
      : review.rule === "share"
        ? `${review.share ?? 100}% approve`
        : "everyone approves"
    : "everyone submits";

function reviewerDot(r: Reviewer): ReviewerDotState {
  if (r.decision) return r.decision;
  if (r.state === "submitted") return "submitted";
  if (r.state === "waiting") return "waiting";
  if (r.state === "invited") return "invited";
  return "in_review";
}

const plural = (n: number, word: string) => `${n === 1 ? "One" : n} ${word}${n === 1 ? "" : "s"}`;

/* ---------- Steps ---------- */

function Node({
  icon,
  title,
  sub,
  state,
  first = false,
}: {
  icon: IconName;
  title: string;
  sub?: string;
  state: StepState;
  first?: boolean;
}) {
  return (
    <li className="flex shrink-0 items-center">
      {!first && (
        <span
          aria-hidden="true"
          className={cn(
            "h-px w-7",
            state === "ahead" ? "border-t border-dashed border-edge-strong" : "bg-ink-3",
          )}
        />
      )}
      <span
        className={cn(
          "flex h-12 items-center gap-2.5 rounded-panel border px-3",
          state === "current" &&
            "border-signal/60 bg-signal/10 shadow-[0_0_0_4px_var(--hk-signal-line)]",
          state === "done" && "border-line bg-raised/40",
          state === "failed" && "border-signal/40 bg-raised/40",
          state === "ahead" && "border-dashed border-line-strong",
        )}
      >
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-full",
            state === "done" && "bg-ink text-ground",
            (state === "current" || state === "failed") && "bg-signal text-ground",
            state === "ahead" && "border border-line-strong text-ink-3",
          )}
        >
          <Icon name={state === "done" ? "check" : state === "failed" ? "close" : icon} size={12} />
        </span>
        <span className="min-w-0">
          <span
            className={cn(
              "block truncate text-[13px] font-medium",
              state === "ahead" ? "text-ink-2" : "text-ink",
            )}
          >
            {title}
          </span>
          {sub && <span className="block truncate text-[11px] text-ink-3">{sub}</span>}
        </span>
      </span>
    </li>
  );
}

/** The review's own small workflow: who is asked in what order, then the gate. */
function Steps({ review }: { review: ReviewDetail }) {
  const steps = reviewSteps(review.order, review.reviewers);
  const label = (rows: Reviewer[]) => {
    const group = rows.find((r) => r.group)?.group?.name;
    return group ? `${group} group` : rows.map((r) => r.name.split(" ")[0]).join(", ");
  };
  return (
    <ol aria-label="Steps" className="m-0 flex list-none flex-wrap items-center gap-y-2 p-0 py-1">
      <Node
        icon="send"
        title="Requested"
        sub={`${(review.createdByName ?? "A former member").split(" ")[0]}, ${shortDate.format(new Date(review.createdAt))}`}
        state="done"
        first
      />
      {steps.map((s, i) => (
        <Node
          key={s.step}
          icon={review.kind === "approval" ? "review" : "comment"}
          title={
            review.order === "sequence"
              ? `Step ${i + 1}: ${label(s.reviewers)}`
              : label(s.reviewers)
          }
          sub={`${s.responded} of ${s.reviewers.length} responded`}
          state={review.status === "cancelled" && s.state === "current" ? "ahead" : s.state}
        />
      ))}
      <Node
        icon="gate"
        title={review.kind === "approval" ? "Gate" : "Feedback in"}
        sub={ruleCopy(review)}
        state={gateState(review.status, review.outcome, steps)}
      />
    </ol>
  );
}

/* ---------- Reviewers ---------- */

function Reviewers({ review, onNotice }: { review: ReviewDetail; onNotice: (n: string) => void }) {
  const { guest } = useViewer();
  const actions = useReviewActions(review.id);
  const { addReviewer, sendLink, revoke, permissions, remind, removeReviewer } = actions;
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const manage = review.you.canManageReviewers && review.status === "open";
  const error =
    addReviewer.error ?? sendLink.error ?? revoke.error ?? remind.error ?? removeReviewer.error;
  const steps = reviewSteps(review.order, review.reviewers);
  const responded = review.reviewers.filter((r) => r.state === "submitted").length;
  const fileBase = guest ? "/g/files/$fileId" : "/files/$fileId";
  return (
    <section className="flex flex-col gap-3">
      <SectionHead
        title="Reviewers"
        hint={`${responded} of ${review.reviewers.length} responded`}
        action={
          manage && (
            <Button variant="ghost" size="sm" onClick={() => setInviting(true)}>
              <Icon name="userPlus" size={14} />
              Invite
            </Button>
          )
        }
      />
      <Card>
        <ul className="m-0 flex list-none flex-col p-0">
          {steps.map((s, i) => (
            <li key={s.step} className="border-b border-line last:border-b-0">
              {review.order === "sequence" && (
                <div className="flex h-8 items-center gap-2 bg-raised/20 px-4 text-[12px] text-ink-3">
                  Step {i + 1}
                  {s.reviewers.find((r) => r.group)?.group?.name && (
                    <span>· {s.reviewers.find((r) => r.group)?.group?.name}</span>
                  )}
                </div>
              )}
              <ul className="m-0 list-none p-0">
                {s.reviewers.map((r) => {
                  const you = r.id === review.you.reviewerId;
                  const when = r.decidedAt ?? r.submittedAt ?? r.viewedAt;
                  const notes = r.permissions
                    ? permissionSummary(r.permissions, review.kind, r.guest)
                    : [];
                  return (
                    <li
                      key={r.id}
                      className="group flex flex-col gap-2 border-b border-line px-4 py-row last:border-b-0"
                    >
                      <div className="flex items-center gap-3">
                        <Avatar id={r.userId ?? r.id} name={r.name} size={30} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 text-[14px]">
                            <span className="truncate font-medium text-ink">{r.name}</span>
                            {you && <span className="text-ink-3">you</span>}
                            {r.guest && !you && (
                              <span className="shrink-0 text-ink-3">
                                · {r.label ? `${r.label}, guest` : "guest"}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 text-[13px] text-ink-3">
                            <ReviewerDot state={reviewerDot(r)} />
                            <span className="truncate">
                              {r.decision === "approved"
                                ? "Approved"
                                : r.decision === "changes_requested"
                                  ? "Changes requested"
                                  : review.status !== "open" && r.state === "waiting"
                                    ? "No response"
                                    : reviewerCopy[r.state]}
                              {when && r.state !== "waiting" ? ` ${ago(when)}` : ""}
                              {r.state === "observing" ? " · comments only" : ""}
                              {r.group && review.order === "parallel" ? ` · ${r.group.name}` : ""}
                              {manage && notes.length > 0 ? ` · ${notes.join(" · ")}` : ""}
                            </span>
                          </div>
                        </div>
                        {r.comments && (
                          <Link
                            to={fileBase}
                            params={{ fileId: r.comments.fileId }}
                            className="flex h-7 shrink-0 items-center gap-1.5 rounded-control px-2 text-[13px] text-ink-2 no-underline hover:bg-raised hover:text-ink"
                          >
                            <Icon name="comment" size={13} />
                            {r.comments.count} {r.comments.count === 1 ? "comment" : "comments"}
                          </Link>
                        )}
                        {manage && (
                          <ActionMenu
                            label={r.name}
                            actions={[
                              ...(r.permissions
                                ? [
                                    {
                                      label: "Override permissions for this review…",
                                      onSelect: () => setEditing(r.id),
                                    },
                                  ]
                                : []),
                              ...(r.state !== "submitted" &&
                              r.state !== "waiting" &&
                              r.state !== "observing"
                                ? [
                                    {
                                      label: "Send a reminder",
                                      onSelect: () =>
                                        remind.mutate(r.id, {
                                          onSuccess: () => onNotice(`${r.name} is reminded.`),
                                        }),
                                    },
                                  ]
                                : []),
                              ...(r.guest
                                ? [
                                    {
                                      label: "Send a new link",
                                      onSelect: () =>
                                        sendLink.mutate(r.id, {
                                          onSuccess: () =>
                                            onNotice(`A new link is on its way to ${r.name}.`),
                                        }),
                                    },
                                    {
                                      label: "Revoke access",
                                      onSelect: () =>
                                        revoke.mutate(r.id, {
                                          onSuccess: () =>
                                            onNotice(
                                              `${r.name} is signed out everywhere until sent a new link.`,
                                            ),
                                        }),
                                    },
                                  ]
                                : []),
                              ...(r.state !== "submitted" && review.reviewers.length > 1
                                ? [
                                    "divider" as const,
                                    {
                                      label: "Remove from the review",
                                      danger: true,
                                      onSelect: () => removeReviewer.mutate(r.id),
                                    },
                                  ]
                                : []),
                            ]}
                          />
                        )}
                      </div>
                      {r.note && (
                        <blockquote className="m-0 ml-[42px] border-l-2 border-line-strong pl-3 text-[14px] leading-[21px] text-ink-2">
                          {r.note}
                        </blockquote>
                      )}
                      {editing === r.id && r.permissions && (
                        <ReviewerPermissionsEditor
                          name={r.name}
                          kind={review.kind}
                          guest={r.guest}
                          initial={r.permissions}
                          items={review.items.map((i) => ({ id: i.id, name: i.name }))}
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
              </ul>
            </li>
          ))}
        </ul>
      </Card>
      {error && <p className="m-0 text-[13px] text-signal">{error.message}</p>}
      {inviting && (
        <div className="rise-in flex flex-col gap-2 rounded-panel border border-line bg-raised/40 p-3">
          <span className="label">Invite to this review</span>
          <GuestFields
            submitLabel="Send"
            onAdd={(g) =>
              addReviewer.mutate(g, {
                onSuccess: () => {
                  setInviting(false);
                  onNotice(`${g.name} is invited.`);
                },
              })
            }
          />
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => setInviting(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

/* ---------- Items and the gate ---------- */

function Items({ review }: { review: ReviewDetail }) {
  const { guest } = useViewer();
  const fileBase = guest ? "/g/files/$fileId" : "/files/$fileId";
  const counts = gateCounts(review.kind, review.reviewers);
  const passed = review.outcome === "approved" || review.outcome === "submitted";
  const failed = review.outcome === "changes_requested";
  const me = review.you.reviewerId;
  return (
    <section className="flex flex-col gap-3">
      <SectionHead title="Under review" hint={plural(review.items.length, "item")} />
      <Card>
        <div
          className={cn(
            "flex flex-wrap items-center gap-3 border-b border-line px-4 py-3",
            passed ? "bg-raised/20" : failed ? "bg-signal/5" : "",
          )}
        >
          <span
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-full",
              passed
                ? "bg-ink text-ground"
                : failed
                  ? "bg-signal text-ground"
                  : "border border-line-strong text-ink-3",
            )}
          >
            <Icon name={passed ? "check" : failed ? "close" : "gate"} size={13} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] text-ink">
              {passed
                ? "Gate passed: the review is complete"
                : failed
                  ? "Gate not passed: changes requested"
                  : review.status === "cancelled"
                    ? "Gate: closed with the review"
                    : "Gate: not yet"}
            </span>
            <span className="block text-[13px] text-ink-3">
              {review.kind === "approval"
                ? `${ruleCopy(review).replace(/^./, (c) => c.toUpperCase())} · ${counts.approved} approved, ${counts.changes} asked for changes, ${counts.toCome} to come`
                : `${counts.submitted} of ${counts.total} submitted`}
            </span>
          </span>
        </div>
        <ul className="m-0 flex list-none flex-col p-0">
          {review.items.map((item) => {
            const opened = review.you.opened.includes(item.id);
            const detail =
              item.kind === "track"
                ? item.version
                  ? `V${item.version.number}${item.follows === "latest" ? ", the latest" : ""}${item.version.variations.length > 0 ? ` · ${item.version.variations.join(", ")}` : ""}`
                  : "No versions yet"
                : "File";
            const name = (
              <>
                <span className="block truncate text-[14px] font-medium text-ink">{item.name}</span>
                <span className="block truncate text-[13px] text-ink-3">
                  {detail}
                  {item.openComments ? ` · ${plural(item.openComments, "open comment")}` : ""}
                </span>
              </>
            );
            return (
              <li
                key={item.id}
                className="group flex min-h-row-min items-center gap-3.5 border-b border-line px-4 py-row-snug last:border-b-0 hover:bg-raised/40"
              >
                {item.fileId ? (
                  <Link
                    to={fileBase}
                    params={{ fileId: item.fileId }}
                    className="min-w-0 flex-1 no-underline"
                  >
                    {name}
                  </Link>
                ) : (
                  <span className="min-w-0 flex-1">{name}</span>
                )}
                {me && (
                  <span className="hidden shrink-0 items-center gap-2 text-[13px] text-ink-3 @3xl/app:flex">
                    <ReviewerDot state={opened ? "passed" : "invited"} />
                    {opened ? "Opened" : "Not opened"}
                  </span>
                )}
                {item.fileId && (
                  <Link
                    to={fileBase}
                    params={{ fileId: item.fileId }}
                    aria-label={`Open ${item.name}`}
                    className="flex size-7 shrink-0 items-center justify-center rounded-control text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-raised hover:text-ink focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                  >
                    <Icon name="play" size={11} fill="currentColor" strokeWidth={0} />
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
    </section>
  );
}

/* ---------- Your turn ---------- */

function YourTurn({ review }: { review: ReviewDetail }) {
  const { decide, submit } = useReviewActions(review.id);
  const [note, setNote] = useState("");
  const [again, setAgain] = useState(false);
  const me = review.reviewers.find((r) => r.id === review.you.reviewerId);
  if (!me || review.status !== "open") return null;
  const unopened = review.items.length - review.you.opened.length;
  const error = decide.error ?? submit.error;
  const quiet = (text: ReactNode) => (
    <p className="m-0 flex items-start gap-2.5 text-[14px] text-ink-2">
      <Icon name="clock" className="mt-0.5 shrink-0 text-ink-3" />
      <span>{text}</span>
    </p>
  );
  const unopenedCopy =
    unopened > 0 ? (
      <span className="text-[13px] text-ink-3">
        {unopened === 1 ? "One item not opened yet" : `${unopened} items not opened yet`}
      </span>
    ) : null;
  if (me.state === "waiting") {
    const before = review.reviewers.filter((r) => r.step < me.step && r.state !== "submitted");
    return quiet(
      <>
        Your turn comes after {before.map((r) => r.name).join(" and ")}{" "}
        {before.length === 1 ? "has" : "have"} responded. You will get an email.
      </>,
    );
  }
  if (review.you.permissions && !withinWindow(review.you.permissions, new Date())) {
    const ended = review.you.permissions.expiresAt;
    return quiet(
      ended
        ? `Your access ended on ${longDate.format(new Date(ended))}. Whoever asked can open it again.`
        : "Your access to this review has not opened yet.",
    );
  }
  if (me.state === "observing")
    return quiet("You were asked to look and comment; the decision rests with the others.");
  const card =
    "rounded-panel-lg border border-signal/30 bg-signal/[0.06] p-4 shadow-1 @3xl/app:p-5";
  if (review.kind === "feedback") {
    if (me.submittedAt)
      return (
        <p className="m-0 flex items-center gap-2.5 text-[14px] text-ink">
          <ReviewerDot state="submitted" />
          Feedback submitted {ago(me.submittedAt)}. You can still comment until the review closes.
        </p>
      );
    if (!review.you.canSubmit) return null;
    return (
      <section aria-label="Your feedback" className={card}>
        <Field label="Your feedback">
          <Textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Anything about the review as a whole (optional)"
          />
        </Field>
        {error && <p className="mt-2 mb-0 text-[13px] text-signal">{error.message}</p>}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            size="lg"
            disabled={submit.isPending}
            onClick={() => submit.mutate({ note: note || undefined })}
          >
            Submit feedback
          </Button>
          {unopenedCopy}
        </div>
      </section>
    );
  }
  if (me.decision && !again)
    return (
      <div className="flex flex-col gap-1.5">
        <p className="m-0 flex flex-wrap items-center gap-2.5 text-[14px] text-ink">
          <ReviewerDot state={me.decision} />
          You {me.decision === "approved" ? "approved" : "requested changes"}{" "}
          {me.decidedAt ? ago(me.decidedAt) : ""}.
          {review.you.canDecide && (
            <Button variant="ghost" size="sm" onClick={() => setAgain(true)}>
              Decide again
            </Button>
          )}
        </p>
        {me.note && <p className="m-0 pl-5 text-[14px] text-ink-2">“{me.note}”</p>}
      </div>
    );
  if (!review.you.canDecide) return null;
  const record = (decision: "approved" | "changes_requested") =>
    decide.mutate(
      { decision, note: note || undefined },
      {
        onSuccess: () => {
          setNote("");
          setAgain(false);
        },
      },
    );
  return (
    <section aria-label="Your decision" className={card}>
      <Field label="Your decision">
        <Textarea
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="A note with your decision (optional)"
        />
      </Field>
      {error && <p className="mt-2 mb-0 text-[13px] text-signal">{error.message}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="lg"
          disabled={decide.isPending}
          onClick={() => record("approved")}
        >
          Approve
        </Button>
        <Button
          variant="secondary"
          size="lg"
          disabled={decide.isPending}
          onClick={() => record("changes_requested")}
        >
          Request changes
        </Button>
        {again && (
          <Button variant="ghost" size="lg" onClick={() => setAgain(false)}>
            Keep my decision
          </Button>
        )}
        {unopenedCopy}
      </div>
    </section>
  );
}

/* ---------- Activity ---------- */

function activityText(a: ReviewActivity): string {
  switch (a.action) {
    case "review.create":
      return "asked for the review";
    case "review.decision":
      return a.decision === "approved" ? "approved" : "requested changes";
    case "review.submit":
      return "submitted feedback";
    case "review.cancel":
      return "cancelled the review";
    case "review.remind":
      return a.subject ? `reminded ${a.subject}` : "reminded everyone waiting";
    case "review.due":
      return a.dueAt
        ? `moved the due date to ${longDate.format(new Date(a.dueAt))}`
        : "took the due date away";
    case "review.reviewer_add":
      return `added ${a.subject ?? "a reviewer"}`;
    case "review.reviewer_remove":
      return `removed ${a.subject ?? "a reviewer"}`;
    case "guest.link":
      return "was sent a link";
    case "guest.view":
      return "opened the review";
    case "guest.revoke":
      return `revoked ${a.subject ?? "a guest"}'s access`;
  }
}

function Activity({ review }: { review: ReviewDetail }) {
  if (review.activity.length === 0) return null;
  return (
    <section className="flex flex-col gap-3">
      <SectionHead title="Activity" />
      <ul className="m-0 flex list-none flex-col p-0">
        {review.activity.map((a) => (
          <li key={a.id} className="flex gap-3 py-row-tight">
            <Avatar id={a.name} name={a.name} size={22} className="mt-px" />
            <div className="min-w-0 flex-1">
              <p className="m-0 text-[14px] text-ink-2">
                <span className="text-ink">{a.name}</span>{" "}
                <span className={cn(a.decision === "changes_requested" && "text-signal")}>
                  {activityText(a)}
                </span>
                <span className="tabular ml-2 text-[13px] text-ink-3">
                  {shortDate.format(new Date(a.at))}, {time.format(new Date(a.at))}
                </span>
              </p>
              {a.note && <p className="mt-1 mb-0 text-[14px] text-ink-2">“{a.note}”</p>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ---------- Managing ---------- */

/** Moving the due date, or taking it away. */
function DueDialog({ review, onClose }: { review: ReviewDetail; onClose: () => void }) {
  const { due } = useReviewActions(review.id);
  const [value, setValue] = useState(toLocalInput(review.dueAt).slice(0, 10));
  // A date means the end of that working day here: 17:00 local time, as when requested.
  const save = (date: string | null) =>
    due.mutate(date ? new Date(`${date}T17:00:00`).toISOString() : null, { onSuccess: onClose });
  return (
    <Dialog
      title="Change the due date"
      description="Reviewers the review still waits on are reminded the day before."
      onClose={onClose}
      width="sm"
      footer={
        <>
          {review.dueAt && (
            <Button variant="ghost" disabled={due.isPending} onClick={() => save(null)}>
              No due date
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!value || due.isPending} onClick={() => save(value)}>
            Save
          </Button>
        </>
      }
    >
      <Field label="Due" error={due.error?.message}>
        <Input type="date" value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
    </Dialog>
  );
}

/* ---------- The page ---------- */

/** A review on its own page, with the trail in the top bar. */
export function ReviewPage({ reviewId }: { reviewId: string }) {
  return <ReviewBody reviewId={reviewId} />;
}

/**
 * A review in the order it is read: where it stands and what is asked of you, its steps, who
 * is reviewing and what they said, the items with the gate, then the activity. On its own
 * page the title goes to the top bar; embedded (the inbox's reading pane) it heads the pane.
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
  const { viewed, cancel, remind } = useReviewActions(reviewId);
  const navigate = useNavigate();
  const [notice, setNotice] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [dating, setDating] = useState(false);
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
  const state = reviewState(review);
  const due = review.dueAt ? dueIn(review.dueAt) : null;
  const overdue = review.status === "open" && due !== null && due.days < 0;
  const manage = review.you.canManage && review.status === "open";
  const kind = review.kind === "approval" ? "Approval" : "Feedback";

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
  const copyLink = () => {
    void navigator.clipboard
      ?.writeText(`${window.location.origin}/reviews/${review.id}`)
      .then(() => setNotice("The link is copied. Only people with access can open it."));
  };

  return (
    <>
      {embedded ? null : <PageHeader crumbs={crumbs} title={review.title} />}
      <div
        className={cn(
          "grid w-full gap-10",
          embedded
            ? "px-6 py-5 @4xl/app:grid-cols-[minmax(0,1fr)_232px]"
            : "mx-auto max-w-[1360px] px-5 py-6 @3xl/app:px-10 @3xl/app:py-8 @5xl/app:grid-cols-[minmax(0,1fr)_248px]",
        )}
      >
        <div className="flex min-w-0 flex-col gap-8">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-3">
              <span className="flex items-center gap-2 text-ink-2">
                <StatusDot state={state} />
                {outcomeCopy[state]}
              </span>
              <span>
                {kind}, {ruleCopy(review)}
                {review.order === "sequence" && ", in turn"}
              </span>
              {review.dueAt && due && (
                <span className={cn("tabular", overdue && "text-signal")}>
                  Due {shortDate.format(new Date(review.dueAt))}
                  {review.status === "open" && ` · ${due.label}`}
                </span>
              )}
              {!guest && (
                <span className="-my-1 ml-auto">
                  <ActionMenu
                    always
                    label="review"
                    actions={[
                      ...(manage && review.you.canManageReviewers
                        ? [
                            {
                              label: "Remind everyone waiting",
                              onSelect: () =>
                                remind.mutate(undefined, {
                                  onSuccess: (n) =>
                                    setNotice(
                                      n === 1
                                        ? "One reviewer is reminded."
                                        : `${n} reviewers are reminded.`,
                                    ),
                                }),
                            },
                          ]
                        : []),
                      ...(manage
                        ? [{ label: "Change the due date…", onSelect: () => setDating(true) }]
                        : []),
                      ...(embedded
                        ? [
                            {
                              label: "Open on its own page",
                              onSelect: () =>
                                void navigate({
                                  to: "/reviews/$reviewId",
                                  params: { reviewId: review.id },
                                }),
                            },
                          ]
                        : []),
                      { label: "Copy link", onSelect: copyLink },
                      ...(manage
                        ? [
                            "divider" as const,
                            {
                              label: "Cancel the review…",
                              danger: true,
                              onSelect: () => setCancelling(true),
                            },
                          ]
                        : []),
                    ]}
                  />
                </span>
              )}
            </div>
            {embedded && !titled && <h2 className="title m-0">{review.title}</h2>}
            <p className="m-0 flex items-center gap-2 text-[13px] text-ink-3">
              <Avatar
                id={review.createdByName ?? "former"}
                name={review.createdByName ?? "A former member"}
                size={18}
              />
              {review.createdByName ?? "A former member"},{" "}
              {longDate.format(new Date(review.createdAt))}
            </p>
            {review.message && (
              <p className="m-0 max-w-[640px] whitespace-pre-wrap text-[15px] leading-[24px] text-ink-2">
                {review.message}
              </p>
            )}
            {review.status === "cancelled" && (
              <p className="m-0 flex items-center gap-2 text-[14px] text-ink-2">
                <StatusDot state="cancelled" />
                Cancelled
                {review.cancelledByName ? ` by ${review.cancelledByName}` : ""}
                {review.completedAt ? ` on ${shortDate.format(new Date(review.completedAt))}` : ""}
                {review.cancelReason ? `: ${review.cancelReason}` : "."}
              </p>
            )}
            {notice && (
              <p role="status" className="m-0 text-[13px] text-ink-2">
                {notice}
              </p>
            )}
            {cancelling && (
              <div className="rise-in flex flex-col gap-3 rounded-panel border border-signal/40 bg-signal/10 px-4 py-3 text-[14px] text-ink">
                <span>
                  Cancel this review? Reviewers lose access to its items. Decisions already recorded
                  stay in the record.
                </span>
                <Field label="Reason (optional, shown on the review)" error={cancel.error?.message}>
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} />
                </Field>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setCancelling(false)}>
                    Keep it
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={cancel.isPending}
                    onClick={() =>
                      cancel.mutate(
                        { reason: reason || undefined },
                        { onSuccess: () => setCancelling(false) },
                      )
                    }
                  >
                    Cancel the review
                  </Button>
                </div>
              </div>
            )}
          </div>
          <YourTurn review={review} />
          {!guest && (
            <section className="flex flex-col gap-3">
              <SectionHead
                title="Steps"
                hint={review.order === "sequence" ? "in turn" : "all at once"}
              />
              <Steps review={review} />
            </section>
          )}
          <Reviewers review={review} onNotice={setNotice} />
          <Items review={review} />
          {!guest && <Activity review={review} />}
        </div>
        <aside className="flex min-w-0 flex-col gap-6">
          <section className="flex flex-col gap-0.5">
            <span className="label mb-1.5">Properties</span>
            <dl className="m-0">
              <Property name="Status">
                <span className="flex items-center gap-2">
                  <StatusDot state={state} />
                  {outcomeCopy[state]}
                </span>
              </Property>
              <Property name="Kind">
                {kind}
                {review.order === "sequence" && <span className="text-ink-3"> in turn</span>}
              </Property>
              {review.kind === "approval" && <Property name="Rule">{ruleCopy(review)}</Property>}
              {review.dueAt && (
                <Property name="Due">
                  <span className={cn(overdue && "text-signal")}>
                    {longDate.format(new Date(review.dueAt))}
                  </span>
                </Property>
              )}
              <Property name="Asked by">{review.createdByName ?? "A former member"}</Property>
              {project && !guest && (
                <Property name="Project">
                  <Link
                    to="/projects/$projectId"
                    params={{ projectId: project.id }}
                    className="truncate text-ink no-underline hover:text-signal"
                  >
                    {project.name}
                  </Link>
                </Property>
              )}
            </dl>
          </section>
          {guest && mine && (
            <p className="m-0 text-[12px] leading-[18px] text-ink-3">
              Your link is yours alone. What you open here is logged for whoever asked you.
            </p>
          )}
        </aside>
      </div>
      {dating && <DueDialog review={review} onClose={() => setDating(false)} />}
    </>
  );
}

import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Avatar } from "~/components/avatar";
import { Icon } from "~/components/icons";
import { Label } from "~/components/label";
import { usePageHeader } from "~/components/page-header";
import { Dot, Pill, reviewDot, reviewerCopy, reviewerDot } from "~/components/status";
import { Button } from "~/components/ui/button";
import { ActionMenu } from "~/components/ui/menu";
import {
  comments,
  fileById,
  groups,
  guests,
  latestVersion,
  personById,
  projectById,
  type Review,
  type Reviewer,
  reviewById,
  trackById,
} from "~/data";
import { cn } from "~/lib/cn";
import { fileDetails, kindIcon } from "~/lib/files";
import { ago, dueIn, formatDate, formatLongDate, formatTime, plural } from "~/lib/format";
import {
  kindCopy,
  latestDecision,
  needsYou,
  responded,
  reviewOutcome,
  ruleCopy,
  turnHasCome,
} from "~/lib/reviews";
import { useViewer } from "~/viewer/context";
import { Refused, StateGate, useScreenState } from "~/viewer/state-gate";
import { Permissions } from "./request-review.tsx";

function Items({ review, me }: { review: Review; me: Reviewer | undefined }) {
  const viewer = useViewer();
  const base = viewer.isGuest ? "/g/files/$fileId" : "/files/$fileId";
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="m-0 text-[15px] font-medium">Items</h2>
        <span className="tabular rounded-full bg-raised px-1.5 text-[11px] leading-[18px] text-ink-2">
          {review.items.length}
        </span>
        {me && review.kind !== "share" && (
          <span className="ml-auto text-xs text-ink-3">
            you opened {me.opened.length} of {review.items.length}
          </span>
        )}
      </div>
      <ul className="m-0 list-none rounded-panel-lg border border-hairline bg-surface p-0 shadow-1">
        {review.items.map((item, i) => {
          const track = item.trackId ? trackById(item.trackId) : undefined;
          const version = track
            ? item.versionNumber === "latest" || !item.versionNumber
              ? latestVersion(track)
              : track.versions.find((v) => v.number === item.versionNumber)
            : undefined;
          const file = item.fileId
            ? fileById(item.fileId)
            : version
              ? fileById(
                  (version.variations.find((v) => v.primary) ?? version.variations[0])?.fileId ??
                    "",
                )
              : undefined;
          const opened = me?.opened.includes(item.trackId ?? item.fileId ?? "");
          const count = file
            ? comments.filter((c) => c.fileId === file.id && !c.parentId).length
            : 0;
          const key = item.trackId ?? item.fileId ?? String(i);
          return (
            <li
              key={key}
              className="flex items-center gap-3 border-b border-hairline-soft px-4 py-3 last:border-b-0"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-raised text-ink-2">
                <Icon name={track ? "track" : file ? kindIcon[file.kind] : "file"} />
              </span>
              <div className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-ink">
                  {track?.name ?? file?.name}
                </span>
                <span className="block truncate text-xs text-ink-3">
                  {track && version
                    ? `Version ${version.number}${item.versionNumber === "latest" ? ", the latest" : ""} · ${version.variations.map((v) => v.name).join(", ")}`
                    : file
                      ? fileDetails(file)
                      : ""}
                  {count > 0 && ` · ${plural(count, "comment")}`}
                </span>
              </div>
              {me && review.kind !== "share" && (
                <span className="hidden text-xs text-ink-3 @3xl/app:inline">
                  {opened ? "Opened" : "Not opened"}
                </span>
              )}
              {file && (
                <Button variant="secondary" size="sm" asChild>
                  <Link to={base} params={{ fileId: file.id }} search={{ review: review.id }}>
                    Open
                  </Link>
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The decision as the raised object: approve or request changes, or submit feedback. */
function YourTurn({ review, me }: { review: Review; me: Reviewer }) {
  const [recorded, setRecorded] = useState<"approved" | "changes_requested" | "submitted" | null>(
    null,
  );
  const state = useScreenState();
  const decision = recorded && recorded !== "submitted" ? recorded : latestDecision(me);
  const submitted = recorded === "submitted" || me.state === "submitted";
  const notOpened = me.opened.length < review.items.length;
  if (review.kind === "share") return null;
  if (!turnHasCome(review, me)) {
    const step = review.reviewers.filter(
      (r) => r.position < me.position && r.state !== "submitted",
    );
    return (
      <section className="rounded-panel-lg border border-hairline bg-surface p-5 shadow-1">
        <Label>Your turn comes later</Label>
        <p className="m-0 mt-1 text-[13px] text-ink-2">
          This review runs in turn. Step {me.position} starts when{" "}
          {step.map((r) => personById(r.personId).name).join(" and ")}{" "}
          {step.length === 1 ? "has" : "have"} responded. You will get an email.
        </p>
      </section>
    );
  }
  if (state === "expired") {
    return (
      <section className="rounded-panel-lg border border-hairline bg-surface p-5 shadow-1">
        <Label>Closed</Label>
        <p className="m-0 mt-1 text-[13px] text-ink-2">
          Your access window ended on{" "}
          {formatLongDate(me.permissions.expiresAt ?? review.dueAt ?? "2026-10-14")}. The
          organisation can open it again.
        </p>
      </section>
    );
  }
  if (review.kind === "approval" && !me.permissions.decide) {
    return (
      <section className="rounded-panel-lg border border-hairline bg-surface p-5 shadow-1">
        <Label>Following along</Label>
        <p className="m-0 mt-1 text-[13px] text-ink-2">
          You were asked to look, not to decide: you can comment, and the decision rests with the
          others.
        </p>
      </section>
    );
  }
  if (review.kind === "feedback") {
    return (
      <section className="rounded-panel-lg border border-edge bg-raised p-5 shadow-2">
        <div className="flex items-baseline gap-2">
          <h2 className="m-0 text-[15px] font-medium">Your feedback</h2>
          <span className="text-xs text-ink-3">
            Comments on the items count; submit when you have said what you want to.
          </span>
        </div>
        {submitted ? (
          <p className="m-0 mt-3 flex items-center gap-2 text-[13px] text-ink">
            <Dot state="submitted" /> Feedback submitted{" "}
            {me.submittedAt ? ago(me.submittedAt) : "now"}. You can still comment until the review
            closes.
          </p>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            <textarea
              rows={2}
              placeholder="Anything about the review as a whole (optional)"
              className="rounded-control border border-edge bg-ground px-3 py-2 text-[13px] text-ink placeholder:text-ink-3 focus:border-ink-3 focus:outline-none"
            />
            <div className="flex items-center gap-3">
              <span className="text-xs text-ink-3">
                {me.opened.length < review.items.length
                  ? `You have not opened ${review.items.length - me.opened.length} of the items.`
                  : "You have opened every item."}
              </span>
              <Button
                variant="primary"
                className="ml-auto"
                onClick={() => setRecorded("submitted")}
              >
                Submit feedback
              </Button>
            </div>
          </div>
        )}
      </section>
    );
  }
  return (
    <section className="rounded-panel-lg border border-edge bg-raised p-5 shadow-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="m-0 text-[15px] font-medium">Your decision</h2>
        <span className="text-xs text-ink-3">
          Logged. A later decision adds to the record rather than replacing it.
        </span>
      </div>
      {decision ? (
        <div className="mt-3 flex flex-col gap-2">
          <p className="m-0 flex items-center gap-2 text-[13px] text-ink">
            <Dot state={decision === "approved" ? "approved" : "changes_requested"} />
            {decision === "approved" ? "You approved" : "You requested changes"}{" "}
            {recorded ? "just now" : me.submittedAt ? ago(me.submittedAt) : ""}.
          </p>
          {me.decision?.at(-1)?.note && !recorded && (
            <p className="m-0 text-[13px] text-ink-2">“{me.decision.at(-1)?.note}”</p>
          )}
          <button
            type="button"
            onClick={() => setRecorded(null)}
            className="self-start text-xs text-ink-3 hover:text-ink"
          >
            Record another decision
          </button>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          <textarea
            rows={2}
            placeholder="Note with your decision (optional)"
            className="rounded-control border border-edge bg-ground px-3 py-2 text-[13px] text-ink placeholder:text-ink-3 focus:border-ink-3 focus:outline-none"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={() => setRecorded("approved")}>
              Approve
            </Button>
            <Button variant="secondary" onClick={() => setRecorded("changes_requested")}>
              Request changes
            </Button>
            {notOpened && (
              <span className="text-xs text-ink-3">
                {review.items.length - me.opened.length === 1
                  ? "One item has not been opened yet."
                  : `${review.items.length - me.opened.length} items have not been opened yet.`}
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function Reviewers({ review, manage }: { review: Review; manage: boolean }) {
  const viewer = useViewer();
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const steps = [...new Set(review.reviewers.map((r) => r.position))].sort((a, b) => a - b);
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="m-0 text-[15px] font-medium">
          {review.kind === "share" ? "Shared with" : "Reviewers"}
        </h2>
        <span className="ml-auto text-xs text-ink-3">
          {responded(review)} of {review.reviewers.length} responded
        </span>
      </div>
      <div className="rounded-panel-lg border border-hairline bg-surface shadow-1">
        {steps.map((step) => (
          <div key={step}>
            {review.order === "sequence" && (
              <div className="flex items-center gap-2 border-b border-hairline-soft px-4 py-1.5">
                <Label>Step {step}</Label>
                {review.reviewers.some((r) => r.position === step && r.groupId) && (
                  <span className="text-xs text-ink-3">
                    {
                      groups.find(
                        (g) =>
                          g.id ===
                          review.reviewers.find((r) => r.position === step && r.groupId)?.groupId,
                      )?.name
                    }
                    , together
                  </span>
                )}
                {review.reviewers
                  .filter((r) => r.position === step)
                  .every((r) => r.state === "waiting") && (
                  <span className="ml-auto text-xs text-ink-3">not yet started</span>
                )}
              </div>
            )}
            <ul className="m-0 list-none p-0">
              {review.reviewers
                .filter((r) => r.position === step)
                .map((r) => {
                  const p = personById(r.personId);
                  const guest =
                    guests.find((g) => g.personId === r.personId) &&
                    !projectById(review.projectId)?.members.some(
                      (m) => m.personId === r.personId && viewer.persona.personId !== r.personId,
                    );
                  const isGuestRow =
                    r.permissions.comments !== "all" ||
                    Boolean(guest && r.permissions.history === false);
                  const decision = latestDecision(r);
                  const you = r.personId === viewer.personId;
                  return (
                    <li key={r.personId} className="border-b border-hairline-soft last:border-b-0">
                      <div className="group flex items-start gap-3 px-4 py-3">
                        <Avatar personId={r.personId} size={28} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className="text-[13px] font-medium text-ink">
                              {viewer.isGuest && !you ? p.name.split(" ")[0] : p.name}
                              {you && <span className="text-ink-3"> · you</span>}
                            </span>
                            {isGuestRow && <Label>guest</Label>}
                            {r.groupId && (
                              <span className="text-xs text-ink-3">
                                via {groups.find((g) => g.id === r.groupId)?.name}
                              </span>
                            )}
                            <span className="flex items-center gap-1.5 text-xs text-ink-2">
                              <Dot state={reviewerDot(r.state, decision)} />
                              {decision === "approved"
                                ? "Approved"
                                : decision === "changes_requested"
                                  ? "Changes requested"
                                  : review.kind === "share"
                                    ? r.state === "viewed"
                                      ? "Opened"
                                      : "Not yet opened"
                                    : reviewerCopy[r.state]}
                            </span>
                            {(r.submittedAt ?? r.viewedAt) && (
                              <span className="tabular text-xs text-ink-3">
                                {ago(r.submittedAt ?? r.viewedAt ?? "")}
                              </span>
                            )}
                          </div>
                          {decision && r.decision?.at(-1)?.note && (
                            <p className="m-0 mt-1 text-[13px] text-ink-2">
                              “{r.decision.at(-1)?.note}”
                            </p>
                          )}
                          {!viewer.isGuest && (
                            <p className="m-0 mt-0.5 text-xs text-ink-3">
                              {[
                                r.permissions.comments === "own_and_replies"
                                  ? "sees own comments and replies"
                                  : r.permissions.comments === "own"
                                    ? "sees only own comments"
                                    : null,
                                review.kind === "approval" && !r.permissions.decide
                                  ? "no decision"
                                  : null,
                                r.permissions.download !== "none"
                                  ? `may download the ${r.permissions.download}`
                                  : null,
                                r.permissions.expiresAt
                                  ? `until ${formatDate(r.permissions.expiresAt)}`
                                  : null,
                                r.permissions.viewLimit
                                  ? `at most ${r.permissions.viewLimit} plays`
                                  : null,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </p>
                          )}
                        </div>
                        {manage && (
                          <ActionMenu
                            label={p.name}
                            actions={[
                              {
                                label: "Permissions…",
                                onSelect: () =>
                                  setAdjusting(adjusting === r.personId ? null : r.personId),
                              },
                              { label: "Send a reminder", onSelect: () => {} },
                              ...(isGuestRow
                                ? [{ label: "Send a new link", onSelect: () => {} }]
                                : []),
                              { label: "Revoke access", danger: true, onSelect: () => {} },
                            ]}
                          />
                        )}
                      </div>
                      {adjusting === r.personId && (
                        <div className="px-4 pb-4">
                          <Permissions guest={isGuestRow} />
                          <div className="mt-2 flex justify-end gap-2">
                            <Button variant="ghost" size="sm" onClick={() => setAdjusting(null)}>
                              Cancel
                            </Button>
                            <Button variant="primary" size="sm" onClick={() => setAdjusting(null)}>
                              Save
                            </Button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
            </ul>
          </div>
        ))}
        {manage && review.status === "open" && (
          <div className="border-t border-hairline-soft px-4 py-2">
            {inviting ? (
              <form
                className="flex flex-col gap-2 py-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  setInviting(false);
                }}
              >
                <div className="grid gap-2 @3xl/app:grid-cols-[1fr_1fr_120px]">
                  <input
                    placeholder="Name"
                    className="h-8 rounded-control border border-edge bg-ground px-2.5 text-[13px] text-ink placeholder:text-ink-3"
                  />
                  <input
                    placeholder="Email"
                    type="email"
                    className="h-8 rounded-control border border-edge bg-ground px-2.5 text-[13px] text-ink placeholder:text-ink-3"
                  />
                  <input
                    placeholder="Label (optional)"
                    className="h-8 rounded-control border border-edge bg-ground px-2.5 text-[13px] text-ink placeholder:text-ink-3"
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setInviting(false)}>
                    Cancel
                  </Button>
                  <Button variant="primary" size="sm" type="submit">
                    Send the link
                  </Button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setInviting(true)}
                className="flex items-center gap-1.5 text-xs text-ink-3 hover:text-ink"
              >
                <Icon name="plus" size={12} /> Invite a guest
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

export function ReviewPage({ reviewId }: { reviewId: string }) {
  const viewer = useViewer();
  const review = reviewById(reviewId);
  const me = review ? viewer.reviewerIn(review) : undefined;
  const project = review ? projectById(review.projectId) : undefined;
  const allowed = review && (viewer.canSee(review.projectId) || me);
  const manage = Boolean(review && viewer.can(review.projectId, "manage_reviewers"));
  const outcome = review ? reviewOutcome(review) : null;
  const [cancelling, setCancelling] = useState(false);
  usePageHeader({
    crumbs: viewer.isGuest
      ? [{ label: "Your reviews", to: "/g" }]
      : [
          { label: "Projects", to: "/projects" },
          ...(project && viewer.canSee(project.id)
            ? [
                { label: project.name, to: `/projects/${project.id}` },
                { label: "Reviews", to: `/projects/${project.id}/reviews` },
              ]
            : [{ label: "Reviews", to: "/reviews" }]),
        ],
    title: review && allowed ? review.title : "Not found",
    actions:
      review && allowed ? (
        <>
          <Pill state={reviewDot(review.status, outcome)}>
            {review.status === "cancelled"
              ? "Cancelled"
              : outcome === "approved"
                ? "Approved"
                : outcome === "changes_requested"
                  ? "Changes requested"
                  : outcome === "submitted"
                    ? "Feedback in"
                    : review.kind === "share"
                      ? "Shared"
                      : "In review"}
          </Pill>
          {manage && review.status === "open" && (
            <ActionMenu
              label="review"
              actions={[
                { label: "Send a reminder to everyone waiting", onSelect: () => {} },
                { label: "Change the due date…", onSelect: () => {} },
                { label: "Copy the link", onSelect: () => {} },
                { label: "Export the comments…", onSelect: () => {} },
                {
                  label: review.kind === "share" ? "Stop sharing" : "Cancel the review…",
                  danger: true,
                  onSelect: () => setCancelling(true),
                },
              ]}
            />
          )}
        </>
      ) : undefined,
  });
  if (!review || !allowed) return <Refused />;
  const requester = personById(review.requestedBy);
  const due = review.dueAt ? dueIn(review.dueAt) : null;
  return (
    <StateGate>
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 @3xl/app:px-6">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-2">
            <span className="label">
              {kindCopy[review.kind]}
              {review.kind !== "share" && ` · ${ruleCopy(review)}`}
              {review.order === "sequence" && " · in turn"}
            </span>
            <span className="flex items-center gap-1.5">
              <Avatar personId={review.requestedBy} size={18} />
              {review.kind === "share" ? "Shared" : "Requested"} by{" "}
              {viewer.isGuest ? requester.name : requester.name} on{" "}
              {formatLongDate(review.requestedAt)}
            </span>
            {review.dueAt && due && (
              <span
                className={cn(
                  "flex items-center gap-1.5",
                  review.status === "open" && due.days < 0 && "text-signal",
                )}
              >
                <Icon name="calendar" size={14} />
                {review.kind === "share" ? "Until" : "Due"} {formatLongDate(review.dueAt)}
                {review.status === "open" && <span className="label">{due.label}</span>}
              </span>
            )}
          </div>
          {review.message && (
            <p className="m-0 max-w-2xl text-[14px] leading-[22px] text-ink">{review.message}</p>
          )}
          {review.status === "cancelled" && (
            <p className="m-0 flex items-center gap-2 text-[13px] text-ink-2">
              <Dot state="cancelled" /> Cancelled by{" "}
              {personById(review.log.at(-1)?.personId ?? "").name} on{" "}
              {formatDate(review.log.at(-1)?.at ?? "")}:{" "}
              {review.log.at(-1)?.text.replace("cancelled the review: ", "")}
            </p>
          )}
          {cancelling && (
            <div className="flex flex-wrap items-center gap-3 rounded-panel border border-signal/50 bg-signal/10 px-4 py-3 text-[13px] text-ink">
              <span>
                Cancel this review? Reviewers lose access to its items and are told. Decisions
                already recorded stay in the log.
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={() => setCancelling(false)}
              >
                Keep it
              </Button>
              <Button variant="primary" size="sm" onClick={() => setCancelling(false)}>
                Cancel the review
              </Button>
            </div>
          )}
        </div>
        <div className="grid gap-6 @5xl/app:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex min-w-0 flex-col gap-6">
            {me && review.status === "open" && <YourTurn review={review} me={me} />}
            {me && review.kind === "share" && review.status === "open" && (
              <section className="rounded-panel-lg border border-hairline bg-surface p-5 shadow-1">
                <Label>Shared with you</Label>
                <p className="m-0 mt-1 text-[13px] text-ink-2">
                  Listen as often as you like until{" "}
                  {me.permissions.expiresAt
                    ? formatLongDate(me.permissions.expiresAt)
                    : "it is withdrawn"}
                  {me.permissions.viewLimit ? `, up to ${me.permissions.viewLimit} plays` : ""}.{" "}
                  {me.permissions.download !== "none"
                    ? `You may download the ${me.permissions.download}; each copy is marked for you.`
                    : "There is nothing to download."}
                </p>
              </section>
            )}
            <Items review={review} me={me} />
            {!viewer.isGuest && review.kind !== "share" && (
              <section className="flex flex-col gap-2">
                <h2 className="m-0 text-[15px] font-medium">Decisions and feedback</h2>
                <ul className="m-0 list-none rounded-panel-lg border border-hairline bg-surface p-0 shadow-1">
                  {review.reviewers
                    .flatMap((r) => (r.decision ?? []).map((d) => ({ r, d })))
                    .sort((a, b) => b.d.at.localeCompare(a.d.at))
                    .map(({ r, d }) => (
                      <li
                        key={r.personId + d.at}
                        className="flex items-start gap-3 border-b border-hairline-soft px-4 py-3 last:border-b-0"
                      >
                        <Dot
                          state={d.decision === "approved" ? "approved" : "changes_requested"}
                          className="mt-1.5"
                        />
                        <div className="min-w-0 flex-1">
                          <span className="text-[13px] text-ink">
                            {personById(r.personId).name}{" "}
                            <span
                              className={
                                d.decision === "changes_requested" ? "text-signal" : "text-ink-2"
                              }
                            >
                              {d.decision === "approved" ? "approved" : "requested changes"}
                            </span>
                          </span>
                          {d.note && <p className="m-0 text-[13px] text-ink-2">“{d.note}”</p>}
                        </div>
                        <span className="tabular text-xs text-ink-3">
                          {formatDate(d.at)}, {formatTime(d.at)}
                        </span>
                      </li>
                    ))}
                  {review.reviewers.every((r) => !r.decision?.length) && (
                    <li className="px-4 py-3 text-xs text-ink-3">
                      {review.kind === "feedback"
                        ? `${responded(review)} of ${review.reviewers.length} have submitted feedback; their comments are on the items.`
                        : "No decisions yet."}
                    </li>
                  )}
                </ul>
              </section>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-6">
            <Reviewers review={review} manage={manage} />
            {!viewer.isGuest && (
              <section className="flex flex-col gap-2">
                <Label>Log</Label>
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-xs text-ink-3">
                  {[...review.log].reverse().map((l) => (
                    <li key={l.at + l.text} className="flex gap-3">
                      <span className="tabular shrink-0">
                        {formatDate(l.at)} {formatTime(l.at)}
                      </span>
                      <span className="text-ink-2">
                        {personById(l.personId).name} {l.text}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {viewer.isGuest && me && (
              <section className="rounded-panel-lg border border-hairline bg-surface px-4 py-3 shadow-1 text-xs text-ink-3">
                Your link is yours alone and was sent to {personById(me.personId).email}. Everything
                you open here is logged for {projectById(review.projectId)?.name}.
              </section>
            )}
          </div>
        </div>
        {me && needsYou(review, me) && review.kind !== "share" && (
          <p className="m-0 text-xs text-ink-3">
            This review needs you: open the items, comment where you like, then{" "}
            {review.kind === "approval" ? "record your decision" : "submit your feedback"} above.
          </p>
        )}
      </div>
    </StateGate>
  );
}

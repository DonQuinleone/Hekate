import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Avatar } from "~/components/avatar";
import { Icon } from "~/components/icons";
import { Label } from "~/components/label";
import { PageTitle, usePageHeader } from "~/components/page-header";
import { Property } from "~/components/property";
import { Dot, reviewDot, reviewerCopy, reviewerDot } from "~/components/status";
import { Thumb } from "~/components/thumb";
import { Button } from "~/components/ui/button";
import { Input, Textarea } from "~/components/ui/input";
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
import { fileDetails } from "~/lib/files";
import { ago, dueIn, formatDate, formatLongDate, formatTime, plural } from "~/lib/format";
import {
  kindCopy,
  latestDecision,
  responded,
  reviewOutcome,
  ruleCopy,
  turnHasCome,
} from "~/lib/reviews";
import { useViewer } from "~/viewer/context";
import { Refused, StateGate, useScreenState } from "~/viewer/state-gate";
import { Permissions } from "./request-review.tsx";

export const outcomeCopy = (r: Review) => {
  const o = reviewOutcome(r);
  if (r.status === "cancelled") return "Cancelled";
  if (o === "approved") return "Approved";
  if (o === "changes_requested") return "Changes requested";
  if (o === "submitted") return "Feedback in";
  if (r.kind === "share") return "Shared";
  return "In review";
};

/** The files a review item resolves to, and what to call it. */
export function resolveItem(item: Review["items"][number]) {
  const track = item.trackId ? trackById(item.trackId) : undefined;
  const version = track
    ? item.versionNumber === "latest" || !item.versionNumber
      ? latestVersion(track)
      : track.versions.find((v) => v.number === item.versionNumber)
    : undefined;
  const file = item.fileId
    ? fileById(item.fileId)
    : version
      ? fileById((version.variations.find((v) => v.primary) ?? version.variations[0])?.fileId ?? "")
      : undefined;
  return { track, version, file };
}

function Items({ review, me }: { review: Review; me: Reviewer | undefined }) {
  const viewer = useViewer();
  const base = viewer.isGuest ? "/g/files/$fileId" : "/files/$fileId";
  return (
    <section className="flex flex-col gap-2">
      <Label>
        {review.kind === "share" ? "Shared" : "To review"} · {review.items.length}
      </Label>
      <ul className="-mx-2 flex flex-col">
        {review.items.map((item, i) => {
          const { track, version, file } = resolveItem(item);
          const opened = me?.opened.includes(item.trackId ?? item.fileId ?? "");
          const count = file
            ? comments.filter((c) => c.fileId === file.id && !c.parentId && !c.resolved).length
            : 0;
          const key = item.trackId ?? item.fileId ?? String(i);
          const body = (
            <>
              {file && <Thumb file={file} width={56} height={36} />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium text-ink">
                  {track?.name ?? file?.name}
                </span>
                <span className="block truncate text-[13px] text-ink-3">
                  {track && version
                    ? `V${version.number} · ${version.variations.map((v) => v.name).join(", ")}`
                    : file
                      ? fileDetails(file)
                      : ""}
                  {count > 0 && ` · ${plural(count, "comment")}`}
                </span>
              </span>
              {me && review.kind !== "share" && (
                <span className="hidden shrink-0 items-center gap-2 text-[13px] text-ink-3 @3xl/app:flex">
                  <Dot state={opened ? "passed" : "invited"} />
                  {opened ? "Opened" : "Not opened"}
                </span>
              )}
              <Icon
                name="chevronRight"
                size={14}
                className="shrink-0 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100"
              />
            </>
          );
          return (
            <li key={key}>
              {file ? (
                <Link
                  to={base}
                  params={{ fileId: file.id }}
                  search={{ review: review.id }}
                  className="group flex items-center gap-3.5 rounded-panel px-2 py-2 transition-colors hover:bg-raised/60"
                >
                  {body}
                </Link>
              ) : (
                <div className="group flex items-center gap-3.5 px-2 py-2">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** What this reviewer does here: decide, give feedback, or just look. */
function YourTurn({ review, me }: { review: Review; me: Reviewer }) {
  const [recorded, setRecorded] = useState<"approved" | "changes_requested" | "submitted" | null>(
    null,
  );
  const state = useScreenState();
  const decision = recorded && recorded !== "submitted" ? recorded : latestDecision(me);
  const submitted = recorded === "submitted" || me.state === "submitted";
  const unopened = review.items.length - me.opened.length;
  if (review.kind === "share") return null;
  const quiet = (text: ReactNode) => (
    <p className="flex items-start gap-2.5 text-[14px] text-ink-2">
      <Icon name="clock" className="mt-0.5 shrink-0 text-ink-3" />
      <span>{text}</span>
    </p>
  );
  if (!turnHasCome(review, me)) {
    const step = review.reviewers.filter(
      (r) => r.position < me.position && r.state !== "submitted",
    );
    return quiet(
      <>
        Your turn comes after {step.map((r) => personById(r.personId).name).join(" and ")}{" "}
        {step.length === 1 ? "has" : "have"} responded. You will get an email.
      </>,
    );
  }
  if (state === "expired")
    return quiet(
      <>
        Your access ended on{" "}
        {formatLongDate(me.permissions.expiresAt ?? review.dueAt ?? "2026-10-14")}. The organisation
        can open it again.
      </>,
    );
  if (review.kind === "approval" && !me.permissions.decide)
    return quiet("You were asked to look and comment; the decision rests with the others.");

  const card = "rounded-panel-lg border border-line bg-raised/40 p-4 shadow-1 @3xl/app:p-5";
  if (review.kind === "feedback") {
    if (submitted)
      return (
        <p className="flex items-center gap-2.5 text-[14px] text-ink">
          <Dot state="submitted" />
          Feedback submitted {me.submittedAt && !recorded ? ago(me.submittedAt) : "just now"}. You
          can still comment until the review closes.
        </p>
      );
    return (
      <section className={card}>
        <Textarea rows={2} placeholder="Anything about the review as a whole (optional)" />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button variant="primary" size="lg" onClick={() => setRecorded("submitted")}>
            Submit feedback
          </Button>
          {unopened > 0 && (
            <span className="text-[13px] text-ink-3">
              {unopened === 1 ? "One item not opened yet" : `${unopened} items not opened yet`}
            </span>
          )}
        </div>
      </section>
    );
  }
  if (decision)
    return (
      <div className="flex flex-col gap-1.5">
        <p className="flex items-center gap-2.5 text-[14px] text-ink">
          <Dot state={decision === "approved" ? "approved" : "changes_requested"} />
          You {decision === "approved" ? "approved" : "requested changes"}{" "}
          {recorded ? "just now" : me.submittedAt ? ago(me.submittedAt) : ""}.
          <button
            type="button"
            onClick={() => setRecorded(null)}
            className="text-[13px] text-ink-3 hover:text-ink"
          >
            Decide again
          </button>
        </p>
        {me.decision?.at(-1)?.note && !recorded && (
          <p className="pl-5 text-[14px] text-ink-2">“{me.decision.at(-1)?.note}”</p>
        )}
      </div>
    );
  return (
    <section className={card}>
      <Textarea rows={2} placeholder="A note with your decision (optional)" />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" size="lg" onClick={() => setRecorded("approved")}>
          Approve
        </Button>
        <Button variant="secondary" size="lg" onClick={() => setRecorded("changes_requested")}>
          Request changes
        </Button>
        {unopened > 0 && (
          <span className="ml-1 text-[13px] text-ink-3">
            {unopened === 1 ? "One item not opened yet" : `${unopened} items not opened yet`}
          </span>
        )}
      </div>
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
      <div className="flex items-baseline gap-2">
        <Label>{review.kind === "share" ? "Shared with" : "Reviewers"}</Label>
        <span className="tabular text-[13px] text-ink-3">
          {responded(review)} of {review.reviewers.length}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        {steps.map((step) => (
          <div key={step} className="flex flex-col gap-1">
            {review.order === "sequence" && (
              <div className="mt-1 flex items-center gap-2 text-[12px] text-ink-3">
                <span>Step {step}</span>
                {review.reviewers.some((r) => r.position === step && r.groupId) && (
                  <span>
                    ·{" "}
                    {
                      groups.find(
                        (g) =>
                          g.id ===
                          review.reviewers.find((r) => r.position === step && r.groupId)?.groupId,
                      )?.name
                    }
                  </span>
                )}
              </div>
            )}
            <ul className="-mx-2 flex flex-col">
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
                  const limits = [
                    r.permissions.comments === "own_and_replies"
                      ? "own comments and replies"
                      : r.permissions.comments === "own"
                        ? "own comments only"
                        : null,
                    review.kind === "approval" && !r.permissions.decide ? "no decision" : null,
                    r.permissions.download !== "none"
                      ? `downloads ${r.permissions.download}`
                      : null,
                    r.permissions.expiresAt ? `until ${formatDate(r.permissions.expiresAt)}` : null,
                    r.permissions.viewLimit ? `${r.permissions.viewLimit} plays` : null,
                  ].filter(Boolean);
                  return (
                    <li key={r.personId}>
                      <div className="group flex items-center gap-2.5 rounded-control px-2 py-1.5 transition-colors hover:bg-raised/50">
                        <Avatar personId={r.personId} size={26} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 text-[13px]">
                            <span className="truncate font-medium text-ink">
                              {viewer.isGuest && !you ? p.name.split(" ")[0] : p.name}
                            </span>
                            {you && <span className="text-ink-3">you</span>}
                            {isGuestRow && !you && <span className="text-ink-3">guest</span>}
                          </div>
                          <div
                            className="flex items-center gap-1.5 truncate text-[12px] text-ink-3"
                            title={limits.join(", ")}
                          >
                            <Dot state={reviewerDot(r.state, decision)} className="size-[7px]" />
                            {decision === "approved"
                              ? "Approved"
                              : decision === "changes_requested"
                                ? "Changes requested"
                                : review.kind === "share"
                                  ? r.state === "viewed"
                                    ? "Opened"
                                    : "Not opened"
                                  : reviewerCopy[r.state]}
                            {(r.submittedAt ?? r.viewedAt) && (
                              <span className="tabular">
                                {ago(r.submittedAt ?? r.viewedAt ?? "")}
                              </span>
                            )}
                            {!viewer.isGuest && limits.length > 0 && (
                              <span className="truncate">· {limits.join(", ")}</span>
                            )}
                          </div>
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
                              "divider" as const,
                              { label: "Revoke access", danger: true, onSelect: () => {} },
                            ]}
                          />
                        )}
                      </div>
                      {adjusting === r.personId && (
                        <div className="rise-in mx-2 mt-1 rounded-panel border border-line bg-raised/40 p-3">
                          <Permissions guest={isGuestRow} compact />
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
          <div className="mt-1">
            {inviting ? (
              <form
                className="rise-in flex flex-col gap-2 rounded-panel border border-line bg-raised/40 p-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  setInviting(false);
                }}
              >
                <Input placeholder="Name" className="h-8" />
                <Input placeholder="Email" type="email" className="h-8" />
                <Input placeholder="Label, such as Conductor (optional)" className="h-8" />
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
                className="flex h-7 items-center gap-1.5 rounded-control px-2 text-[13px] text-ink-3 transition-colors hover:bg-raised/60 hover:text-ink"
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

/** Decisions and the log, newest first, as one record. */
function Activity({ review }: { review: Review }) {
  const entries = [
    ...review.log.map((l) => ({ at: l.at, personId: l.personId, text: l.text, decision: null })),
    ...review.reviewers.flatMap((r) =>
      (r.decision ?? []).map((d) => ({
        at: d.at,
        personId: r.personId,
        text: d.decision === "approved" ? "approved" : "requested changes",
        decision: d,
      })),
    ),
  ].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <section className="flex flex-col gap-2">
      <Label>Activity</Label>
      <ul className="flex flex-col">
        {entries.map((e) => (
          <li key={e.at + e.text} className="flex gap-3 py-2">
            <Avatar personId={e.personId} size={22} className="mt-px" />
            <div className="min-w-0 flex-1">
              <p className="text-[14px] text-ink-2">
                <span className="text-ink">{personById(e.personId).name}</span>{" "}
                <span className={e.decision?.decision === "changes_requested" ? "text-signal" : ""}>
                  {e.text}
                </span>
                <span className="tabular ml-2 text-[13px] text-ink-3">
                  {formatDate(e.at)}, {formatTime(e.at)}
                </span>
              </p>
              {e.decision?.note && (
                <p className="mt-1 text-[14px] text-ink-2">“{e.decision.note}”</p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The review itself: on its own page, or in the inbox beside the list. */
export function ReviewBody({
  reviewId,
  embedded = false,
}: {
  reviewId: string;
  embedded?: boolean;
}) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const review = reviewById(reviewId);
  const me = review ? viewer.reviewerIn(review) : undefined;
  const project = review ? projectById(review.projectId) : undefined;
  const allowed = review && (viewer.canSee(review.projectId) || me);
  const manage = Boolean(review && viewer.can(review.projectId, "manage_reviewers"));
  const [cancelling, setCancelling] = useState(false);
  if (!review || !allowed) return <Refused />;
  const outcome = reviewOutcome(review);
  const requester = personById(review.requestedBy);
  const due = review.dueAt ? dueIn(review.dueAt) : null;
  const overdue = review.status === "open" && due && due.days < 0;
  return (
    <div
      className={cn(
        "fade-in grid w-full gap-10 px-4 py-6 @3xl/app:px-8 @3xl/app:py-8",
        embedded
          ? "@4xl/app:grid-cols-[minmax(0,1fr)_240px]"
          : "mx-auto max-w-[1120px] @5xl/app:grid-cols-[minmax(0,1fr)_264px]",
      )}
    >
      <div className="flex min-w-0 flex-col gap-7">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-3">
            <span className="flex items-center gap-2 text-ink-2">
              <Dot state={reviewDot(review.status, outcome)} />
              {outcomeCopy(review)}
            </span>
            <span>
              {kindCopy[review.kind]}
              {review.kind !== "share" && `, ${ruleCopy(review)}`}
              {review.order === "sequence" && ", in turn"}
            </span>
            {review.dueAt && due && (
              <span className={cn(overdue && "text-signal")}>
                {review.kind === "share" ? "Until" : "Due"} {formatDate(review.dueAt)}
                {review.status === "open" && ` · ${due.label}`}
              </span>
            )}
            {manage && review.status === "open" && (
              <span className="-my-1 ml-auto">
                <ActionMenu
                  always
                  label="review"
                  actions={[
                    { label: "Remind everyone waiting", onSelect: () => {} },
                    { label: "Change the due date…", onSelect: () => {} },
                    { label: "Copy link", onSelect: () => {} },
                    { label: "Export comments…", onSelect: () => {} },
                    "divider",
                    {
                      label: review.kind === "share" ? "Stop sharing" : "Cancel the review…",
                      danger: true,
                      onSelect: () => setCancelling(true),
                    },
                  ]}
                />
              </span>
            )}
          </div>
          <PageTitle>{review.title}</PageTitle>
          <p className="flex items-center gap-2 text-[13px] text-ink-3">
            <Avatar personId={review.requestedBy} size={18} />
            {requester.name}, {formatLongDate(review.requestedAt)}
          </p>
          {review.message && (
            <p className="max-w-[640px] text-[15px] leading-[24px] text-ink-2">{review.message}</p>
          )}
          {review.status === "cancelled" && (
            <p className="flex items-center gap-2 text-[14px] text-ink-2">
              <Dot state="cancelled" /> Cancelled by{" "}
              {personById(review.log.at(-1)?.personId ?? "").name} on{" "}
              {formatDate(review.log.at(-1)?.at ?? "")}:{" "}
              {review.log.at(-1)?.text.replace("cancelled the review: ", "")}
            </p>
          )}
          {cancelling && (
            <div className="rise-in flex flex-wrap items-center gap-3 rounded-panel border border-signal/40 bg-signal/10 px-4 py-3 text-[14px] text-ink">
              <span>
                Cancel this review? Reviewers lose access to its items and are told. Decisions
                already recorded stay in the record.
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
        {me && review.status === "open" && <YourTurn review={review} me={me} />}
        {me && review.kind === "share" && review.status === "open" && (
          <p className="text-[14px] text-ink-2">
            Listen as often as you like until{" "}
            {me.permissions.expiresAt
              ? formatLongDate(me.permissions.expiresAt)
              : "it is withdrawn"}
            {me.permissions.viewLimit ? `, up to ${me.permissions.viewLimit} plays` : ""}.{" "}
            {me.permissions.download !== "none"
              ? `You may download the ${me.permissions.download}; each copy is marked for you.`
              : ""}
          </p>
        )}
        <Items review={review} me={me} />
        {!viewer.isGuest && review.kind !== "share" && <Activity review={review} />}
      </div>
      <aside className="flex min-w-0 flex-col gap-6">
        <section className="flex flex-col gap-0.5">
          <Label className="mb-1.5">Properties</Label>
          <Property name="Status">
            <Dot state={reviewDot(review.status, outcome)} />
            {outcomeCopy(review)}
          </Property>
          <Property name="Kind">
            {kindCopy[review.kind]}
            {review.order === "sequence" && <span className="text-ink-3">in turn</span>}
          </Property>
          {review.kind === "approval" && <Property name="Rule">{ruleCopy(review)}</Property>}
          {review.dueAt && (
            <Property name={review.kind === "share" ? "Until" : "Due"}>
              <span className={cn(overdue && "text-signal")}>{formatLongDate(review.dueAt)}</span>
            </Property>
          )}
          <Property name="Asked by">
            <Avatar personId={review.requestedBy} size={18} />
            {requester.name}
          </Property>
          {project && !viewer.isGuest && (
            <Property name="Project">
              <Link
                to="/projects/$projectId"
                params={{ projectId: project.id }}
                className="truncate hover:text-signal"
              >
                {project.name}
              </Link>
            </Property>
          )}
          {!viewer.isGuest &&
            viewer.can(review.projectId, "request_reviews") &&
            review.status === "open" && (
              <button
                type="button"
                onClick={() =>
                  navigate({ to: "/reviews/new", search: { project: review.projectId } })
                }
                className="mt-2 flex h-7 items-center gap-1.5 self-start rounded-control px-2 text-[13px] text-ink-3 transition-colors hover:bg-raised/60 hover:text-ink"
              >
                <Icon name="plus" size={12} /> Another review
              </button>
            )}
        </section>
        <Reviewers review={review} manage={manage} />
        {viewer.isGuest && me && (
          <p className="text-[12px] leading-[18px] text-ink-3">
            Your link is yours alone and was sent to {personById(me.personId).email}. What you open
            here is logged for {projectById(review.projectId)?.name}.
          </p>
        )}
      </aside>
    </div>
  );
}

export function ReviewPage({ reviewId }: { reviewId: string }) {
  const viewer = useViewer();
  const review = reviewById(reviewId);
  const me = review ? viewer.reviewerIn(review) : undefined;
  const project = review ? projectById(review.projectId) : undefined;
  const allowed = review && (viewer.canSee(review.projectId) || me);
  usePageHeader({
    crumbs: viewer.isGuest
      ? [{ label: "Your reviews", to: "/g" }]
      : project && viewer.canSee(project.id)
        ? [
            { label: project.name, to: `/projects/${project.id}` },
            { label: "Reviews", to: `/projects/${project.id}/reviews` },
          ]
        : [{ label: "Inbox", to: "/" }],
    title: review && allowed ? review.title : "Not found",
    heading: "page",
  });
  if (!review || !allowed) return <Refused />;
  return (
    <StateGate>
      <ReviewBody reviewId={reviewId} />
    </StateGate>
  );
}

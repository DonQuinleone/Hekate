import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Avatar } from "~/components/avatar";
import { Icon, type IconName } from "~/components/icons";
import { Label } from "~/components/label";
import { Card, Page, SectionHead } from "~/components/page";
import { PageTitle, usePageHeader } from "~/components/page-header";
import { PermissionsDialog } from "~/components/permissions";
import { Property } from "~/components/property";
import { Dot, reviewDot, reviewerCopy, reviewerDot } from "~/components/status";
import { Thumb } from "~/components/thumb";
import { Button } from "~/components/ui/button";
import { Input, Textarea } from "~/components/ui/input";
import { ActionMenu, Dropdown } from "~/components/ui/menu";
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
  type Stage,
  trackById,
  workflows,
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

/** The workflow stage this review is, and what comes after and before it. */
function stagesOf(review: Review): { stage?: Stage; next?: Stage; back?: Stage } {
  const project = projectById(review.projectId);
  const workflow = workflows.find((w) => w.id === project?.workflowId);
  if (!workflow) return {};
  const status = resolveItem(review.items[0] ?? {}).version?.status;
  const ofKind = workflow.stages.filter((s) => s.kind === review.kind);
  const stage = ofKind.find((s) => s.status === status) ?? ofKind[0];
  const next = stage ? workflow.stages.find((s) => s.after.includes(stage.id)) : undefined;
  const back = stage ? workflow.stages.find((s) => s.id === stage.after[0]) : undefined;
  return { stage, next, back };
}

const fileIdsOf = (review: Review) =>
  new Set(
    review.items.flatMap((i) => {
      const { version, file } = resolveItem(i);
      return version ? version.variations.map((v) => v.fileId) : file ? [file.id] : [];
    }),
  );

/* ---------- Steps ---------- */

type StepState = "done" | "current" | "ahead" | "failed";

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
          "flex h-12 items-center gap-2.5 rounded-panel border px-3 transition-colors",
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
            state === "current" && "bg-signal text-ground",
            state === "failed" && "bg-signal text-ground",
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

/** The review's own little workflow: the steps, the gate, and where the items go next. */
function Steps({ review }: { review: Review }) {
  const outcome = reviewOutcome(review);
  const { next, back } = stagesOf(review);
  const positions = [...new Set(review.reviewers.map((r) => r.position))].sort((a, b) => a - b);
  const stepState = (pos: number): StepState => {
    const rows = review.reviewers.filter((r) => r.position === pos);
    if (rows.every((r) => r.state === "submitted" || r.state === "observing")) return "done";
    if (rows.some((r) => r.state !== "waiting")) return "current";
    return "ahead";
  };
  const gateState: StepState =
    outcome === "approved" || outcome === "submitted"
      ? "done"
      : outcome === "changes_requested"
        ? "failed"
        : positions.every((p) => stepState(p) === "done")
          ? "current"
          : "ahead";
  const stepLabel = (pos: number) => {
    const rows = review.reviewers.filter((r) => r.position === pos);
    const group = groups.find((g) => g.id === rows.find((r) => r.groupId)?.groupId);
    return group
      ? `${group.name} group`
      : rows.map((r) => personById(r.personId).name.split(" ")[0]).join(", ");
  };
  return (
    <ol className="flex flex-wrap items-center gap-y-2 py-1">
      <Node
        icon="send"
        title="Requested"
        sub={`${personById(review.requestedBy).name.split(" ")[0]}, ${formatDate(review.requestedAt)}`}
        state="done"
        first
      />
      {positions.map((pos) => {
        const rows = review.reviewers.filter((r) => r.position === pos);
        const done = rows.filter((r) => r.state === "submitted").length;
        return (
          <Node
            key={pos}
            icon={review.kind === "approval" ? "review" : "comment"}
            title={review.order === "sequence" ? `Step ${pos}: ${stepLabel(pos)}` : stepLabel(pos)}
            sub={`${done} of ${rows.length} responded`}
            state={stepState(pos)}
          />
        );
      })}
      {review.kind !== "share" && (
        <Node
          icon="gate"
          title={review.kind === "approval" ? "Gate" : "Feedback in"}
          sub={review.kind === "approval" ? ruleCopy(review) : "then the producer triages"}
          state={gateState}
        />
      )}
      {next && (
        <Node
          icon={next.kind === "task" ? "task" : next.kind === "approval" ? "review" : "comment"}
          title={next.name}
          sub={`then · ${next.participants}`}
          state={outcome === "approved" || outcome === "submitted" ? "current" : "ahead"}
        />
      )}
      {outcome === "changes_requested" && back && (
        <Node
          icon="repeat"
          title={`Back to ${back.name}`}
          sub={back.participants}
          state="current"
        />
      )}
    </ol>
  );
}

/* ---------- Reviewers ---------- */

function Reviewers({ review, manage }: { review: Review; manage: boolean }) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const [permissionsFor, setPermissionsFor] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const ids = fileIdsOf(review);
  const base = viewer.isGuest ? "/g/files/$fileId" : "/files/$fileId";
  const steps = [...new Set(review.reviewers.map((r) => r.position))].sort((a, b) => a - b);
  return (
    <section className="flex flex-col gap-3">
      <SectionHead
        title={review.kind === "share" ? "Shared with" : "Reviewers"}
        hint={`${responded(review)} of ${review.reviewers.length} responded`}
        action={
          manage &&
          review.status === "open" && (
            <Button variant="ghost" size="sm" onClick={() => setInviting(true)}>
              <Icon name="userPlus" size={14} />
              Invite
            </Button>
          )
        }
      />
      <Card>
        <ul className="flex flex-col">
          {steps.map((step) => (
            <li key={step} className="border-b border-line last:border-b-0">
              {review.order === "sequence" && (
                <div className="flex h-8 items-center gap-2 bg-raised/20 px-4 text-[12px] text-ink-3">
                  Step {step}
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
              <ul>
                {review.reviewers
                  .filter((r) => r.position === step)
                  .map((r) => {
                    const p = personById(r.personId);
                    const isGuest =
                      guests.some((g) => g.personId === r.personId) &&
                      r.permissions.history === false;
                    const decision = latestDecision(r);
                    const you = r.personId === viewer.personId;
                    const theirs = comments.filter(
                      (c) => c.authorId === r.personId && ids.has(c.fileId) && !c.parentId,
                    );
                    const note = r.decision?.at(-1)?.note;
                    return (
                      <li
                        key={r.personId}
                        className="group flex flex-col gap-2 border-b border-line px-4 py-3 last:border-b-0"
                      >
                        <div className="flex items-center gap-3">
                          <Avatar personId={r.personId} size={30} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 text-[14px]">
                              <span className="truncate font-medium text-ink">
                                {viewer.isGuest && !you ? p.name.split(" ")[0] : p.name}
                              </span>
                              {you && <span className="text-ink-3">you</span>}
                              {isGuest && !you && <span className="text-ink-3">· guest</span>}
                              {r.permissions.expiresAt && !viewer.isGuest && (
                                <span className="text-ink-3">
                                  · until {formatDate(r.permissions.expiresAt)}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-1.5 text-[13px] text-ink-3">
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
                              {review.kind === "approval" && !r.permissions.decide && (
                                <span>· comments only</span>
                              )}
                            </div>
                          </div>
                          {theirs.length > 0 && (
                            <Link
                              to={base}
                              params={{ fileId: theirs[0]?.fileId ?? "" }}
                              search={{ review: review.id, comment: theirs[0]?.id }}
                              className="flex h-7 items-center gap-1.5 rounded-control px-2 text-[13px] text-ink-2 hover:bg-raised hover:text-ink"
                            >
                              <Icon name="comment" size={13} />
                              {plural(theirs.length, "comment")}
                            </Link>
                          )}
                          {manage && (
                            <ActionMenu
                              label={p.name}
                              actions={[
                                {
                                  label: "Override permissions for this review…",
                                  onSelect: () => setPermissionsFor(r.personId),
                                },
                                { label: "Send a reminder", onSelect: () => {} },
                                ...(isGuest
                                  ? [{ label: "Send a new link", onSelect: () => {} }]
                                  : []),
                                "divider" as const,
                                {
                                  label: "Remove from the review",
                                  danger: true,
                                  onSelect: () => {},
                                },
                              ]}
                            />
                          )}
                        </div>
                        {note && (
                          <blockquote className="ml-[42px] border-l-2 border-line-strong pl-3 text-[14px] leading-[21px] text-ink-2">
                            {note}
                          </blockquote>
                        )}
                      </li>
                    );
                  })}
              </ul>
            </li>
          ))}
        </ul>
      </Card>
      {inviting && (
        <form
          className="rise-in flex flex-col gap-2 rounded-panel border border-line bg-raised/40 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            setInviting(false);
          }}
        >
          <Label>Invite to this review</Label>
          <div className="grid gap-2 @3xl/app:grid-cols-3">
            <Input placeholder="Name" className="h-8" />
            <Input placeholder="Email" type="email" className="h-8" />
            <Input placeholder="Label, such as Conductor (optional)" className="h-8" />
          </div>
          <p className="text-[12px] text-ink-3">
            A member of the project gets a notification; anyone else gets a link, with the
            permissions set for reviewers in{" "}
            <button
              type="button"
              onClick={() =>
                navigate({
                  to: "/projects/$projectId/$view",
                  params: { projectId: review.projectId, view: "people" },
                })
              }
              className="text-ink-2 hover:text-ink"
            >
              People
            </button>
            .
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setInviting(false)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" type="submit">
              Send
            </Button>
          </div>
        </form>
      )}
      {permissionsFor && (
        <PermissionsDialog
          personId={permissionsFor}
          guest={guests.some((g) => g.personId === permissionsFor)}
          reviewTitle={review.title}
          onClose={() => setPermissionsFor(null)}
        />
      )}
    </section>
  );
}

/* ---------- Items and the gate ---------- */

function Items({
  review,
  me,
  manage,
}: {
  review: Review;
  me: Reviewer | undefined;
  manage: boolean;
}) {
  const viewer = useViewer();
  const base = viewer.isGuest ? "/g/files/$fileId" : "/files/$fileId";
  const outcome = reviewOutcome(review);
  const { next, back } = stagesOf(review);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [moved, setMoved] = useState<string | null>(null);
  const keyOf = (i: Review["items"][number], n: number) => i.trackId ?? i.fileId ?? String(n);
  const toggle = (k: string) => {
    const n = new Set(selected);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    setSelected(n);
  };
  const counted = review.reviewers.filter(
    (r) => r.permissions.decide || review.kind !== "approval",
  );
  const approved = counted.filter((r) => latestDecision(r) === "approved").length;
  const changes = counted.filter((r) => latestDecision(r) === "changes_requested").length;
  const passed = outcome === "approved" || outcome === "submitted";
  const gateCopy =
    review.kind === "approval"
      ? `${ruleCopy(review)[0]?.toUpperCase()}${ruleCopy(review).slice(1)} · ${approved} approved, ${changes} asked for changes, ${counted.length - approved - changes} to come`
      : `${responded(review)} of ${review.reviewers.length} submitted`;
  return (
    <section className="flex flex-col gap-3">
      <SectionHead
        title={review.kind === "share" ? "Shared" : "Under review"}
        hint={plural(review.items.length, "item")}
        action={
          manage &&
          review.status === "open" &&
          review.kind !== "share" && (
            <Dropdown
              align="right"
              value={
                <span className="flex items-center gap-1.5 font-medium text-ink">
                  <Icon name="arrowRight" size={13} />
                  Move on
                </span>
              }
              actions={[
                ...(next
                  ? [
                      {
                        label: `Move all ${review.items.length} to ${next.name}`,
                        hint: passed ? "gate passed" : "gate not passed",
                        onSelect: () => setMoved(`all → ${next.name}`),
                      },
                      {
                        label: `Move the ${selected.size} selected to ${next.name}`,
                        onSelect: () => setMoved(`${selected.size} → ${next.name}`),
                      },
                    ]
                  : []),
                ...(back
                  ? [
                      "divider" as const,
                      {
                        label: `Send back to ${back.name}`,
                        onSelect: () => setMoved(`all → ${back.name}`),
                      },
                    ]
                  : []),
                "divider" as const,
                {
                  label: "Keep them here and close the review",
                  onSelect: () => setMoved("closed"),
                },
              ]}
            />
          )
        }
      />
      <Card>
        {review.kind !== "share" && (
          <div
            className={cn(
              "flex flex-wrap items-center gap-3 border-b border-line px-4 py-3",
              passed ? "bg-raised/20" : outcome === "changes_requested" ? "bg-signal/5" : "",
            )}
          >
            <span
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-full",
                passed
                  ? "bg-ink text-ground"
                  : outcome === "changes_requested"
                    ? "bg-signal text-ground"
                    : "border border-line-strong text-ink-3",
              )}
            >
              <Icon
                name={passed ? "check" : outcome === "changes_requested" ? "close" : "gate"}
                size={13}
              />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] text-ink">
                {passed
                  ? `Gate passed: ${next ? `the items can move to ${next.name}` : "the review is complete"}`
                  : outcome === "changes_requested"
                    ? `Gate not passed: changes requested${back ? `, the items go back to ${back.name}` : ""}`
                    : "Gate: not yet"}
              </span>
              <span className="block text-[13px] text-ink-3">{gateCopy}</span>
            </span>
            {moved && (
              <span className="rise-in flex items-center gap-2 text-[13px] text-ink">
                <Dot state="approved" /> {moved === "closed" ? "Review closed" : `Moved ${moved}`}
              </span>
            )}
          </div>
        )}
        <ul className="flex flex-col">
          {review.items.map((item, i) => {
            const { track, version, file } = resolveItem(item);
            const opened = me?.opened.includes(item.trackId ?? item.fileId ?? "");
            const count = file
              ? comments.filter((c) => c.fileId === file.id && !c.parentId && !c.resolved).length
              : 0;
            const k = keyOf(item, i);
            return (
              <li
                key={k}
                className="group flex items-center gap-3.5 border-b border-line px-4 py-2.5 last:border-b-0 hover:bg-raised/40"
              >
                {manage && review.status === "open" && review.kind !== "share" && (
                  <input
                    type="checkbox"
                    checked={selected.has(k)}
                    onChange={() => toggle(k)}
                    aria-label={`Select ${track?.name ?? file?.name}`}
                  />
                )}
                {file && <Thumb file={file} width={56} height={36} />}
                <Link
                  to={base}
                  params={{ fileId: file?.id ?? "" }}
                  search={{ review: review.id }}
                  className="min-w-0 flex-1"
                >
                  <span className="block truncate text-[14px] font-medium text-ink">
                    {track?.name ?? file?.name}
                  </span>
                  <span className="block truncate text-[13px] text-ink-3">
                    {track && version
                      ? `V${version.number} · ${version.variations.map((v) => v.name).join(", ")}`
                      : file
                        ? fileDetails(file)
                        : ""}
                    {count > 0 && ` · ${plural(count, "open comment")}`}
                  </span>
                </Link>
                {version && (
                  <span className="hidden items-center gap-2 text-[13px] text-ink-3 @3xl/app:flex">
                    <Dot
                      state={version.status === "Approved" ? "approved" : "in_review"}
                      className="size-[7px]"
                    />
                    {version.status}
                  </span>
                )}
                {me && review.kind !== "share" && (
                  <span className="hidden shrink-0 items-center gap-2 text-[13px] text-ink-3 @3xl/app:flex">
                    <Dot state={opened ? "passed" : "invited"} />
                    {opened ? "Opened" : "Not opened"}
                  </span>
                )}
                <Link
                  to={base}
                  params={{ fileId: file?.id ?? "" }}
                  search={{ review: review.id }}
                  aria-label="Open"
                  className="flex size-7 items-center justify-center rounded-control text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-raised hover:text-ink"
                >
                  <Icon name="play" size={11} fill="currentColor" strokeWidth={0} />
                </Link>
              </li>
            );
          })}
        </ul>
      </Card>
    </section>
  );
}

/* ---------- Your turn ---------- */

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
  const card =
    "rounded-panel-lg border border-signal/30 bg-signal/[0.06] p-4 shadow-1 @3xl/app:p-5";
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
        <Label className="text-ink-2">Your feedback</Label>
        <Textarea
          rows={2}
          className="mt-2"
          placeholder="Anything about the review as a whole (optional)"
        />
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
      <Label className="text-ink-2">Your decision</Label>
      <Textarea rows={2} className="mt-2" placeholder="A note with your decision (optional)" />
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

/* ---------- Activity ---------- */

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
    <section className="flex flex-col gap-3">
      <SectionHead title="Activity" />
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

/* ---------- The body ---------- */

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
  const body = (
    <div
      className={cn(
        "grid w-full gap-10",
        embedded
          ? "@4xl/app:grid-cols-[minmax(0,1fr)_232px]"
          : "@5xl/app:grid-cols-[minmax(0,1fr)_248px]",
      )}
    >
      <div className="flex min-w-0 flex-col gap-8">
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
        {review.kind !== "share" && !viewer.isGuest && (
          <section className="flex flex-col gap-3">
            <SectionHead
              title="Steps"
              hint={review.order === "sequence" ? "in turn" : "all at once"}
            />
            <Steps review={review} />
          </section>
        )}
        <Reviewers review={review} manage={manage} />
        <Items review={review} me={me} manage={manage} />
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
        {viewer.isGuest && me && (
          <p className="text-[12px] leading-[18px] text-ink-3">
            Your link is yours alone and was sent to {personById(me.personId).email}. What you open
            here is logged for {projectById(review.projectId)?.name}.
          </p>
        )}
      </aside>
    </div>
  );
  return embedded ? (
    <div className="fade-in px-5 py-6 @3xl/app:px-8 @3xl/app:py-8">{body}</div>
  ) : (
    <Page>{body}</Page>
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
        : [{ label: "Inbox", to: "/inbox" }],
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

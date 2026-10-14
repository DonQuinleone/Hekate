import type { GuestInput, ReviewerInput, ReviewKind } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { cn } from "~/lib/cn";
import {
  projectFilesQuery,
  projectMembersQuery,
  projectReviewsQuery,
  projectRolesQuery,
  projectTracksQuery,
  type ReviewSummary,
  useCreateReview,
  useProjectCan,
} from "~/lib/queries";
import { Button } from "./ui/button";
import { type ReviewState, StatusPill } from "./ui/status";

const dateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

/** A review's status as the pill shows it. */
export function reviewState(review: Pick<ReviewSummary, "status" | "outcome">): ReviewState {
  if (review.status === "cancelled") return "cancelled";
  if (review.status === "open") return "in_review";
  return review.outcome === "submitted" ? "submitted" : (review.outcome ?? "in_review");
}

const control =
  "h-8 rounded-control border border-edge bg-ground px-3 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-ink-3";

function Choice({
  selected,
  onSelect,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "h-7 cursor-pointer rounded-chip border px-2.5 text-xs",
        selected
          ? "border-edge bg-raised text-ink"
          : "border-transparent bg-transparent text-ink-3 hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="label">{label}</span>
      {children}
    </div>
  );
}

/** Add a guest reviewer by name and email: someone outside the organisation, without an account. */
export function GuestFields({
  onAdd,
  submitLabel = "Add guest",
}: {
  onAdd: (guest: GuestInput) => void;
  submitLabel?: string;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [label, setLabel] = useState("");
  const valid = name.trim() && /^[^\s@]+@[^\s@]+$/.test(email.trim());
  const add = () => {
    if (!valid) return;
    onAdd({ name: name.trim(), email: email.trim(), label: label.trim() || undefined });
    setName("");
    setEmail("");
    setLabel("");
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        className={cn(control, "min-w-36 flex-1")}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name"
        aria-label="Guest name"
      />
      <input
        className={cn(control, "min-w-44 flex-1")}
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email"
        aria-label="Guest email"
      />
      <input
        className={cn(control, "w-32")}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Role (optional)"
        aria-label="Guest role"
      />
      <Button size="sm" disabled={!valid} onClick={add}>
        {submitLabel}
      </Button>
    </div>
  );
}

const keyOf = (entry: ReviewerInput) =>
  typeof entry === "string" ? `member:${entry}` : `guest:${entry.email.toLowerCase()}`;

/** Ask reviewers for an approval or for feedback on tracks and files of this project. */
function RequestReview({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const navigate = useNavigate();
  const { data: tracks } = useQuery(projectTracksQuery(projectId));
  const { data: files } = useQuery(projectFilesQuery(projectId));
  const { data: members } = useQuery(projectMembersQuery(projectId));
  const { data: roles } = useQuery(projectRolesQuery(projectId));
  const create = useCreateReview(projectId);
  const [kind, setKind] = useState<ReviewKind>("approval");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [due, setDue] = useState("");
  const [order, setOrder] = useState<"parallel" | "sequence">("parallel");
  const [rule, setRule] = useState<"all" | "any">("all");
  const [items, setItems] = useState<string[]>([]);
  // Members (by user id) and guests, in the order a sequence would ask them.
  const [reviewers, setReviewers] = useState<ReviewerInput[]>([]);
  // An approval asks for a decision, so only roles that can decide may review one.
  const deciders = new Set(
    (roles ?? []).filter((r) => r.permissions.includes("decide")).map((r) => r.id),
  );
  const people = (members ?? []).filter((p) => kind === "feedback" || deciders.has(p.roleId));
  const chosen = reviewers.filter(
    (r) => typeof r !== "string" || people.some((p) => p.userId === r),
  );
  const toggleMember = (userId: string) =>
    setReviewers(
      reviewers.includes(userId) ? reviewers.filter((r) => r !== userId) : [...reviewers, userId],
    );
  const addGuest = (guest: GuestInput) => {
    if (!reviewers.some((r) => keyOf(r) === keyOf(guest))) setReviewers([...reviewers, guest]);
  };
  const guests = chosen.filter((r): r is GuestInput => typeof r !== "string");

  const toggle = (list: string[], set: (next: string[]) => void, value: string) =>
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      {
        kind,
        title,
        message: message || undefined,
        dueAt: due ? new Date(`${due}T17:00:00`).toISOString() : null,
        order,
        rule: kind === "approval" ? rule : undefined,
        items: items.map((key) => {
          const [type, id] = key.split(":") as [string, string];
          return type === "track" ? { trackId: id } : { fileId: id };
        }),
        reviewers: chosen,
      },
      {
        onSuccess: (review) => {
          onDone();
          void navigate({ to: "/reviews/$reviewId", params: { reviewId: review.id } });
        },
      },
    );
  };
  const ready = title.trim() && items.length > 0 && chosen.length > 0;

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-5 rounded-panel border border-hairline bg-surface p-5"
      aria-label="Request a review"
    >
      <div className="flex flex-wrap items-end gap-4">
        <Field label="Kind">
          <span className="flex gap-1">
            <Choice selected={kind === "approval"} onSelect={() => setKind("approval")}>
              Approval
            </Choice>
            <Choice selected={kind === "feedback"} onSelect={() => setKind("feedback")}>
              Feedback
            </Choice>
          </span>
        </Field>
        <label className="flex min-w-60 flex-1 flex-col gap-1.5">
          <span className="label">Title</span>
          <input
            className={control}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={kind === "approval" ? "Album masters" : "Rough mixes, round 1"}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="label">Due</span>
          <input
            type="date"
            className={control}
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
        </label>
      </div>

      <Field label="What to review">
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {(tracks ?? []).map((track) => (
            <li key={track.id}>
              <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-2">
                <input
                  type="checkbox"
                  checked={items.includes(`track:${track.id}`)}
                  onChange={() => toggle(items, setItems, `track:${track.id}`)}
                  className="accent-[var(--hk-ink)]"
                />
                <span className="text-ink">{track.name}</span>
                <span className="text-xs text-ink-3">track, its latest version</span>
              </label>
            </li>
          ))}
          {(files ?? []).map((file) => (
            <li key={file.id}>
              <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-2">
                <input
                  type="checkbox"
                  checked={items.includes(`file:${file.id}`)}
                  onChange={() => toggle(items, setItems, `file:${file.id}`)}
                  className="accent-[var(--hk-ink)]"
                />
                <span className="text-ink">{file.name}</span>
              </label>
            </li>
          ))}
        </ul>
      </Field>

      <Field label="Reviewers">
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {people.map((person) => {
            const at = chosen.indexOf(person.userId);
            return (
              <li key={person.userId}>
                <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-2">
                  <input
                    type="checkbox"
                    checked={at >= 0}
                    onChange={() => toggleMember(person.userId)}
                    className="accent-[var(--hk-ink)]"
                  />
                  <span className="text-ink">{person.name}</span>
                  {order === "sequence" && at >= 0 && (
                    <span className="tabular font-mono text-[11px] text-ink-3">{at + 1}</span>
                  )}
                </label>
              </li>
            );
          })}
          {guests.map((guest) => (
            <li key={keyOf(guest)} className="flex items-center gap-2 text-[13px] text-ink-2">
              <span className="text-ink">{guest.name}</span>
              <span className="truncate text-xs text-ink-3">
                {guest.label ? `${guest.label}, guest` : "Guest"} · {guest.email}
              </span>
              {order === "sequence" && (
                <span className="tabular font-mono text-[11px] text-ink-3">
                  {chosen.indexOf(guest) + 1}
                </span>
              )}
              <button
                type="button"
                onClick={() => setReviewers(reviewers.filter((r) => r !== guest))}
                className="ml-auto cursor-pointer border-0 bg-transparent p-0 text-xs text-ink-3 hover:text-signal"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <GuestFields onAdd={addGuest} />
        <p className="m-0 text-xs text-ink-3">
          Guests need no account: each is emailed a link that works once, for three days, and
          reaches only this review.
        </p>
      </Field>

      <div className="flex flex-wrap gap-6">
        <Field label="Order">
          <span className="flex gap-1">
            <Choice selected={order === "parallel"} onSelect={() => setOrder("parallel")}>
              All at once
            </Choice>
            <Choice selected={order === "sequence"} onSelect={() => setOrder("sequence")}>
              In turn
            </Choice>
          </span>
        </Field>
        {kind === "approval" && (
          <Field label="Approved when">
            <span className="flex gap-1">
              <Choice selected={rule === "all"} onSelect={() => setRule("all")}>
                Everyone approves
              </Choice>
              <Choice selected={rule === "any"} onSelect={() => setRule("any")}>
                Anyone approves
              </Choice>
            </span>
          </Field>
        )}
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="label">Message</span>
        <textarea
          rows={3}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="What to listen for, or anything reviewers should know"
          className="w-full resize-y rounded-control border border-edge bg-ground px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-ink-3"
        />
      </label>
      {create.error && <p className="m-0 text-xs text-signal">{create.error.message}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!ready || create.isPending}>
          Send review
        </Button>
      </div>
    </form>
  );
}

/** A project's reviews, newest first, and requesting a new one. */
export function ProjectReviews({ projectId }: { projectId: string }) {
  const { data: reviews, error } = useQuery(projectReviewsQuery(projectId));
  const can = useProjectCan(projectId);
  const [requesting, setRequesting] = useState(false);
  return (
    <section aria-label="Reviews" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="m-0 text-[15px] font-medium">Reviews</h2>
        {can("request_reviews") && !requesting && (
          <Button onClick={() => setRequesting(true)}>Request review</Button>
        )}
      </div>
      {requesting && <RequestReview projectId={projectId} onDone={() => setRequesting(false)} />}
      {error && <p className="m-0 text-xs text-signal">{error.message}</p>}
      {reviews && reviews.length === 0 && !requesting && (
        <p className="m-0 text-[13px] text-ink-3">
          No reviews yet. A review asks people to approve, or to give feedback on, tracks and files.
        </p>
      )}
      {reviews && reviews.length > 0 && (
        <ul className="m-0 flex list-none flex-col border-t border-hairline p-0">
          {reviews.map((review) => (
            <li
              key={review.id}
              className="grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-hairline py-2.5 sm:grid-cols-[minmax(0,1fr)_120px_100px_auto]"
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

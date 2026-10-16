import { z } from "zod";
import { reviewerPermissionsChange } from "./reviewer-permissions.ts";

/**
 * Reviews (docs/domain.md, Reviews): someone with the authority asks reviewers about one
 * or more items. An approval review collects a logged *Approved* or *Changes requested*
 * from each reviewer; a feedback review collects comments, then each reviewer submits.
 */
export const reviewKinds = ["approval", "feedback"] as const;
export type ReviewKind = (typeof reviewKinds)[number];

/** All reviewers at once, or one after another in the order given. */
export const reviewOrders = ["parallel", "sequence"] as const;
export type ReviewOrder = (typeof reviewOrders)[number];

/**
 * Approvals only: everyone must approve, any one approval is enough, or a share of the
 * reviewers asked for a decision (a percentage, rounded up to whole people).
 */
export const approvalRules = ["all", "any", "share"] as const;
export type ApprovalRule = (typeof approvalRules)[number];

export const reviewDecisions = ["approved", "changes_requested"] as const;
export type ReviewDecision = (typeof reviewDecisions)[number];

/**
 * Where a reviewer has got to. "waiting" is a reviewer later in a sequence, not yet asked;
 * "observing" is one an approval does not ask for a decision, who follows along.
 */
export const reviewerStates = [
  "waiting",
  "invited",
  "viewed",
  "in_progress",
  "submitted",
  "observing",
] as const;
export type ReviewerState = (typeof reviewerStates)[number];

export const reviewStatuses = ["open", "completed", "cancelled"] as const;
export type ReviewStatus = (typeof reviewStatuses)[number];

/** A review's result: approvals end approved or with changes requested; feedback, submitted. */
export type ReviewOutcome = ReviewDecision | "submitted" | null;

export const reviewItemInput = z.union([
  z.object({
    trackId: z.uuid(),
    /** A specific version; left out, the review follows the track's latest. */
    versionId: z.uuid().nullish(),
  }),
  z.object({ fileId: z.uuid() }),
]);
export type ReviewItemInput = z.infer<typeof reviewItemInput>;

/** A guest reviewer: someone outside the organisation, reached by email. */
export const guestInput = z.object({
  name: z.string().trim().min(1).max(120),
  email: z
    .email()
    .max(254)
    .transform((e) => e.toLowerCase()),
  /** How they appear beside their name, for example "Conductor". */
  label: z.string().trim().max(60).optional(),
});
export type GuestInput = z.input<typeof guestInput>;

/** A person in a group: a member's user id, or a guest. */
export const personInput = z.union([z.string().min(1).max(64), guestInput]);
export type PersonInput = z.infer<typeof personInput>;

/** A reviewer: a member's user id, a guest, or one of the project's groups. */
export const reviewerInput = z.union([personInput, z.object({ groupId: z.uuid() })]);
export type ReviewerInput = z.infer<typeof reviewerInput>;
/** One reviewer's identity in a request: the key per-reviewer overrides are given by. */
export const reviewerKey = (r: ReviewerInput) =>
  typeof r === "string"
    ? `member:${r}`
    : "groupId" in r
      ? `group:${r.groupId}`
      : `guest:${r.email}`;

/** A group of reviewers in a project, for example "Soloists". */
export const groupInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    members: z.array(personInput).min(1, "A group needs someone in it").max(100),
  })
  .refine((g) => new Set(g.members.map((m) => reviewerKey(m))).size === g.members.length, {
    message: "Each person can be in a group once",
    path: ["members"],
  });
export type GroupInput = z.input<typeof groupInput>;

/** One step of a request: a reviewer, or several asked together. */
export const reviewStepInput = z.union([reviewerInput, z.array(reviewerInput).min(1).max(50)]);
export type ReviewStepInput = z.infer<typeof reviewStepInput>;
const stepPeople = (step: ReviewStepInput) => (Array.isArray(step) ? step : [step]);

export const createReviewInput = z
  .object({
    kind: z.enum(reviewKinds),
    /** Left out, the review is named after what it asks about. */
    title: z.string().trim().min(1).max(160).optional(),
    message: z.string().trim().max(4000).optional(),
    dueAt: z.iso.datetime({ offset: true }).nullish(),
    /** Remind whoever it still waits on the day before it is due. */
    remind: z.boolean().default(true),
    order: z.enum(reviewOrders).default("parallel"),
    rule: z.enum(approvalRules).optional(),
    /** With the share rule: the percentage of deciding reviewers whose approval is enough. */
    share: z.int().min(1).max(100).optional(),
    items: z.array(reviewItemInput).min(1, "A review needs something to review").max(50),
    /**
     * The steps, in order (the order matters in a sequence): each a reviewer or several asked
     * together. A reviewer is a member by user id, a guest by name and email (an existing
     * guest of the organisation is reused), or a group, whose members are asked together.
     */
    reviewers: z.array(reviewStepInput).min(1, "A review needs a reviewer").max(50),
    /** What every reviewer may do, changed from the defaults; each can be adjusted later. */
    permissions: reviewerPermissionsChange.optional(),
    /** What one reviewer may do, changed again, by their `reviewerKey`. */
    overrides: z.record(z.string().max(320), reviewerPermissionsChange).optional(),
  })
  .refine((r) => r.reviewers.flatMap(stepPeople).length <= 50, {
    message: "A review can ask at most 50 reviewers",
    path: ["reviewers"],
  })
  .refine(
    (r) => {
      const keys = r.reviewers.flatMap(stepPeople).map(reviewerKey);
      return new Set(keys).size === keys.length;
    },
    { message: "Each reviewer can be asked once", path: ["reviewers"] },
  )
  .refine((r) => r.kind !== "approval" || r.rule !== "share" || r.share !== undefined, {
    message: "Say what share of the reviewers must approve",
    path: ["share"],
  })
  .transform((r) => {
    const rule = r.kind === "approval" ? (r.rule ?? "all") : null;
    return { ...r, rule, share: rule === "share" ? (r.share ?? null) : null };
  });
export type CreateReviewInput = z.input<typeof createReviewInput>;

export const decisionInput = z.object({
  decision: z.enum(reviewDecisions),
  note: z.string().trim().max(4000).optional(),
});

/** The facts the rules need about each reviewer, in the review's order. */
export interface ReviewerFacts {
  id: string;
  /** Their step in the order: a group's members share one. */
  step: number;
  /** Viewed or started; the rules only need to know whether they have submitted. */
  submitted: boolean;
  /** Their latest decision, if any: a later one supersedes, but never erases, an earlier. */
  decision: ReviewDecision | null;
  viewed: boolean;
  started: boolean;
  /** In an approval, asked for no decision: they neither hold up the order nor count. */
  observer?: boolean;
}

/**
 * Who may act now. Everyone in a parallel review; in a sequence, everyone at the earliest
 * step where someone has not yet submitted (each step starts when the previous one
 * finishes, and a group's members are one step).
 */
export function activeReviewers(order: ReviewOrder, reviewers: ReviewerFacts[]): Set<string> {
  const waiting = reviewers.filter((r) => !r.submitted && !r.observer);
  if (order === "parallel") return new Set(waiting.map((r) => r.id));
  const step = Math.min(...waiting.map((r) => r.step));
  return new Set(waiting.filter((r) => r.step === step).map((r) => r.id));
}

/** Each reviewer's state, from the facts and who is active. */
export function reviewerState(
  order: ReviewOrder,
  reviewers: ReviewerFacts[],
  reviewer: ReviewerFacts,
): ReviewerState {
  if (reviewer.observer) return "observing";
  if (reviewer.submitted) return "submitted";
  if (!activeReviewers(order, reviewers).has(reviewer.id)) return "waiting";
  if (reviewer.started) return "in_progress";
  if (reviewer.viewed) return "viewed";
  return "invited";
}

/**
 * The outcome so far, or null while the review is still waiting on someone.
 *
 * - Approval, rule *any*: approved as soon as one reviewer's latest decision is *Approved*.
 * - Approval, rule *all*: approved once every reviewer's latest decision is *Approved*; once
 *   everyone has decided and any latest decision is *Changes requested*, changes requested.
 * - Approval, rule *share*: approved once enough reviewers approve (the share of them,
 *   rounded up); changes requested as soon as that can no longer happen.
 * - Feedback: submitted once everyone has submitted.
 */
export function reviewOutcome(
  kind: ReviewKind,
  rule: ApprovalRule | null,
  everyone: ReviewerFacts[],
  share: number | null = null,
): ReviewOutcome {
  const reviewers = everyone.filter((r) => !r.observer);
  if (reviewers.length === 0) return null;
  if (kind === "feedback") return reviewers.every((r) => r.submitted) ? "submitted" : null;
  if (rule === "share") {
    const needed = approvalsNeeded(reviewers.length, share ?? 100);
    const approved = reviewers.filter((r) => r.decision === "approved").length;
    const open = reviewers.filter((r) => r.decision === null).length;
    if (approved >= needed) return "approved";
    return approved + open < needed ? "changes_requested" : null;
  }
  if (rule === "any" && reviewers.some((r) => r.decision === "approved")) return "approved";
  if (!reviewers.every((r) => r.decision !== null)) return null;
  if (rule === "any") return "changes_requested";
  return reviewers.every((r) => r.decision === "approved") ? "approved" : "changes_requested";
}

/** How many approvals a share of so many reviewers comes to: at least one, rounded up. */
export function approvalsNeeded(reviewers: number, share: number): number {
  return Math.max(1, Math.ceil((reviewers * share) / 100 - 1e-9));
}

/** The name a request without a title gets: what it asks about. */
export function reviewTitleFor(names: string[]): string {
  const [first] = names;
  if (!first) return "Review";
  const rest = names.length - 1;
  return (rest === 0 ? first : `${first} and ${rest} more`).slice(0, 160);
}

/** Submitting feedback, with an optional word about the review as a whole. */
export const submitFeedbackInput = z.object({
  note: z.string().trim().max(4000).optional(),
});

/** Cancelling a review, with the reason its reviewers are given. */
export const cancelReviewInput = z.object({
  reason: z.string().trim().max(500).optional(),
});

/** Changing an open review: its due date, or none. */
export const updateReviewInput = z.object({
  dueAt: z.iso.datetime({ offset: true }).nullable(),
});

/** A reminder: to everyone the review is waiting on, or to one reviewer. */
export const remindInput = z.object({
  reviewerId: z.uuid().optional(),
});

/** How far a step of a review, or its gate, has got. */
export type StepState = "done" | "current" | "ahead" | "failed";

export interface StepReviewer {
  id: string;
  step: number;
  state: ReviewerState;
}

export interface ReviewStep<R extends StepReviewer = StepReviewer> {
  step: number;
  reviewers: R[];
  responded: number;
  state: StepState;
}

/**
 * A review's steps in order, as its page draws them: done once everyone in it has
 * responded (or only follows along), current while anyone in it is asked, ahead before.
 * A parallel review is one step.
 */
export function reviewSteps<R extends StepReviewer>(
  order: ReviewOrder,
  reviewers: R[],
): ReviewStep<R>[] {
  const positions =
    order === "parallel" ? [0] : [...new Set(reviewers.map((r) => r.step))].sort((a, b) => a - b);
  return positions.map((step) => {
    const rows = order === "parallel" ? reviewers : reviewers.filter((r) => r.step === step);
    const responded = rows.filter((r) => r.state === "submitted").length;
    const state: StepState = rows.every((r) => r.state === "submitted" || r.state === "observing")
      ? "done"
      : rows.some((r) => r.state !== "waiting")
        ? "current"
        : "ahead";
    return { step, reviewers: rows, responded, state };
  });
}

/**
 * The gate at the end of a review: passed once it is approved or the feedback is in,
 * failed when changes are requested, current once every step is done but nothing is
 * decided, ahead before that. A cancelled review's gate never opens.
 */
export function gateState(
  status: ReviewStatus,
  outcome: ReviewOutcome,
  steps: Pick<ReviewStep, "state">[],
): StepState {
  if (outcome === "approved" || outcome === "submitted") return "done";
  if (outcome === "changes_requested") return "failed";
  if (status !== "open") return "ahead";
  return steps.every((s) => s.state === "done") ? "current" : "ahead";
}

/**
 * What the gate counts: of the reviewers it waits on (in an approval, those asked for a
 * decision), how many approved, asked for changes, submitted, and are still to come.
 */
export function gateCounts(
  kind: ReviewKind,
  reviewers: { state: ReviewerState; decision: ReviewDecision | null }[],
) {
  const counted = reviewers.filter((r) => r.state !== "observing");
  const approved = counted.filter((r) => r.decision === "approved").length;
  const changes = counted.filter((r) => r.decision === "changes_requested").length;
  const submitted = counted.filter((r) => r.state === "submitted").length;
  return {
    total: counted.length,
    approved,
    changes,
    submitted,
    toCome: kind === "approval" ? counted.length - approved - changes : counted.length - submitted,
  };
}

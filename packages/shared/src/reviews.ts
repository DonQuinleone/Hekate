import { z } from "zod";

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

/** Approvals only: everyone must approve, or any one approval is enough. */
export const approvalRules = ["all", "any"] as const;
export type ApprovalRule = (typeof approvalRules)[number];

export const reviewDecisions = ["approved", "changes_requested"] as const;
export type ReviewDecision = (typeof reviewDecisions)[number];

/** Where a reviewer has got to. "waiting" is a reviewer later in a sequence, not yet asked. */
export const reviewerStates = ["waiting", "invited", "viewed", "in_progress", "submitted"] as const;
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

export const createReviewInput = z
  .object({
    kind: z.enum(reviewKinds),
    title: z.string().trim().min(1).max(160),
    message: z.string().trim().max(4000).optional(),
    dueAt: z.iso.datetime({ offset: true }).nullish(),
    order: z.enum(reviewOrders).default("parallel"),
    rule: z.enum(approvalRules).optional(),
    items: z.array(reviewItemInput).min(1, "A review needs something to review").max(50),
    /** Members of the organisation, in order (the order matters in a sequence). */
    reviewers: z.array(z.string().min(1).max(64)).min(1, "A review needs a reviewer").max(50),
  })
  .refine((r) => new Set(r.reviewers).size === r.reviewers.length, {
    message: "Each reviewer can be asked once",
    path: ["reviewers"],
  })
  .transform((r) => ({ ...r, rule: r.kind === "approval" ? (r.rule ?? "all") : null }));
export type CreateReviewInput = z.input<typeof createReviewInput>;

export const decisionInput = z.object({
  decision: z.enum(reviewDecisions),
  note: z.string().trim().max(4000).optional(),
});

/** The facts the rules need about each reviewer, in the review's order. */
export interface ReviewerFacts {
  id: string;
  /** Viewed or started; the rules only need to know whether they have submitted. */
  submitted: boolean;
  /** Their latest decision, if any: a later one supersedes, but never erases, an earlier. */
  decision: ReviewDecision | null;
  viewed: boolean;
  started: boolean;
}

/**
 * Who may act now. Everyone in a parallel review; in a sequence, the first reviewer who
 * has not yet submitted (each starts when the previous one finishes).
 */
export function activeReviewers(order: ReviewOrder, reviewers: ReviewerFacts[]): Set<string> {
  if (order === "parallel") return new Set(reviewers.filter((r) => !r.submitted).map((r) => r.id));
  const next = reviewers.find((r) => !r.submitted);
  return new Set(next ? [next.id] : []);
}

/** Each reviewer's state, from the facts and who is active. */
export function reviewerState(
  order: ReviewOrder,
  reviewers: ReviewerFacts[],
  reviewer: ReviewerFacts,
): ReviewerState {
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
 * - Feedback: submitted once everyone has submitted.
 */
export function reviewOutcome(
  kind: ReviewKind,
  rule: ApprovalRule | null,
  reviewers: ReviewerFacts[],
): ReviewOutcome {
  if (reviewers.length === 0) return null;
  if (kind === "feedback") return reviewers.every((r) => r.submitted) ? "submitted" : null;
  if (rule === "any" && reviewers.some((r) => r.decision === "approved")) return "approved";
  if (!reviewers.every((r) => r.decision !== null)) return null;
  if (rule === "any") return "changes_requested";
  return reviewers.every((r) => r.decision === "approved") ? "approved" : "changes_requested";
}

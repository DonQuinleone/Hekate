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
const reviewerKey = (r: ReviewerInput) =>
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

export const createReviewInput = z
  .object({
    kind: z.enum(reviewKinds),
    title: z.string().trim().min(1).max(160),
    message: z.string().trim().max(4000).optional(),
    dueAt: z.iso.datetime({ offset: true }).nullish(),
    order: z.enum(reviewOrders).default("parallel"),
    rule: z.enum(approvalRules).optional(),
    items: z.array(reviewItemInput).min(1, "A review needs something to review").max(50),
    /**
     * In order (the order matters in a sequence): members by user id, guests by name and
     * email (an existing guest of the organisation is reused), and groups, whose members
     * are asked together as one step.
     */
    reviewers: z.array(reviewerInput).min(1, "A review needs a reviewer").max(50),
    /** What every reviewer may do, changed from the defaults; each can be adjusted later. */
    permissions: reviewerPermissionsChange.optional(),
  })
  .refine((r) => new Set(r.reviewers.map(reviewerKey)).size === r.reviewers.length, {
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
  /** Their step in the order: a group's members share one. */
  step: number;
  /** Viewed or started; the rules only need to know whether they have submitted. */
  submitted: boolean;
  /** Their latest decision, if any: a later one supersedes, but never erases, an earlier. */
  decision: ReviewDecision | null;
  viewed: boolean;
  started: boolean;
}

/**
 * Who may act now. Everyone in a parallel review; in a sequence, everyone at the earliest
 * step where someone has not yet submitted (each step starts when the previous one
 * finishes, and a group's members are one step).
 */
export function activeReviewers(order: ReviewOrder, reviewers: ReviewerFacts[]): Set<string> {
  const waiting = reviewers.filter((r) => !r.submitted);
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

import type { Decision, Review, Reviewer } from "~/data/types";

/** The latest decision a reviewer recorded; decisions are append-only. */
export const latestDecision = (r: Reviewer): Decision | undefined =>
  r.decision?.[r.decision.length - 1]?.decision;

/** Where an approval stands: approved, changes requested, or still open. A feedback review is submitted when everyone has. */
export function reviewOutcome(review: Review): Decision | "submitted" | null {
  if (review.status === "cancelled") return null;
  const counted = review.reviewers.filter(
    (r) => r.permissions.decide || review.kind !== "approval",
  );
  if (review.kind === "approval") {
    const decisions = counted.map(latestDecision);
    if (decisions.some((d) => d === "changes_requested")) return "changes_requested";
    const approved = decisions.filter((d) => d === "approved").length;
    if (review.rule === "any" && approved >= 1) return "approved";
    if (
      review.rule === "quorum" &&
      approved >= Math.ceil(counted.length * ((review.quorum ?? 100) / 100))
    )
      return "approved";
    if (review.rule === "all" && counted.length > 0 && approved === counted.length)
      return "approved";
    return null;
  }
  if (counted.length > 0 && counted.every((r) => r.state === "submitted")) return "submitted";
  return null;
}

export const responded = (review: Review) =>
  review.reviewers.filter((r) => r.state === "submitted").length;

export const kindCopy: Record<Review["kind"], string> = {
  approval: "Approval",
  feedback: "Feedback",
  share: "Share",
};

export function ruleCopy(review: Review): string {
  if (review.kind !== "approval")
    return review.kind === "feedback" ? "comments, no sign-off" : "nothing to submit";
  if (review.rule === "any") return "any one approves";
  if (review.rule === "quorum") return `${review.quorum ?? 100}% approve`;
  return "everyone approves";
}

/** Whether a reviewer's turn has come, for a review sent in sequence. */
export const turnHasCome = (review: Review, reviewer: Reviewer) =>
  review.order === "parallel" || reviewer.state !== "waiting";

/** The reviews that need this person now: asked, their turn, not yet responded. */
export function needsYou(review: Review, me: Reviewer | undefined): boolean {
  if (!me || review.status !== "open") return false;
  if (review.kind === "share") return false;
  if (!turnHasCome(review, me)) return false;
  return me.state === "invited" || me.state === "viewed" || me.state === "in_progress";
}

/** What a step of a sequence is called: its name where it has one, else "Step n". */
export const stepTitle = (name: string | null | undefined, ordinal: number) =>
  name?.trim() || `Step ${ordinal}`;

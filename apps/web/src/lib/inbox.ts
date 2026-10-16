import { dueIn } from "./home";
import type { MyReview } from "./queries";

export type InboxFilter = "needs" | "following" | "done";

/** One row in the inbox: a review, or a file that could not be processed. */
export interface InboxItem {
  id: string;
  kind: "review" | "failed";
  title: string;
  detail: string;
  at: string;
  urgent: boolean;
  review?: MyReview;
}

const outcome: Record<string, string> = {
  approved: "Approved",
  changes_requested: "Changes requested",
  submitted: "Feedback in",
};

function reviewItem(r: MyReview, now: number): InboxItem {
  const due = r.status === "open" && r.dueAt ? dueIn(r.dueAt, now) : null;
  const ask =
    r.status === "cancelled"
      ? "Cancelled"
      : r.status !== "open"
        ? (outcome[r.outcome ?? ""] ?? "Finished")
        : r.yourTurn
          ? r.kind === "approval"
            ? "Your decision"
            : "Your feedback"
          : r.submittedAt
            ? "You have responded"
            : "Waiting on others";
  return {
    id: r.id,
    kind: "review",
    title: r.title,
    detail: [ask, r.projectName, due?.label].filter(Boolean).join(" · "),
    at: r.createdAt,
    urgent: Boolean(due && due.days < 0),
    review: r,
  };
}

/**
 * The inbox's three lists. Needs you: reviews where it is your turn, soonest due first, then
 * files that failed to process. Following: open reviews waiting on someone else. Done:
 * finished and cancelled reviews, newest first.
 */
export function inboxLists(
  reviews: MyReview[],
  failed: { id: string; name: string; projectName?: string }[],
  now = Date.now(),
): Record<InboxFilter, InboxItem[]> {
  const open = reviews.filter((r) => r.status === "open");
  const byDue = (a: MyReview, b: MyReview) => (a.dueAt ?? "￿").localeCompare(b.dueAt ?? "￿");
  const newest = (a: MyReview, b: MyReview) => b.createdAt.localeCompare(a.createdAt);
  return {
    needs: [
      ...open
        .filter((r) => r.yourTurn)
        .sort(byDue)
        .map((r) => reviewItem(r, now)),
      ...failed.map(
        (f): InboxItem => ({
          id: f.id,
          kind: "failed",
          title: `${f.name} could not be processed`,
          detail: "The file needs replacing",
          at: "",
          urgent: true,
        }),
      ),
    ],
    following: open
      .filter((r) => !r.yourTurn)
      .sort(byDue)
      .map((r) => reviewItem(r, now)),
    done: reviews
      .filter((r) => r.status !== "open")
      .sort(newest)
      .map((r) => reviewItem(r, now)),
  };
}

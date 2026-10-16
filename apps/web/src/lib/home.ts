import type { HomeActivity, MyReview } from "./queries";

const DAY_MS = 86_400_000;

/** How long until a date, in whole days, and how to say it: "3 days", "due today", "2 days overdue". */
export function dueIn(iso: string, now = Date.now()): { days: number; label: string } {
  const days = Math.ceil((new Date(iso).getTime() - now) / DAY_MS);
  if (days < 0) return { days, label: `${-days} day${days === -1 ? "" : "s"} overdue` };
  if (days === 0) return { days, label: "due today" };
  return { days, label: `${days} day${days === 1 ? "" : "s"}` };
}

/** "Good morning" before noon, "Good afternoon" until six, "Good evening" after. */
export function greeting(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** Something on the home page that waits on you: a review to answer or a file to replace. */
export interface Attention {
  id: string;
  kind: "review" | "failed";
  title: string;
  why: string;
  when?: string;
  urgent: boolean;
  /** The review, or the file. */
  targetId: string;
  /** For a review, how it stands, so its dot reads the same as everywhere else. */
  review?: Pick<MyReview, "status" | "outcome">;
}

/**
 * What waits on you, most pressing first: reviews where it is your turn (soonest due first,
 * undated last), then files that could not be processed.
 */
export function attentionFor(
  reviews: MyReview[],
  failed: { id: string; name: string }[],
  now = Date.now(),
): Attention[] {
  const turns = reviews
    .filter((r) => r.yourTurn && r.status === "open")
    .sort((a, b) => (a.dueAt ?? "￿").localeCompare(b.dueAt ?? "￿"))
    .map((r): Attention => {
      const due = r.dueAt ? dueIn(r.dueAt, now) : null;
      return {
        id: r.id,
        kind: "review",
        title: r.title,
        why:
          r.kind === "approval"
            ? `Your decision is asked for in ${r.projectName}`
            : `Your feedback is asked for in ${r.projectName}`,
        when: due?.label,
        urgent: Boolean(due && due.days < 1),
        targetId: r.id,
        review: r,
      };
    });
  const broken = failed.map(
    (f): Attention => ({
      id: f.id,
      kind: "failed",
      title: `${f.name} could not be processed`,
      why: "The file needs replacing",
      urgent: true,
      targetId: f.id,
    }),
  );
  return [...turns, ...broken];
}

export interface Deadline {
  id: string;
  at: string;
  title: string;
  project: string;
}

/** Open reviews with a due date, soonest first. */
export const deadlinesOf = (reviews: MyReview[]): Deadline[] =>
  reviews
    .filter((r): r is MyReview & { dueAt: string } => r.status === "open" && r.dueAt !== null)
    .map((r) => ({ id: r.id, at: r.dueAt, title: r.title, project: r.projectName }))
    .sort((a, b) => a.at.localeCompare(b.at));

/** The home page's four figures, from your reviews and the workspace's summary. */
export function figures(
  reviews: MyReview[],
  summary: { openComments: number; newVersions: number },
  now = Date.now(),
) {
  const open = reviews.filter((r) => r.status === "open");
  const deadlines = deadlinesOf(reviews);
  return {
    inReview: open.length,
    yourTurn: open.filter((r) => r.yourTurn).length,
    dueThisWeek: deadlines.filter((d) => new Date(d.at).getTime() <= now + 7 * DAY_MS).length,
    overdue: deadlines.filter((d) => dueIn(d.at, now).days < 0).length,
    openComments: summary.openComments,
    newVersions: summary.newVersions,
  };
}

const outcomeCopy: Record<string, string> = {
  approved: "was approved",
  changes_requested: "had changes requested",
  submitted: "has all its feedback",
};

/** One line of activity, after the person's name where there is one. */
export function activityText(a: HomeActivity): string {
  switch (a.kind) {
    case "comment":
      return a.count > 1
        ? `left ${a.count} comments on ${a.fileName}`
        : `commented on ${a.fileName}`;
    case "version":
      return `added version ${a.number} of ${a.trackName}`;
    case "review":
      return `asked for a review: ${a.title}`;
    case "review_completed":
      return `${a.title} ${outcomeCopy[a.outcome ?? ""] ?? "finished"}`;
  }
}

/** Approved tracks as a whole percentage of those with a version; nothing to show without one. */
export const progress = (approved: number, versioned: number): number | null =>
  versioned > 0 ? Math.round((approved / versioned) * 100) : null;

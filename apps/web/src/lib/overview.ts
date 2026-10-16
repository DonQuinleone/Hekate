import { type OverviewSection, overviewSections, type TrackState } from "@hekate/shared";
import type { ReviewState } from "~/components/ui/status";
import { dueIn } from "./home";
import type { MyReview, ProjectOverview } from "./queries";

/** What a section is called on the page and in the customise menu. */
export const sectionNames = (noun: "Tracks" | "Deliverables"): Record<OverviewSection, string> => ({
  attention: "Needs attention",
  stats: "At a glance",
  tracks: noun,
  reviews: "In review",
  activity: "Activity",
  properties: "Properties",
});

/** Someone's saved order, or the default; sections that no longer exist drop out. */
export const sectionsOf = (layout: OverviewSection[] | null): OverviewSection[] =>
  layout ? layout.filter((s) => overviewSections.includes(s)) : [...overviewSections];

/** The order with one section moved a place up (-1) or down (1); unchanged at either end. */
export function moveSection(
  sections: OverviewSection[],
  id: OverviewSection,
  by: -1 | 1,
): OverviewSection[] {
  const i = sections.indexOf(id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= sections.length) return sections;
  const next = [...sections];
  [next[i], next[j]] = [next[j] as OverviewSection, next[i] as OverviewSection];
  return next;
}

/** One thing on a project's overview that wants someone's attention. */
export interface OverviewAttention {
  id: string;
  kind: "review" | "overdue" | "failed" | "qa";
  title: string;
  why: string;
  when?: string;
  urgent: boolean;
  /** The review, or the file. */
  targetId: string;
  review?: Pick<MyReview, "status" | "outcome">;
}

const firstNames = (people: { name: string }[]) =>
  people.map((p) => p.name.split(/\s+/)[0]).join(", ");

/**
 * What needs attention in one project, most pressing first: reviews where it is your turn
 * (soonest due first), reviews overdue on someone else, files that could not be processed,
 * and files that fail a quality check.
 */
export function overviewAttention(
  overview: ProjectOverview,
  mine: MyReview[],
  projectId: string,
  now = Date.now(),
): OverviewAttention[] {
  const turns = mine
    .filter((r) => r.projectId === projectId && r.yourTurn && r.status === "open")
    .sort((a, b) => (a.dueAt ?? "￿").localeCompare(b.dueAt ?? "￿"));
  const yours = new Set(turns.map((r) => r.id));
  return [
    ...turns.map((r): OverviewAttention => {
      const due = r.dueAt ? dueIn(r.dueAt, now) : null;
      return {
        id: r.id,
        kind: "review",
        title: r.title,
        why: r.kind === "approval" ? "Your decision is asked for" : "Your feedback is asked for",
        when: due?.label,
        urgent: Boolean(due && due.days < 1),
        targetId: r.id,
        review: r,
      };
    }),
    ...overview.overdue
      .filter((r) => !yours.has(r.id))
      .map(
        (r): OverviewAttention => ({
          id: `overdue-${r.id}`,
          kind: "overdue",
          title: r.title,
          why: r.waitingOn.length ? `Overdue, waiting on ${firstNames(r.waitingOn)}` : "Overdue",
          when: r.dueAt ? dueIn(r.dueAt, now).label : undefined,
          urgent: true,
          targetId: r.id,
        }),
      ),
    ...overview.failed.map(
      (f): OverviewAttention => ({
        id: `failed-${f.id}`,
        kind: "failed",
        title: `${f.name} could not be processed`,
        why: "The file needs replacing",
        urgent: true,
        targetId: f.id,
      }),
    ),
    ...overview.qaFailing.map(
      (f): OverviewAttention => ({
        id: `qa-${f.id}`,
        kind: "qa",
        title: `${f.name} fails a quality check`,
        why: f.summary,
        urgent: false,
        targetId: f.id,
      }),
    ),
  ];
}

/** How a track's standing reads, and the dot that goes with it. */
export const trackStateCopy: Record<TrackState, { label: string; dot: ReviewState | null }> = {
  no_version: { label: "No versions yet", dot: null },
  not_reviewed: { label: "Not in review", dot: null },
  in_review: { label: "In review", dot: "in_review" },
  changes_requested: { label: "Changes requested", dot: "changes_requested" },
  approved: { label: "Approved", dot: "approved" },
};

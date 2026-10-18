import { z } from "zod";

/** The sections of a project's overview, in their default order. */
export const overviewSections = [
  "attention",
  "stats",
  "tracks",
  "reviews",
  "activity",
  "properties",
] as const;
export type OverviewSection = (typeof overviewSections)[number];

/** Which sections someone shows on a project's overview, in their order. */
export const overviewLayoutInput = z
  .object({
    sections: z
      .array(z.enum(overviewSections))
      .max(overviewSections.length)
      .refine((s) => new Set(s).size === s.length, "Each section once"),
  })
  .strict();
export type OverviewLayoutInput = z.infer<typeof overviewLayoutInput>;

export const trackStates = [
  "no_version",
  "not_reviewed",
  "in_review",
  "changes_requested",
  "approved",
] as const;
export type TrackState = (typeof trackStates)[number];

/** A review's hold on a track: a specific version, or (null) whichever is latest. */
export interface TrackReviewItem {
  versionId: string | null;
  kind: "approval" | "feedback" | "share";
  status: "open" | "completed" | "cancelled";
  outcome: "approved" | "changes_requested" | "submitted" | null;
  completedAt: string | null;
}

/**
 * Where a track stands, judged on its latest version: in review while an open review covers
 * it, then as the last approval to settle on it left it. A review that follows the latest
 * covers a version only if that version was already there when it settled; a version uploaded
 * since has not been reviewed.
 */
export function trackState(
  latest: { id: string; createdAt: string } | null,
  items: TrackReviewItem[],
): TrackState {
  if (!latest) return "no_version";
  const covers = (i: TrackReviewItem) =>
    i.versionId === latest.id ||
    (i.versionId === null &&
      (i.status === "open" || (i.completedAt !== null && i.completedAt >= latest.createdAt)));
  // A share asks nothing of a track, so it never puts one in review (#138).
  const mine = items.filter((i) => i.kind !== "share" && covers(i));
  if (mine.some((i) => i.status === "open")) return "in_review";
  const settled = mine
    .filter((i) => i.kind === "approval" && i.status === "completed" && i.completedAt)
    .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))[0];
  if (settled?.outcome === "approved") return "approved";
  if (settled?.outcome === "changes_requested") return "changes_requested";
  return "not_reviewed";
}

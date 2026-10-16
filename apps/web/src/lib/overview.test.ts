import { describe, expect, it } from "vitest";
import { moveSection, overviewAttention, sectionsOf } from "./overview";
import type { MyReview, ProjectOverview } from "./queries";

const now = Date.parse("2026-10-16T12:00:00Z");
const overview = (over: Partial<ProjectOverview>): ProjectOverview => ({
  figures: {
    tracks: 0,
    versionedTracks: 0,
    approvedTracks: 0,
    files: 0,
    openReviews: 0,
    nextDueAt: null,
    openComments: null,
    processing: 0,
    members: 0,
    faces: [],
  },
  failed: [],
  qaFailing: [],
  overdue: [],
  tracks: [],
  activity: [],
  deliveryProfile: null,
  createdAt: null,
  role: null,
  layout: null,
  ...over,
});
const review = (over: Partial<MyReview>): MyReview =>
  ({
    id: "r1",
    projectId: "p1",
    projectName: "Joplin Rags",
    kind: "approval",
    title: "Album masters",
    status: "open",
    outcome: null,
    dueAt: null,
    createdAt: "2026-10-01T00:00:00Z",
    submittedAt: null,
    yourTurn: true,
    ...over,
  }) as MyReview;

describe("overviewAttention", () => {
  it("puts your turns first, then overdue reviews, failed files and failing checks", () => {
    const items = overviewAttention(
      overview({
        overdue: [
          {
            id: "r2",
            title: "Mix notes",
            dueAt: "2026-10-14T12:00:00Z",
            waitingOn: [{ id: "u", name: "Mira Solberg" }],
          },
        ],
        failed: [{ id: "f1", name: "Cut 3.mp4" }],
        qaFailing: [{ id: "f2", name: "Master.wav", summary: "True peak above -1 dBTP" }],
      }),
      [review({ dueAt: "2026-10-16T09:00:00Z" }), review({ id: "r9", projectId: "p2" })],
      "p1",
      now,
    );
    expect(items.map((i) => [i.kind, i.title])).toEqual([
      ["review", "Album masters"],
      ["overdue", "Mix notes"],
      ["failed", "Cut 3.mp4 could not be processed"],
      ["qa", "Master.wav fails a quality check"],
    ]);
    expect(items[0]).toMatchObject({ when: "due today", urgent: true });
    expect(items[1]?.why).toBe("Overdue, waiting on Mira");
  });

  it("does not list a review twice when it is both yours and overdue", () => {
    const items = overviewAttention(
      overview({ overdue: [{ id: "r1", title: "Album masters", dueAt: null, waitingOn: [] }] }),
      [review({})],
      "p1",
      now,
    );
    expect(items).toHaveLength(1);
  });
});

describe("sections", () => {
  it("defaults to every section, and keeps a saved order", () => {
    expect(sectionsOf(null)).toHaveLength(6);
    expect(sectionsOf(["tracks", "attention"])).toEqual(["tracks", "attention"]);
  });

  it("moves a section a place, and not past either end", () => {
    expect(moveSection(["attention", "stats", "tracks"], "tracks", -1)).toEqual([
      "attention",
      "tracks",
      "stats",
    ]);
    expect(moveSection(["attention", "stats"], "attention", -1)).toEqual(["attention", "stats"]);
  });
});

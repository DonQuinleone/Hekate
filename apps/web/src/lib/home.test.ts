import { describe, expect, it } from "vitest";
import {
  activityText,
  attentionFor,
  deadlinesOf,
  dueIn,
  figures,
  greeting,
  progress,
} from "./home";
import type { MyReview } from "./queries";

const now = new Date("2026-10-15T12:00:00.000Z").getTime();
const review = (over: Partial<MyReview>): MyReview => ({
  id: "r",
  projectId: "p",
  projectName: "Joplin Rags",
  kind: "approval",
  title: "Album masters",
  status: "open",
  outcome: null,
  dueAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  submittedAt: null,
  yourTurn: false,
  ...over,
});

describe("home", () => {
  it("says how long until a date", () => {
    expect(dueIn("2026-10-18T12:00:00.000Z", now)).toEqual({ days: 3, label: "3 days" });
    expect(dueIn("2026-10-16T11:00:00.000Z", now)).toEqual({ days: 1, label: "1 day" });
    expect(dueIn("2026-10-15T08:00:00.000Z", now).label).toBe("due today");
    expect(dueIn("2026-10-13T08:00:00.000Z", now).label).toBe("2 days overdue");
  });

  it("greets by the time of day", () => {
    expect(greeting(8)).toBe("Good morning");
    expect(greeting(12)).toBe("Good afternoon");
    expect(greeting(19)).toBe("Good evening");
  });

  it("lists your turns, soonest due first, then failed files", () => {
    const list = attentionFor(
      [
        review({ id: "a", yourTurn: true }),
        review({ id: "b", yourTurn: true, kind: "feedback", dueAt: "2026-10-15T18:00:00.000Z" }),
        review({ id: "c", yourTurn: false, dueAt: "2026-10-14T00:00:00.000Z" }),
        review({ id: "d", yourTurn: true, status: "completed" }),
      ],
      [{ id: "f", name: "Bethena.wav" }],
      now,
    );
    expect(list.map((a) => a.id)).toEqual(["b", "a", "f"]);
    expect(list[0]).toMatchObject({
      why: "Your feedback is asked for in Joplin Rags",
      when: "1 day",
      urgent: false,
    });
    expect(list[1]?.why).toBe("Your decision is asked for in Joplin Rags");
    expect(list[2]).toMatchObject({ kind: "failed", urgent: true });
  });

  it("counts the week's deadlines and those overdue", () => {
    const reviews = [
      review({ id: "a", dueAt: "2026-10-13T00:00:00.000Z", yourTurn: true }),
      review({ id: "b", dueAt: "2026-10-20T00:00:00.000Z" }),
      review({ id: "c", dueAt: "2026-11-30T00:00:00.000Z" }),
      review({ id: "d", status: "completed", dueAt: "2026-10-16T00:00:00.000Z" }),
    ];
    expect(deadlinesOf(reviews).map((d) => d.id)).toEqual(["a", "b", "c"]);
    expect(figures(reviews, { openComments: 4, newVersions: 2 }, now)).toEqual({
      inReview: 3,
      yourTurn: 1,
      dueThisWeek: 2,
      overdue: 1,
      openComments: 4,
      newVersions: 2,
    });
  });

  it("describes what happened", () => {
    const base = { id: "x", at: "", who: null, projectId: "p" };
    const said = { ...base, kind: "comment" as const, fileId: "f", fileName: "Mix.wav" };
    expect(activityText({ ...said, count: 1 })).toBe("commented on Mix.wav");
    expect(activityText({ ...said, count: 4 })).toBe("left 4 comments on Mix.wav");
    expect(
      activityText({ ...base, kind: "version", trackId: "t", trackName: "Bethena", number: 3 }),
    ).toBe("added version 3 of Bethena");
    expect(
      activityText({
        ...base,
        kind: "review_completed",
        reviewId: "r",
        title: "Masters",
        outcome: "approved",
      }),
    ).toBe("Masters was approved");
  });

  it("shows progress only once a track has a version", () => {
    expect(progress(0, 0)).toBeNull();
    expect(progress(1, 3)).toBe(33);
  });
});

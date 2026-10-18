import { describe, expect, it } from "vitest";
import { inboxLists } from "./inbox";
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

describe("inboxLists", () => {
  it("sorts reviews into what needs you, what you follow and what is done", () => {
    const lists = inboxLists(
      [
        review({ id: "turn-late", yourTurn: true }),
        review({
          id: "turn-soon",
          yourTurn: true,
          kind: "feedback",
          dueAt: "2026-10-14T00:00:00Z",
        }),
        review({ id: "others", submittedAt: "2026-10-10T00:00:00Z" }),
        review({ id: "old", status: "completed", outcome: "approved" }),
        review({
          id: "new",
          status: "cancelled",
          createdAt: "2026-10-12T00:00:00.000Z",
        }),
      ],
      [{ id: "f", name: "Bethena.wav" }],
      now,
    );
    expect(lists.needs.map((i) => i.id)).toEqual(["turn-soon", "turn-late", "f"]);
    expect(lists.needs[0]).toMatchObject({
      detail: "Your feedback · Joplin Rags · 1 day overdue",
      urgent: true,
    });
    expect(lists.following.map((i) => i.detail)).toEqual(["You have responded · Joplin Rags"]);
    expect(lists.done.map((i) => [i.id, i.detail])).toEqual([
      ["new", "Cancelled · Joplin Rags"],
      ["old", "Approved · Joplin Rags"],
    ]);
  });

  it("follows a share without asking anything of you (#138)", () => {
    const lists = inboxLists(
      [
        review({ id: "shared", kind: "share" }),
        review({ id: "stopped", kind: "share", status: "cancelled" }),
      ],
      [],
      now,
    );
    expect(lists.needs).toEqual([]);
    expect(lists.following.map((i) => i.detail)).toEqual(["Shared with you · Joplin Rags"]);
    expect(lists.done.map((i) => i.detail)).toEqual(["No longer shared · Joplin Rags"]);
  });
});

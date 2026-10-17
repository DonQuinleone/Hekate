import { describe, expect, it } from "vitest";
import { ago, historyLabel, passageLoop, threadsOf } from "./comments";
import type { Comment } from "./queries";

const comment = (id: string, extra: Partial<Comment> = {}): Comment => ({
  id,
  fileId: "f",
  parentId: null,
  anchor: null,
  body: id,
  authorId: null,
  authorName: null,
  authorGuest: false,
  authorLabel: null,
  resolvedAt: null,
  categoryId: null,
  deferredTo: null,
  assigneeId: null,
  assigneeName: null,
  resolvedByName: null,
  editedAt: null,
  createdAt: "2026-10-14T10:00:00.000Z",
  carry: null,
  history: null,
  mentions: [],
  todo: false,
  todoDoneAt: null,
  todoDoneByName: null,
  ...extra,
});

describe("comment threads", () => {
  it("orders open threads by where they point, keeps replies, and sets resolved apart", () => {
    const { open, resolved } = threadsOf([
      comment("late", { anchor: { kind: "time", start: 90, end: 90 } }),
      comment("whole"),
      comment("early", { anchor: { kind: "time", start: 5, end: 8 } }),
      comment("reply", { parentId: "late", createdAt: "2026-10-14T11:00:00.000Z" }),
      comment("done", {
        anchor: { kind: "time", start: 1, end: 1 },
        resolvedAt: "2026-10-14T12:00:00.000Z",
      }),
    ]);
    expect(open.map((t) => t.comment.id)).toEqual(["early", "late", "whole"]);
    expect(open[1]?.replies.map((r) => r.id)).toEqual(["reply"]);
    expect(resolved.map((t) => t.comment.id)).toEqual(["done"]);
  });

  it("shows a reply on its own when its thread is not shown", () => {
    const { open } = threadsOf([comment("mine", { parentId: "unseen" })]);
    expect(open.map((t) => t.comment.id)).toEqual(["mine"]);
  });

  it("keeps threads hidden on this version apart", () => {
    const carry = (visible: boolean) => ({
      id: "k",
      status: "open" as const,
      visible,
      from: { fileId: "earlier", anchor: null },
    });
    const { open, hidden } = threadsOf([
      comment("shown", { carry: carry(true) }),
      comment("hidden", { carry: carry(false) }),
      comment("here"),
    ]);
    expect(open.map((t) => t.comment.id)).toEqual(["shown", "here"]);
    expect(hidden.map((t) => t.comment.id)).toEqual(["hidden"]);
  });

  it("tells a thread's path through the versions", () => {
    expect(historyLabel(null)).toBeNull();
    expect(historyLabel({ versionNumber: 2, hops: [] })).toBeNull();
    expect(
      historyLabel({
        versionNumber: 2,
        hops: [
          { fileId: "a", versionNumber: 3, status: "not_fixed", moved: false },
          { fileId: "b", versionNumber: 4, status: "open", moved: true },
        ],
      }),
    ).toBe("V2 → V3, not fixed → V4, moved by hand");
  });

  it("plays a passage with a second either side, within the file", () => {
    expect(passageLoop({ start: 10, end: 12 })).toEqual({ start: 9, end: 13 });
    expect(passageLoop({ start: 0.4, end: 59.5 }, 60)).toEqual({ start: 0, end: 60 });
  });

  it("says how long ago, in plain words", () => {
    const now = Date.parse("2026-10-14T12:00:00.000Z");
    expect(ago("2026-10-14T11:59:50.000Z", now)).toBe("just now");
    expect(ago("2026-10-14T11:55:00.000Z", now)).toBe("5 minutes ago");
    expect(ago("2026-10-13T12:00:00.000Z", now)).toBe("yesterday");
  });
});

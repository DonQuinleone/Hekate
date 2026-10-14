import { describe, expect, it } from "vitest";
import { ago, threadsOf } from "./comments";
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
  resolvedByName: null,
  editedAt: null,
  createdAt: "2026-10-14T10:00:00.000Z",
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

  it("says how long ago, in plain words", () => {
    const now = Date.parse("2026-10-14T12:00:00.000Z");
    expect(ago("2026-10-14T11:59:50.000Z", now)).toBe("just now");
    expect(ago("2026-10-14T11:55:00.000Z", now)).toBe("5 minutes ago");
    expect(ago("2026-10-13T12:00:00.000Z", now)).toBe("yesterday");
  });
});

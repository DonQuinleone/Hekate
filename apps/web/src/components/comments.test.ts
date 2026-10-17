import type { Anchor } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import type { Comment } from "~/lib/queries";
import { regionMarkers } from "./comments";

const comment = (id: string, anchor: Anchor | null, extra: Partial<Comment> = {}): Comment => ({
  id,
  fileId: "file",
  parentId: null,
  anchor,
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
  createdAt: "2026-10-14T12:00:00Z",
  carry: null,
  history: null,
  mentions: [],
  todo: false,
  todoDoneAt: null,
  todoDoneByName: null,
  ...extra,
});

const region = (page: number, x = 0.1): Anchor => ({
  kind: "region",
  page,
  x,
  y: 0.2,
  width: 0.3,
  height: 0.1,
});

describe("region markers", () => {
  it("numbers the open threads on parts of pages in reading order, as the list shows them", () => {
    const markers = regionMarkers([
      comment("a", region(2)),
      comment("whole-page", { kind: "region", page: 1, x: 0, y: 0, width: 1, height: 1 }),
      comment("timed", { kind: "time", start: 3, end: 3 }),
      comment("reply", region(2), { parentId: "a" }),
      comment("settled", region(1), { resolvedAt: "2026-10-14T13:00:00Z" }),
      comment("b", region(1, 0.5)),
    ]);
    expect(markers.map((m) => [m.id, m.n, m.page])).toEqual([
      ["b", 1, 1],
      ["a", 2, 2],
    ]);
    expect(markers[0]?.rect).toEqual({ x: 0.5, y: 0.2, width: 0.3, height: 0.1 });
  });
});

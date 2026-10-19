import type { Anchor } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import type { Comment } from "~/lib/queries";
import { commentMarkers, regionMarkers } from "./comments";

const comment = (id: string, anchor: Anchor | null, extra: Partial<Comment> = {}): Comment => ({
  id,
  fileId: "file",
  parentId: null,
  anchor,
  body: id,
  authorId: null,
  authorName: null,
  authorGuest: false,
  mine: false,
  takes: [],
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
  attachments: [],
  todo: false,
  taskId: null,
  todoDoneAt: null,
  todoDoneByName: null,
  channel: null,
  importedFrom: null,
  importedByName: null,
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

describe("timeline markers", () => {
  const at = (start: number): Anchor => ({ kind: "time", start, end: start });
  it("marks each moment once, with the most pressing of its threads", () => {
    const markers = commentMarkers([
      comment("open", at(4)),
      comment("task", at(4), { todo: true }),
      comment("done task", at(9), { todo: true, todoDoneAt: "2026-10-14T13:00:00Z" }),
      comment("assigned", at(12), { assigneeId: "someone" }),
      comment("later", at(20), { deferredTo: "mastering" }),
      comment("settled", at(30), { resolvedAt: "2026-10-14T13:00:00Z" }),
      comment("reply", at(40), { parentId: "open" }),
      comment("page", region(1)),
    ]);
    expect(markers).toEqual([
      { at: 4, state: "todo" },
      { at: 9, state: "open" },
      { at: 12, state: "todo" },
      { at: 20, state: "deferred" },
    ]);
  });
});

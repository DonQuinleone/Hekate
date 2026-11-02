import { describe, expect, it } from "vitest";
import { fitTrail, trailPlans } from "./trail";

const widths = (available: number, crumbs: number[], title: number) => ({
  available,
  crumbs,
  title,
  more: 28,
  gap: 6,
});

describe("a breadcrumb trail (#547)", () => {
  it("shows every crumb whole while they fit", () => {
    expect(fitTrail(widths(600, [120, 160], 240))).toEqual({ shown: [0, 1], folded: [] });
  });

  it("folds the middle first, keeping the first crumb and the one above the page", () => {
    // Joplin Rags / Maple Leaf Rag / Recordings / Maple Leaf Rag - Dry.wav
    const w = widths(560, [100, 140, 110], 260);
    expect(fitTrail(w)).toEqual({ shown: [0, 2], folded: [1] });
  });

  it("then folds everything after the first, and gives the page's name the rest", () => {
    const w = widths(420, [100, 140, 110], 260);
    expect(fitTrail(w)).toEqual({ shown: [0], folded: [1, 2] });
  });

  it("never drops the first crumb, cutting the page's name only as a last resort", () => {
    const w = widths(200, [100, 140], 400);
    expect(fitTrail(w)).toEqual({ shown: [0], folded: [1] });
    expect(fitTrail(widths(100, [90], 400))).toEqual({ shown: [0], folded: [] });
  });

  it("tries the plans from the whole trail to the most folded", () => {
    expect(trailPlans(0)).toEqual([{ shown: [], folded: [] }]);
    expect(trailPlans(4).map((p) => p.shown)).toEqual([[0, 1, 2, 3], [0, 3], [0]]);
  });
});

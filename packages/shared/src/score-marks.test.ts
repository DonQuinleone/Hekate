import { describe, expect, it } from "vitest";
import {
  editLabel,
  editPlot,
  readingOrder,
  scoreMarkInput,
  scoreMarksCsv,
  takeList,
  typedNumber,
} from "./score-marks.ts";

const edit = (id: string, page: number, y: number, from: number | null, to: number, more = {}) => ({
  id,
  kind: "edit" as const,
  page,
  x: 0.5,
  y,
  from,
  to,
  overdub: false,
  barFrom: null,
  ...more,
});

describe("editLabel", () => {
  it("writes an edit point as the plot is written", () => {
    expect(editLabel({ from: null, to: 3, barFrom: 1, overdub: false })).toBe("T3");
    expect(editLabel({ from: 12, to: 7, barFrom: 3, overdub: false })).toBe("3T12 into T7");
    expect(editLabel({ from: 7, to: 9, barFrom: 36, overdub: true })).toBe("T9 over 36T7");
  });
});

describe("readingOrder", () => {
  it("reads page by page, down each page, and across a system", () => {
    const marks = [
      { id: "c", page: 2, x: 0.1, y: 0.1 },
      { id: "b", page: 1, x: 0.8, y: 0.5 },
      { id: "a", page: 1, x: 0.2, y: 0.51 },
      { id: "first", page: 1, x: 0.9, y: 0.1 },
    ];
    expect(readingOrder(marks).map((m) => m.id)).toEqual(["first", "a", "b", "c"]);
  });
});

describe("editPlot", () => {
  const recorded = new Set([3, 7, 9, 12]);

  it("follows the chain from lead-in to final take", () => {
    const plot = editPlot(
      [edit("lead", 1, 0.1, null, 3), edit("b", 1, 0.6, 3, 12), edit("c", 2, 0.2, 12, 7)],
      recorded,
    );
    expect(plot).toEqual({ chain: [3, 12, 7], problems: [] });
  });

  it("finds a hand-over from the wrong take, a missing lead-in and a take never recorded", () => {
    expect(editPlot([edit("b", 1, 0.5, 3, 12)], recorded).problems).toEqual([
      { markId: "b", text: "page 1: the plot has no lead-in before it" },
    ]);
    const broken = editPlot(
      [
        edit("lead", 1, 0.1, null, 3),
        edit("b", 1, 0.5, 12, 7, { barFrom: 17 }),
        edit("c", 2, 0.1, 7, 40, { barFrom: 36 }),
      ],
      recorded,
    );
    expect(broken.problems).toEqual([
      { markId: "b", text: "bar 17: hands over from T12, but the plot is in T3" },
      { markId: "c", text: "bar 36: take 40 was not recorded" },
    ]);
    expect(broken.chain).toEqual([3, 7, 40]);
  });

  it("lets an overdub lie over the chain without breaking it", () => {
    const plot = editPlot(
      [
        edit("lead", 1, 0.1, null, 3),
        edit("over", 1, 0.3, 3, 9, { overdub: true }),
        edit("b", 1, 0.6, 3, 7),
      ],
      recorded,
    );
    expect(plot).toEqual({ chain: [3, 7], problems: [] });
  });

  it("has nothing to check without edit points", () => {
    expect(editPlot([], recorded)).toEqual({ chain: [], problems: [] });
  });
});

describe("scoreMarkInput", () => {
  it("takes each kind with what it needs, and refuses one without", () => {
    const at = { page: 1, x: 0.5, y: 0.5 };
    expect(scoreMarkInput.safeParse({ ...at, kind: "edit", from: 3, to: 7 }).success).toBe(true);
    expect(scoreMarkInput.safeParse({ ...at, kind: "edit" }).success).toBe(false);
    expect(scoreMarkInput.safeParse({ ...at, kind: "dynamic", text: "mp" }).success).toBe(true);
    expect(scoreMarkInput.safeParse({ ...at, kind: "dynamic" }).success).toBe(false);
    expect(scoreMarkInput.safeParse({ ...at, kind: "take-start", to: 4 }).success).toBe(true);
    expect(scoreMarkInput.safeParse({ ...at, kind: "ink", points: [[0.1, 0.1]] }).success).toBe(
      false,
    );
    expect(
      scoreMarkInput.safeParse({ ...at, kind: "issue", x: 0.8, width: 0.4, height: 0.1 }).success,
    ).toBe(false);
    expect(scoreMarkInput.safeParse({ ...at, kind: "issue", barFrom: 9, barTo: 5 }).success).toBe(
      false,
    );
  });
});

describe("takeList", () => {
  it("reads takes typed as a list", () => {
    expect(takeList("T3, 7 12")).toEqual([3, 7, 12]);
    expect(takeList("3,3")).toEqual([3]);
    expect(takeList("")).toEqual([]);
    expect(takeList("T3, twelve")).toBeNull();
    expect(takeList("0")).toBeNull();
  });
});

describe("scoreMarksCsv", () => {
  const base = {
    width: null,
    height: null,
    points: null,
    barTo: null,
    categoryId: null,
    takes: [],
    fixedBy: null,
    resolved: false,
    from: null,
    to: null,
    overdub: false,
    by: null,
    createdAt: "2026-10-14T14:00:00Z",
  };
  it("lists the marks in reading order, an edit as the plot writes it", () => {
    const csv = scoreMarksCsv(
      [
        {
          ...base,
          id: "b",
          kind: "edit",
          page: 1,
          x: 0.5,
          y: 0.6,
          barFrom: 17,
          text: null,
          from: 12,
          to: 7,
        },
        {
          ...base,
          id: "a",
          kind: "issue",
          page: 1,
          x: 0.2,
          y: 0.2,
          barFrom: 5,
          barTo: 6,
          text: "=Pedal, noise",
          categoryId: "noise",
          takes: [3, 7],
          fixedBy: 12,
          resolved: true,
        },
      ],
      [{ id: "noise", name: "Noise" }],
    );
    expect(csv.split("\r\n")).toEqual([
      "Page,Bars,Kind,Category,Text,Takes,Fixed by,Status",
      `1,5–6,Issue,Noise,"'=Pedal, noise",T3 T7,T12,Resolved`,
      "1,17,Edit point,,17T12 into T7,,,",
      "",
    ]);
  });
});

describe("typedNumber", () => {
  it("reads a take or a bar whole, and refuses half a number", () => {
    expect(typedNumber("T12", true)).toBe(12);
    expect(typedNumber(" 7 ", true)).toBe(7);
    expect(typedNumber("", true)).toBeNull();
    expect(typedNumber("T12abc", true)).toBeUndefined();
    expect(typedNumber("3.5")).toBeUndefined();
    expect(typedNumber("17bars")).toBeUndefined();
    expect(typedNumber("T0", true)).toBeUndefined();
    expect(typedNumber("T3")).toBeUndefined();
    expect(typedNumber("0")).toBe(0);
  });
});

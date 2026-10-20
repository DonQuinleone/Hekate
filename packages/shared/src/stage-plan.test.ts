import { describe, expect, it } from "vitest";
import {
  align,
  applyEdit,
  boundsOf,
  inMarquee,
  inverseOf,
  moveBy,
  type StageItem,
  shownLabel,
  snapTo,
  stageEditInput,
  stageItemChange,
  stageItemInput,
} from "./stage-plan.ts";

const id = (n: number) => `0192f3a0-0000-7000-8000-00000000000${n}`;

const item = (n: number, over: Partial<StageItem> = {}): StageItem => ({
  id: id(n),
  kind: "rect",
  label: "",
  x: 0,
  y: 0,
  w: 1,
  h: 1,
  rotation: 0,
  patchRowId: null,
  personnelId: null,
  group: "",
  ...over,
});

describe("stage plan steps", () => {
  const before = [item(1, { x: 1 }), item(2, { x: 4, label: "Riser" }), item(3)];
  const edit = {
    add: [item(4, { kind: "mic", x: 6 })],
    change: [{ id: id(2), x: 5, label: "Choir riser" }],
    remove: [id(3)],
  };

  it("adds, changes and removes in one step", () => {
    const after = applyEdit(before, edit);
    expect(after.map((i) => i.id)).toEqual([id(1), id(2), id(4)]);
    expect(after[1]).toMatchObject({ x: 5, label: "Choir riser" });
  });

  it("is taken back by its inverse, the removed item restored as it was", () => {
    const after = applyEdit(before, edit);
    const back = inverseOf(before, edit);
    expect(back).toEqual({
      add: [before[2]],
      change: [{ id: id(2), x: 4, label: "Riser" }],
      remove: [id(4)],
    });
    expect(applyEdit(after, back).sort((a, b) => a.id.localeCompare(b.id))).toEqual(before);
  });

  it("does not add an item twice, nor bring back one it removes", () => {
    expect(applyEdit(before, { add: [item(1, { x: 9 })], change: [], remove: [] })).toEqual(before);
  });
});

describe("placing on the plan", () => {
  it("snaps to the grid, to the centimetre", () => {
    expect(snapTo(1.26, 0.5)).toBe(1.5);
    expect(snapTo(1.24, 0.5)).toBe(1);
    expect(snapTo(0.31, 0.1)).toBe(0.3);
  });

  it("bounds round kinds about their centre and cables either way", () => {
    expect(boundsOf(item(1, { kind: "mic", x: 2, y: 2, w: 0.4, h: 0.4 }))).toEqual({
      left: 1.8,
      top: 1.8,
      right: 2.2,
      bottom: 2.2,
    });
    expect(boundsOf(item(1, { kind: "cable", x: 3, y: 2, w: -2, h: 1 }))).toEqual({
      left: 1,
      top: 2,
      right: 3,
      bottom: 3,
    });
  });

  it("picks what a marquee touches, drawn either way", () => {
    const items = [item(1, { x: 0 }), item(2, { x: 3 }), item(3, { x: 6 })];
    expect(inMarquee(items, { left: 3.5, top: 0.5, right: 0.5, bottom: 0.6 })).toEqual([
      id(1),
      id(2),
    ]);
  });

  it("moves a selection as one", () => {
    const items = [item(1, { x: 1, y: 1 }), item(2, { x: 2 }), item(3)];
    expect(moveBy(items, [id(1), id(2)], 0.5, -0.25).change).toEqual([
      { id: id(1), x: 1.5, y: 0.75 },
      { id: id(2), x: 2.5, y: -0.25 },
    ]);
  });
});

describe("aligning", () => {
  const items = [
    item(1, { x: 1, y: 1, w: 1 }),
    item(2, { x: 3, y: 2, w: 2 }),
    item(3, { kind: "mic", x: 8, y: 4, w: 0.4, h: 0.4 }),
  ];

  it("lines items up on the selection's edges", () => {
    expect(align(items, [id(1), id(2), id(3)], "left", 12).change).toEqual([
      { id: id(2), x: 1, y: 2 },
      { id: id(3), x: 1.2, y: 4 },
    ]);
    expect(align(items, [id(1), id(2)], "right", 12).change).toEqual([{ id: id(1), x: 4, y: 1 }]);
  });

  it("centres them on the selection's centre line", () => {
    expect(align(items, [id(1), id(2)], "centre", 12).change).toEqual([
      { id: id(1), x: 2.5, y: 1 },
      { id: id(2), x: 2, y: 2 },
    ]);
    expect(align(items, [id(1), id(2)], "middle", 12).change).toEqual([
      { id: id(1), x: 1, y: 1.5 },
      { id: id(2), x: 3, y: 1.5 },
    ]);
  });

  it("needs two to line up, but centres even one on the stage", () => {
    expect(align(items, [id(1)], "left", 12).change).toEqual([]);
    expect(align(items, [id(1)], "stage-centre", 12).change).toEqual([{ id: id(1), x: 5.5, y: 1 }]);
  });
});

describe("what is sent", () => {
  it("takes an item with defaults, sized unless it is a cable", () => {
    expect(stageItemInput.parse({ id: id(1), kind: "mic", x: 1, y: 2, w: 0.3, h: 0.3 })).toEqual({
      id: id(1),
      kind: "mic",
      label: "",
      x: 1,
      y: 2,
      w: 0.3,
      h: 0.3,
      rotation: 0,
      patchRowId: null,
      personnelId: null,
      group: "",
    });
    expect(
      stageItemInput.safeParse({ id: id(1), kind: "rect", x: 0, y: 0, w: 0, h: 1 }).success,
    ).toBe(false);
    expect(
      stageItemInput.safeParse({ id: id(1), kind: "cable", x: 0, y: 0, w: -3, h: 0 }).success,
    ).toBe(true);
    expect(
      stageItemInput.safeParse({ id: id(1), kind: "Bad kind", x: 0, y: 0, w: 1, h: 1 }).success,
    ).toBe(false);
  });

  it("refuses a change of nothing and a step of nothing", () => {
    expect(stageItemChange.safeParse({ id: id(1) }).success).toBe(false);
    expect(stageEditInput.safeParse({}).success).toBe(false);
  });

  it("labels a linked item by its channel's source", () => {
    const channel = {
      id: id(9),
      box: "Stage box A",
      direction: "input" as const,
      channel: 3,
      source: "Main L",
    };
    expect(shownLabel({ kind: "mic", label: "Spot" }, channel)).toBe("Main L");
    expect(shownLabel({ kind: "mic", label: "Spot" })).toBe("Spot");
    expect(shownLabel({ kind: "mic", label: "" })).toBe("Microphone");
    expect(shownLabel({ kind: "lectern", label: "" })).toBe("lectern");
    expect(
      shownLabel({ kind: "ensemble", label: "Strings" }, undefined, {
        name: "Endless Hall Strings",
      }),
    ).toBe("Endless Hall Strings");
  });
});

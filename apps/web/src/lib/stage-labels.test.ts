import { describe, expect, it } from "vitest";
import { labelSides } from "./stage-labels";

describe("labelSides (#570)", () => {
  it("keeps a label at the right of its mark where nothing stands there", () => {
    const sides = labelSides([{ id: "a", x: 2, y: 2, label: "Main L" }], 40);
    expect(sides.get("a")).toBe("right");
  });
  it("moves a label that would run into the next mark to the left", () => {
    // Spot piano L at 4.8 m, Spot piano R at 6.6 m: at 40 px a metre, 72 px apart.
    const marks = [
      { id: "l", x: 4.8, y: 1.6, label: "Spot piano L" },
      { id: "r", x: 6.6, y: 1.4, label: "Spot piano R" },
    ];
    const sides = labelSides(marks, 40);
    expect(sides.get("l")).toBe("left");
    expect(sides.get("r")).toBe("right");
  });
  it("puts a label under its mark when both sides are taken, and gives none without a label", () => {
    const marks = [
      { id: "m", x: 5, y: 5, label: "Middle" },
      { id: "w", x: 4.4, y: 5, label: null },
      { id: "e", x: 5.6, y: 5, label: null },
    ];
    const sides = labelSides(marks, 40);
    expect(sides.get("m")).toBe("below");
    expect(sides.has("w")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  clampPage,
  drawsWith,
  regionFromDrag,
  regionFromPress,
  zoomLabel,
  zoomStep,
} from "./pages";

describe("drawing a region by touch (#150)", () => {
  it("draws with a mouse or a pen always, and with a finger only while drawing is on", () => {
    expect(drawsWith("mouse", false)).toBe(true);
    expect(drawsWith("pen", false)).toBe(true);
    expect(drawsWith("touch", false)).toBe(false);
    expect(drawsWith("touch", true)).toBe(true);
  });

  it("takes a drag for its rectangle, whatever corner was set", () => {
    expect(regionFromPress({ x: 0.9, y: 0.9 }, { x: 0.1, y: 0.2 }, { x: 0.4, y: 0.5 })).toEqual({
      draft: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 },
      corner: null,
    });
  });

  it("takes two taps for opposite corners, in either order", () => {
    const first = regionFromPress(null, { x: 0.6, y: 0.7 }, { x: 0.6, y: 0.7 });
    expect(first).toEqual({ draft: null, corner: { x: 0.6, y: 0.7 } });
    expect(regionFromPress(first.corner, { x: 0.2, y: 0.25 }, { x: 0.2, y: 0.25 })).toEqual({
      draft: { x: 0.2, y: 0.25, width: 0.4, height: 0.45 },
      corner: null,
    });
  });

  it("moves the corner when the second tap is too close to make a region, and keeps it on the page", () => {
    expect(regionFromPress({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.9 }, { x: 0.5, y: 0.9 })).toEqual({
      draft: null,
      corner: { x: 0.5, y: 0.9 },
    });
    expect(regionFromPress(null, { x: 1.2, y: -0.1 }, { x: 1.2, y: -0.1 }).corner).toEqual({
      x: 1,
      y: 0,
    });
  });
});

describe("document viewer", () => {
  it("zooms in and out by steps, and stops at the ends", () => {
    expect(zoomStep(1, 1)).toBe(1.5);
    expect(zoomStep(1.5, -1)).toBe(1);
    expect(zoomStep(1, -1)).toBe(1);
    expect(zoomStep(4, 1)).toBe(4);
    expect(zoomLabel(1)).toBe("Fit");
    expect(zoomLabel(2)).toBe("200%");
  });

  it("keeps the page within the document", () => {
    expect(clampPage(0, 12)).toBe(1);
    expect(clampPage(13, 12)).toBe(12);
    expect(clampPage(3, 0)).toBe(1);
  });
});

describe("regions", () => {
  it("draws a region in any direction, kept on the page", () => {
    expect(regionFromDrag({ x: 0.6, y: 0.5 }, { x: 0.2, y: 0.1 })).toEqual({
      x: 0.2,
      y: 0.1,
      width: 0.4,
      height: 0.4,
    });
    const edge = regionFromDrag({ x: 0.8, y: 0.9 }, { x: 1.3, y: 1.2 });
    expect(edge?.x).toBe(0.8);
    expect(edge?.width).toBeCloseTo(0.2, 6);
    expect(edge?.height).toBeCloseTo(0.1, 6);
    expect((edge?.x ?? 0) + (edge?.width ?? 0)).toBeLessThanOrEqual(1);
    expect((edge?.y ?? 0) + (edge?.height ?? 0)).toBeLessThanOrEqual(1);
  });

  it("takes a small drag for a click", () => {
    expect(regionFromDrag({ x: 0.5, y: 0.5 }, { x: 0.505, y: 0.6 })).toBeNull();
  });
});

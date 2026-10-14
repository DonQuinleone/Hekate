import { describe, expect, it } from "vitest";
import { clampPage, zoomLabel, zoomStep } from "./pages";

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

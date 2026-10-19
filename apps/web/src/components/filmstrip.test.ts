import { describe, expect, it } from "vitest";
import { coverFrame } from "./filmstrip";

describe("a filmstrip's frames (#16)", () => {
  it("fills a cell narrower than a wide frame by its height, its frame in the middle", () => {
    // Twelve 160 × 90 frames in a 60 × 48 cell: scaled to 48 high, each frame 85⅓ wide.
    const fit = coverFrame({ width: 1920, height: 90 }, 12, { width: 60, height: 48 }, 0);
    expect(fit.height).toBeCloseTo(48);
    expect(fit.width).toBeCloseTo(1024);
    expect(fit.left).toBeCloseTo(30 - 85.333 / 2, 2);
    expect(fit.top).toBeCloseTo(0);
  });

  it("fills a cell wider than a tall frame by its width, never showing the next one", () => {
    // Twelve 50 × 90 frames in a 60 × 48 cell: scaled to 60 wide, 108 high, centred.
    const fit = coverFrame({ width: 600, height: 90 }, 12, { width: 60, height: 48 }, 3);
    const frame = fit.width / 12;
    expect(frame).toBeCloseTo(60);
    expect(fit.height).toBeCloseTo(108);
    expect(fit.top).toBeCloseTo(-30);
    // The fourth frame lies exactly over the cell.
    expect(fit.left + 3 * frame).toBeCloseTo(0);
  });
});

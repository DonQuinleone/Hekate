import { describe, expect, it } from "vitest";
import {
  anchoredScroll,
  followScroll,
  MAX_ZOOM,
  maxZoom,
  panScroll,
  zoomLabel,
  zoomStep,
} from "./zoom";

describe("zooming the waveform (#34)", () => {
  it("zooms until each pixel has a peak of its own, and no further", () => {
    // 40 s at 44.1 kHz: 6,890 peaks of 256 samples; 900 pixels wide takes 4× (3,600).
    expect(maxZoom(40, 44_100, 900)).toBe(4);
    // A long file stops at the widest zoom offered.
    expect(maxZoom(3_600, 48_000, 900)).toBe(MAX_ZOOM);
    // Too short to zoom at all, or nothing known yet.
    expect(maxZoom(1, 48_000, 900)).toBe(1);
    expect(maxZoom(0, 48_000, 900)).toBe(1);
    expect(maxZoom(40, 44_100, 0)).toBe(1);
  });

  it("doubles and halves within the file's range", () => {
    expect(zoomStep(1, 1, 8)).toBe(2);
    expect(zoomStep(8, 1, 8)).toBe(8);
    expect(zoomStep(2, -1, 8)).toBe(1);
    expect(zoomStep(1, -1, 8)).toBe(1);
    expect(zoomLabel(1)).toBe("Fit");
    expect(zoomLabel(4)).toBe("4×");
  });

  it("keeps the moment under the anchor where it was", () => {
    // At 1×, 300 px into a 900 px view; at 2× that moment is 600 px in, so scroll 300.
    expect(anchoredScroll(0, 300, 1, 2)).toBe(300);
    // Zooming back out returns.
    expect(anchoredScroll(300, 300, 2, 1)).toBe(0);
  });

  it("brings the playhead back a page at a time, and leaves it alone in view", () => {
    expect(followScroll(0, 900, 3_600, 450)).toBeNull();
    expect(followScroll(0, 900, 3_600, 900)).toBe(810);
    expect(followScroll(1_800, 900, 3_600, 100)).toBe(10);
    // Never past the end.
    expect(followScroll(0, 900, 3_600, 3_590)).toBe(2_700);
  });

  it("pans a focused waveform with the keys, within its ends", () => {
    expect(panScroll("ArrowRight", 0, 800, 3_200)).toBe(200);
    expect(panScroll("ArrowLeft", 100, 800, 3_200)).toBe(0);
    expect(panScroll("PageDown", 2_000, 800, 3_200)).toBe(2_400);
    expect(panScroll("Home", 1_000, 800, 3_200)).toBe(0);
    expect(panScroll("End", 0, 800, 3_200)).toBe(2_400);
    // Anything else is left to the page, where Space plays and J and L seek.
    expect(panScroll(" ", 0, 800, 3_200)).toBeNull();
  });
});

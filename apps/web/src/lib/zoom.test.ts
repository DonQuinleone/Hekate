import { describe, expect, it } from "vitest";
import {
  anchoredScroll,
  fingerSpan,
  followScroll,
  MAX_ZOOM,
  maxZoom,
  panScroll,
  wheelZoomFactor,
  zoomAbout,
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
    // From anywhere a pinch left it, the buttons go to the powers of two either side.
    expect(zoomStep(2.7, 1, 8)).toBe(4);
    expect(zoomStep(2.7, -1, 8)).toBe(2);
    expect(zoomStep(4, 1, 8)).toBe(8);
    expect(zoomStep(4, -1, 8)).toBe(2);
    expect(zoomLabel(2.5)).toBe("2.5×");
    expect(zoomLabel(2.74)).toBe("2.7×");
  });

  it("zooms about a point, keeping the moment under it where it was (#494)", () => {
    // Pinch out to 2× about the middle of a 900 px view at 1×: that moment, 450 px into the
    // content, is now 900 px in, so the view scrolls 450 to keep it under the pointer.
    expect(zoomAbout({ zoom: 1, scrollLeft: 0, width: 900, most: 8 }, 2, 0.5)).toEqual({
      zoom: 2,
      scrollLeft: 450,
    });
    // About the left edge nothing scrolls; about the right edge the view stays at the end.
    expect(zoomAbout({ zoom: 1, scrollLeft: 0, width: 900, most: 8 }, 2, 0)).toEqual({
      zoom: 2,
      scrollLeft: 0,
    });
    expect(zoomAbout({ zoom: 1, scrollLeft: 0, width: 900, most: 8 }, 2, 1)).toEqual({
      zoom: 2,
      scrollLeft: 900,
    });
    // Held within the file's range: no further in than it offers, no further out than whole.
    expect(zoomAbout({ zoom: 6, scrollLeft: 1000, width: 900, most: 8 }, 4, 0.5).zoom).toBe(8);
    expect(zoomAbout({ zoom: 1.5, scrollLeft: 100, width: 900, most: 8 }, 0.1, 0.5)).toEqual({
      zoom: 1,
      scrollLeft: 0,
    });
    // Zooming back out brings the scroll back within the content.
    const out = zoomAbout({ zoom: 4, scrollLeft: 2700, width: 900, most: 8 }, 0.5, 1);
    expect(out.zoom).toBe(2);
    expect(out.scrollLeft).toBe(900);
  });

  it("turns a wheel's delta into a zoom factor, a pinch gently and never more than doubling", () => {
    expect(wheelZoomFactor(0)).toBe(1);
    // A trackpad pinch: small deltas, a few percent each.
    expect(wheelZoomFactor(-5)).toBeCloseTo(1.051, 3);
    expect(wheelZoomFactor(5)).toBeCloseTo(0.951, 3);
    // A mouse wheel's notch with the key held is held to a doubling or a halving.
    expect(wheelZoomFactor(-100)).toBe(2);
    expect(wheelZoomFactor(100)).toBe(0.5);
    // Two fingers 300 px apart, then 600: a pinch out to twice the zoom.
    const fingers = new Map([
      [1, { x: 100, y: 0 }],
      [2, { x: 400, y: 0 }],
    ]);
    expect(fingerSpan(fingers.values())).toBe(300);
    expect(fingerSpan([{ x: 0, y: 0 }])).toBe(0);
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

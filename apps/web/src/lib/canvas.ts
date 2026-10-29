/**
 * Wider than this, browsers refuse to draw a canvas at all: a zoomed plane is drawn at this
 * many device pixels at most and stretched to its place, the stored peaks and spectra being
 * coarser anyway.
 */
export const MAX_CANVAS_WIDTH = 16_384;

/** The device pixels a canvas may be given for a plane `cssWidth` wide at `ratio` pixels each. */
export const backingWidth = (cssWidth: number, ratio: number) =>
  Math.max(1, Math.min(Math.round(cssWidth * ratio), MAX_CANVAS_WIDTH));

/**
 * The document viewer's arithmetic (#29): zoom is a share of the width that fits the page
 * in the viewer, so "fit" is 1 whatever the page or the screen.
 */

/** The zoom steps, as multiples of the fitted width. */
export const ZOOM_STEPS = [1, 1.5, 2, 3, 4] as const;

/** The next zoom step in or out from where the viewer is. */
export function zoomStep(current: number, direction: 1 | -1): number {
  if (direction === 1) return ZOOM_STEPS.find((z) => z > current + 1e-6) ?? current;
  return [...ZOOM_STEPS].reverse().find((z) => z < current - 1e-6) ?? current;
}

/** How a zoom reads in the toolbar. */
export const zoomLabel = (zoom: number) => (zoom === 1 ? "Fit" : `${Math.round(zoom * 100)}%`);

/** A page number kept within the document. */
export const clampPage = (page: number, count: number) =>
  Math.min(Math.max(1, Math.round(page)), Math.max(1, count));

/** A rectangle on a page, in shares of its width and height. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Smaller than this, on either side, a drag is taken for a click. */
export const MIN_REGION = 0.01;

const unit = (v: number) => Math.min(1, Math.max(0, v));
const round = (v: number) => Math.round(v * 10_000) / 10_000;

/**
 * The rectangle between where a drag began and where it is now, kept on the page and
 * dragged in any direction; null while it is too small to be a region.
 */
export function regionFromDrag(
  from: { x: number; y: number },
  to: { x: number; y: number },
): Rect | null {
  const [x1, x2] = [unit(from.x), unit(to.x)].sort((a, b) => a - b) as [number, number];
  const [y1, y2] = [unit(from.y), unit(to.y)].sort((a, b) => a - b) as [number, number];
  if (x2 - x1 < MIN_REGION || y2 - y1 < MIN_REGION) return null;
  const x = round(x1);
  const y = round(y1);
  // Rounded so that the region never reaches past the edge.
  return { x, y, width: Math.min(round(x2 - x1), 1 - x), height: Math.min(round(y2 - y1), 1 - y) };
}

/** Where a pointer is on an element, in shares of its size. */
export function pointIn(rect: DOMRect, clientX: number, clientY: number) {
  return { x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height };
}

/**
 * What the viewer and the comments share on a document: the page shown, the region
 * being drawn for a new comment, and the thread picked on the page or in the list.
 */
export interface PageFocus {
  page: number;
  draft: Rect | null;
  selected: string | null;
}

export const initialFocus: PageFocus = { page: 1, draft: null, selected: null };

/** The whole of a page, which reads as the page itself. */
export const isWholePage = (r: Rect) => r.x === 0 && r.y === 0 && r.width === 1 && r.height === 1;

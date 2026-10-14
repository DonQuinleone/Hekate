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

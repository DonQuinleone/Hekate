import { BASE_SAMPLES_PER_PEAK } from "@hekate/shared";

/**
 * Zooming into a recording's waveform and spectrogram (#34): each step doubles the time a
 * pixel covers, down to the finest detail the stored peaks hold (256 samples a peak, about
 * 5 ms). The scrub bar under the player keeps the whole file, as an overview.
 */

/** The widest zoom offered, whatever the file: a 64th of it across the player. */
export const MAX_ZOOM = 64;

/**
 * How far a file can be zoomed: until each pixel across the player has a peak of its own,
 * as finer than that draws nothing new. At least 1 (the whole file), at most `MAX_ZOOM`.
 */
export function maxZoom(duration: number, sampleRate: number, width: number): number {
  if (!(duration > 0) || !(sampleRate > 0) || !(width > 0)) return 1;
  const peaks = (duration * sampleRate) / BASE_SAMPLES_PER_PEAK;
  let zoom = 1;
  while (zoom * 2 <= MAX_ZOOM && width * zoom * 2 <= peaks) zoom *= 2;
  return zoom;
}

/**
 * The next zoom in (1) or out (−1), within 1 and `most`: the next power of two, so the
 * steps after a pinch (which lands anywhere) are the same as from the start.
 */
export function zoomStep(zoom: number, direction: 1 | -1, most: number): number {
  const power = Math.log2(Math.max(1, zoom));
  const next =
    direction === 1 ? 2 ** (Math.floor(power + 1e-9) + 1) : 2 ** (Math.ceil(power - 1e-9) - 1);
  return Math.max(1, Math.min(most, next));
}

/** A zoom as the player shows it: "Fit" for the whole file, "4×" when zoomed, "2.5×" between steps. */
export const zoomLabel = (zoom: number) =>
  zoom <= 1 ? "Fit" : `${Number.isInteger(zoom) ? zoom : zoom.toFixed(1)}×`;

/** The zoomed view: how far in, how far it is scrolled, how wide it is, and how far it can go. */
export interface ZoomView {
  zoom: number;
  scrollLeft: number;
  /** The visible width, in pixels. */
  width: number;
  /** The furthest zoom offered for this file (`maxZoom`). */
  most: number;
}

/**
 * Zoom by `factor` about the point `atFraction` of the way across the view (#494): a pinch or
 * a wheel under the pointer. The moment under that point stays under it; the zoom is held
 * within 1 and `most`, and the scroll within the content.
 */
export function zoomAbout(
  view: ZoomView,
  factor: number,
  atFraction: number,
): { zoom: number; scrollLeft: number } {
  const zoom = Math.max(1, Math.min(view.most, view.zoom * factor));
  const anchor = Math.max(0, Math.min(1, atFraction)) * view.width;
  const furthest = Math.max(0, view.width * zoom - view.width);
  const scrollLeft = Math.min(furthest, anchoredScroll(view.scrollLeft, anchor, view.zoom, zoom));
  return { zoom, scrollLeft };
}

/** How far apart two fingers are, for a pinch: the distance between the first two points. */
export function fingerSpan(points: Iterable<{ x: number; y: number }>): number {
  const [a, b] = [...points];
  if (!a || !b) return 0;
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * How much a wheel event zooms (#494): a trackpad pinch arrives as a wheel with the control
 * key and small deltas; a mouse wheel with the key held, in notches of about a hundred. Each
 * is held to doubling or halving at most, so no single event leaps.
 */
export function wheelZoomFactor(deltaY: number): number {
  return Math.max(0.5, Math.min(2, Math.exp(-deltaY * 0.01)));
}

/**
 * Where to scroll after a zoom, so the moment at `anchor` pixels into the view stays under
 * it: the playhead when it is in view, otherwise the middle.
 */
export function anchoredScroll(
  scrollLeft: number,
  anchor: number,
  from: number,
  to: number,
): number {
  return Math.max(0, ((scrollLeft + anchor) * to) / from - anchor);
}

/**
 * Where to scroll so the playhead stays in view as it plays, a page at a time as in a DAW:
 * once it leaves the view, it is brought back a tenth of the way in. Null while it is in
 * view, so scrolling around while paused is left alone.
 */
export function followScroll(
  scrollLeft: number,
  view: number,
  total: number,
  playhead: number,
): number | null {
  if (playhead >= scrollLeft && playhead < scrollLeft + view) return null;
  return Math.max(0, Math.min(total - view, playhead - view * 0.1));
}

/**
 * Where a key moves a zoomed waveform that has focus: the arrows a quarter of the view, Page
 * Up and Page Down a whole view, Home and End to either end. Null for any other key, which
 * then does what it does anywhere on the page (the arrows seek when the waveform has no focus).
 */
export function panScroll(
  key: string,
  scrollLeft: number,
  view: number,
  total: number,
): number | null {
  const step: Record<string, number> = {
    ArrowLeft: -view / 4,
    ArrowRight: view / 4,
    PageUp: -view,
    PageDown: view,
    Home: -total,
    End: total,
  };
  const by = step[key];
  if (by === undefined) return null;
  return Math.max(0, Math.min(total - view, scrollLeft + by));
}

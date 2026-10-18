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

/** The next zoom in (1) or out (−1), doubling or halving, within 1 and `most`. */
export function zoomStep(zoom: number, direction: 1 | -1, most: number): number {
  return Math.max(1, Math.min(most, direction === 1 ? zoom * 2 : zoom / 2));
}

/** A zoom as the player shows it: "Fit" for the whole file, "4×" when zoomed. */
export const zoomLabel = (zoom: number) => (zoom <= 1 ? "Fit" : `${zoom}×`);

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

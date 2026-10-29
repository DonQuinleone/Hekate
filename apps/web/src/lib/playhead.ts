/**
 * The playhead between the media's own time updates (#492). A media element reports its
 * time a few times a second; a playhead drawn only then steps. Everything that shows the
 * position (the line over the waveform, the scrub bar's thumb) is driven from one animation
 * frame clock instead, which moves on from the last time it was told at the playback rate.
 */

/**
 * Where the playhead is at `now`, given the time last read from the media (`lastTime`) and
 * when it was read (`lastAt`, both in the frame clock's milliseconds): on from it at the
 * playback rate while playing, exactly it while paused.
 */
export function interpolatePosition(
  lastTime: number,
  lastAt: number,
  now: number,
  rate: number,
  playing: boolean,
): number {
  if (!playing) return lastTime;
  const elapsed = Math.max(0, now - lastAt) / 1000;
  return lastTime + elapsed * rate;
}

/** Where a pointer at `clientX` falls across a box, as a share of it from 0 to 1. */
export function fractionAt(clientX: number, left: number, width: number): number {
  if (!(width > 0)) return 0;
  return Math.min(1, Math.max(0, (clientX - left) / width));
}

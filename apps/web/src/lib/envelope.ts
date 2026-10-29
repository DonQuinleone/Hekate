/**
 * The waveform drawn over a spectrogram (#495), column by column: wavesurfer draws the
 * waveform alone, but over a spectrogram it must be opaque with an outline, which its
 * renderer cannot do, so the player draws that one itself from the same peaks.
 */

/**
 * The envelope across `columns` pixel columns from a channel's peaks (min and max alternating,
 * from −1 to 1, as `toChannelArrays` gives them): for each column, the lowest min and the
 * highest max of the peaks that fall in it, so nothing narrow vanishes when there are more
 * peaks than columns, and a peak that spans several columns repeats across them.
 */
export function envelopeColumns(peaks: Float32Array, columns: number): Float32Array {
  const out = new Float32Array(columns * 2);
  const count = peaks.length / 2;
  if (count === 0 || columns <= 0) return out;
  for (let x = 0; x < columns; x++) {
    const first = Math.floor((x * count) / columns);
    const last = Math.min(count, Math.max(first + 1, Math.floor(((x + 1) * count) / columns)));
    let low = 1;
    let high = -1;
    for (let peak = first; peak < last; peak++) {
      const min = peaks[peak * 2] as number;
      const max = peaks[peak * 2 + 1] as number;
      if (min < low) low = min;
      if (max > high) high = max;
    }
    out[x * 2] = Math.min(low, high);
    out[x * 2 + 1] = Math.max(low, high);
  }
  return out;
}

/**
 * The outline of an envelope in a lane: the top edge left to right, then the bottom edge
 * back, as points to join. `mid` is the lane's middle and `amp` how many pixels a full-scale
 * peak reaches, held within the lane's half height so a tall look never leaves its lane.
 */
export function envelopeOutline(
  envelope: Float32Array,
  mid: number,
  amp: number,
  half: number,
): { x: number; y: number }[] {
  const columns = envelope.length / 2;
  const clamp = (v: number) => Math.max(-half, Math.min(half, v));
  const top: { x: number; y: number }[] = [];
  const bottom: { x: number; y: number }[] = [];
  for (let x = 0; x < columns; x++) {
    const min = envelope[x * 2] as number;
    const max = envelope[x * 2 + 1] as number;
    // At least a hairline, so silence still draws as a line through the lane.
    top.push({ x, y: mid - Math.max(0.5, clamp(max * amp)) });
    bottom.push({ x, y: mid - Math.min(-0.5, clamp(min * amp)) });
  }
  return [...top, ...bottom.reverse()];
}

/** A small deterministic generator, so a file always draws the same waveform. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10_000) / 10_000;
  };
}

/**
 * Peaks for a waveform: pairs of (low, high) in -1..1 per column, shaped like a piece of
 * music with phrases, accents and a quieter tail, so the drawing reads as a recording.
 */
export function peaksFor(seed: number, columns: number, channels = 2): number[][] {
  const out: number[][] = [];
  for (let c = 0; c < channels; c++) {
    const rand = seeded(seed * 31 + c * 7);
    const peaks: number[] = [];
    for (let i = 0; i < columns; i++) {
      const t = i / columns;
      const phrase = 0.55 + 0.35 * Math.sin(t * Math.PI * 6 + seed) * Math.sin(t * Math.PI * 2.3);
      const accent = (i % 17 === 0 || i % 23 === 0 ? 0.3 : 0) * rand();
      const tail = t > 0.93 ? (1 - t) / 0.07 : 1;
      const lead = t < 0.012 ? t / 0.012 : 1;
      const amp = Math.min(
        1,
        (phrase * (0.6 + 0.4 * rand()) + accent) * tail * lead * (c === 1 ? 0.92 : 1),
      );
      peaks.push(amp);
    }
    out.push(peaks);
  }
  return out;
}

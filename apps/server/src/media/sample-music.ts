/** For tests: a repeatable stand-in for music, made here rather than kept as a file. */

/**
 * Notes and chords of decaying harmonic tones, a few a second over three octaves from 110 Hz,
 * with a little noise beneath, peaking at `level`. Each `seed` is a different piece.
 */
export function sampleMusic(
  seconds: number,
  rate: number,
  { seed = 1, level = 0.3 }: { seed?: number; level?: number } = {},
): Float32Array {
  let state = seed * 7919 + 1;
  const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const out = new Float32Array(Math.round(seconds * rate));
  for (let t = 0; t < seconds; t += 0.15 + random() * 0.35) {
    const chord = 1 + Math.floor(random() * 3);
    for (let c = 0; c < chord; c++) {
      const f = 110 * 2 ** (Math.floor(random() * 36) / 12);
      const amp = 0.3 + random() * 0.7;
      const decay = 0.4 + random() * 1.6;
      const from = Math.round(t * rate);
      const to = Math.min(out.length, from + Math.round(decay * 3 * rate));
      for (let h = 1; h <= 6 && f * h < rate / 2; h++) {
        // A rotating phasor rather than a sine per sample: the same tone, much sooner.
        const step = (2 * Math.PI * f * h) / rate;
        const cs = Math.cos(step);
        const sn = Math.sin(step);
        let x = 1;
        let y = 0;
        const fall = Math.exp(-1 / (decay * rate));
        let env = amp / h ** 1.3;
        for (let i = from; i < to; i++) {
          const attack = Math.min(1, (i - from) / (0.005 * rate));
          out[i] = (out[i] as number) + env * attack * y;
          const nx = x * cs - y * sn;
          y = x * sn + y * cs;
          x = nx;
          env *= fall;
        }
      }
    }
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < out.length; i++)
    out[i] = ((out[i] as number) / peak) * level + 0.003 * (random() - 0.5);
  return out;
}

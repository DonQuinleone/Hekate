import { useEffect, useRef } from "react";
import { seeded } from "~/lib/seeded";

export type ColourMap = "cyan-orange" | "inferno" | "greyscale" | "signal";

const maps: Record<ColourMap, (v: number) => [number, number, number]> = {
  "cyan-orange": (v) =>
    v < 0.5
      ? [10 + v * 2 * 40, 20 + v * 2 * 150, 40 + v * 2 * 180]
      : [50 + (v - 0.5) * 2 * 190, 170 - (v - 0.5) * 2 * 60, 220 - (v - 0.5) * 2 * 190],
  inferno: (v) =>
    v < 0.5
      ? [v * 2 * 120, v * 2 * 20, 20 + v * 2 * 80]
      : [120 + (v - 0.5) * 2 * 130, 20 + (v - 0.5) * 2 * 200, 100 - (v - 0.5) * 2 * 100],
  greyscale: (v) => [v * 230, v * 230, v * 232],
  signal: (v) => [10 + v * 230, 10 + v * 108, 11 + v * 35],
};

/**
 * A spectrogram drawn from procedural "tiles": harmonics, noise and the accents of the
 * piece, so the picture reads as one. Settings come from the View menu.
 */
export function Spectrogram({
  seed,
  width,
  height,
  colourMap = "cyan-orange",
  scale = "mel",
  floor = -100,
  ceiling = -8,
  gain = 0,
  className,
}: {
  seed: number;
  width: number;
  height: number;
  colourMap?: ColourMap;
  scale?: "linear" | "log" | "mel";
  floor?: number;
  ceiling?: number;
  /** Its own brightness (#495): added to every level, in dB. */
  gain?: number;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el || width < 10) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const w = Math.floor(width / 2);
    const h = Math.floor(height / 2);
    el.width = w;
    el.height = h;
    const img = ctx.createImageData(w, h);
    const rand = seeded(seed * 17);
    const map = maps[colourMap];
    const range = Math.max(10, ceiling - floor);
    const noise = new Float32Array(w * h);
    for (let i = 0; i < noise.length; i++) noise[i] = rand();
    for (let px = 0; px < w; px++) {
      const t = px / w;
      const phrase = 0.55 + 0.35 * Math.sin(t * Math.PI * 6 + seed) * Math.sin(t * Math.PI * 2.3);
      const tail = t > 0.93 ? (1 - t) / 0.07 : 1;
      const lead = t < 0.012 ? 0 : 1;
      const chordOn = Math.floor(t * 64) % 2 === 0 ? 1 : 0.7;
      for (let py = 0; py < h; py++) {
        const f = 1 - py / h;
        const freq = scale === "linear" ? f : scale === "mel" ? f ** 1.6 : f ** 2.4;
        let v = -95 + 70 * Math.exp(-freq * 4.2) * phrase * tail * lead * chordOn;
        // harmonics of the piano's lines
        const fund = 0.06 + 0.02 * Math.sin(t * 40 + seed);
        for (let k = 1; k <= 9; k++) {
          const d = Math.abs(freq - fund * k);
          if (d < 0.004) v += (40 / k) * phrase * tail * lead * (1 - d / 0.004);
        }
        v += (noise[py * w + px] ?? 0) * 10 - 5 + gain;
        const n = Math.min(1, Math.max(0, (v - floor) / range));
        const [r, g, b] = map(n);
        const i = (py * w + px) * 4;
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [seed, width, height, colourMap, scale, floor, ceiling, gain]);
  return (
    <canvas
      ref={canvas}
      className={className}
      style={{ width, height }}
      role="img"
      aria-label="Spectrogram"
    />
  );
}

export function FrequencyScale({
  height,
  scale = "mel",
}: {
  height: number;
  scale?: "linear" | "log" | "mel";
}) {
  const labels =
    scale === "linear" ? ["20k", "15k", "10k", "5k", "0"] : ["20k", "5k", "1k", "200", "20"];
  return (
    <div
      className="tabular pointer-events-none absolute top-0 right-1 bottom-0 flex flex-col justify-between py-1 text-[9px] text-ink-3"
      style={{ height }}
    >
      {labels.map((l) => (
        <span key={l}>{l}</span>
      ))}
    </div>
  );
}

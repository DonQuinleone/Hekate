import type { Anchor } from "./anchor.ts";

const pad = (n: number, width = 2) => String(Math.trunc(n)).padStart(width, "0");

/** `04:31.250`, or `1:04:31.250` past an hour. */
export function formatClock(seconds: number): string {
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const s = Math.floor(totalMs / 1000) % 60;
  const m = Math.floor(totalMs / 60_000) % 60;
  const h = Math.floor(totalMs / 3_600_000);
  const base = `${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
  return h > 0 ? `${h}:${base}` : base;
}

/** SMPTE non-drop-frame timecode, `00:01:12:08`. */
export function formatTimecode(seconds: number, fps: number): string {
  const rate = Math.round(fps);
  const frames = Math.round(seconds * fps);
  const f = frames % rate;
  const totalSeconds = Math.floor(frames / rate);
  return `${pad(totalSeconds / 3600)}:${pad((totalSeconds / 60) % 60)}:${pad(totalSeconds % 60)}:${pad(f)}`;
}

/** Labels follow the brand system: upper case, en dash for ranges. */
export function formatAnchor(anchor: Anchor, options: { fps?: number } = {}): string {
  const time = (s: number) => (options.fps ? formatTimecode(s, options.fps) : formatClock(s));
  switch (anchor.kind) {
    case "time": {
      const range =
        anchor.end > anchor.start
          ? `${time(anchor.start)} – ${time(anchor.end)}`
          : time(anchor.start);
      return anchor.frame === undefined ? range : `${range} · F ${anchor.frame}`;
    }
    case "region": {
      const where =
        anchor.page !== undefined
          ? `P. ${anchor.page}`
          : anchor.at !== undefined
            ? time(anchor.at)
            : "FRAME";
      return `${where} · REGION`;
    }
    case "bar": {
      if (anchor.to && anchor.to.bar !== anchor.from.bar)
        return `BARS ${anchor.from.bar}–${anchor.to.bar}`;
      return `BAR ${anchor.from.bar}.${anchor.from.beat}`;
    }
    case "section":
      return "SECTION";
  }
}

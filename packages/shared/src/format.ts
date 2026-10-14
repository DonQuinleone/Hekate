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
  }
}

/** File sizes in decimal units, as operating systems show them: `412 KB`, `1.3 GB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** `4:31` or `1:02:03`: a duration for lists, to the second. */
export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

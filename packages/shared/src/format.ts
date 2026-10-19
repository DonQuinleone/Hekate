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
export function formatAnchor(
  anchor: Anchor,
  options: {
    fps?: number;
    /** How a moment reads instead, such as a video's own timecode (#146). */
    time?: (seconds: number) => string;
  } = {},
): string {
  const time = (s: number) =>
    options.time ? options.time(s) : options.fps ? formatTimecode(s, options.fps) : formatClock(s);
  switch (anchor.kind) {
    case "time": {
      const range =
        anchor.end > anchor.start
          ? `${time(anchor.start)} – ${time(anchor.end)}`
          : time(anchor.start);
      return anchor.frame === undefined ? range : `${range} · F ${anchor.frame}`;
    }
    case "region": {
      const whole = anchor.x === 0 && anchor.y === 0 && anchor.width === 1 && anchor.height === 1;
      // A picture is one page: a region on it needs no place.
      // A drawing says so (#146); any other region is a region.
      const what = anchor.drawing ? "DRAWING" : "REGION";
      if (anchor.page === undefined && anchor.at === undefined) return what;
      const at = anchor.at ?? 0;
      const where =
        anchor.page !== undefined
          ? `P. ${anchor.page}`
          : anchor.end !== undefined && anchor.end > at
            ? `${time(at)} – ${time(anchor.end)}`
            : time(at);
      // The whole of a page is simply the page; a whole video frame stays a region.
      return whole && anchor.page !== undefined && !anchor.drawing ? where : `${where} · ${what}`;
    }
    case "bar": {
      // The score's page first, when the reviewer gave it (#240).
      const page = anchor.page === undefined ? "" : `P. ${anchor.page} · `;
      if (anchor.to && anchor.to.bar !== anchor.from.bar)
        return `${page}BARS ${anchor.from.bar}–${anchor.to.bar}`;
      // The beat only when it says something: bar 25 is its first beat.
      return anchor.from.beat === 1
        ? `${page}BAR ${anchor.from.bar}`
        : `${page}BAR ${anchor.from.bar}.${anchor.from.beat}`;
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

/**
 * A channel layout as engineers say it: `mono`, `stereo`, `5.1`, `7.1.4`. Uses ffprobe's
 * layout name when it has one, without the variant (`5.1(side)` reads as `5.1`).
 */
export function formatChannels(channels: number, layout?: string): string {
  if (layout && !/channels?$/.test(layout)) return layout.replace(/\(.*\)$/, "");
  if (channels === 1) return "mono";
  if (channels === 2) return "stereo";
  return `${channels} ch`;
}

/**
 * Short names for each channel, in FFmpeg's order for its named layouts. FFmpeg tells side
 * and back surrounds apart: plain `5.1` carries back channels (Lb, Rb) and `5.1(side)` side
 * channels (Ls, Rs), and the immersive layouts build on the back variant.
 */
const layoutChannels: Record<string, string[]> = {
  mono: ["M"],
  stereo: ["L", "R"],
  "2.1": ["L", "R", "LFE"],
  "3.0": ["L", "R", "C"],
  quad: ["L", "R", "Lb", "Rb"],
  "quad(side)": ["L", "R", "Ls", "Rs"],
  "5.0": ["L", "R", "C", "Lb", "Rb"],
  "5.0(side)": ["L", "R", "C", "Ls", "Rs"],
  "5.1": ["L", "R", "C", "LFE", "Lb", "Rb"],
  "5.1(side)": ["L", "R", "C", "LFE", "Ls", "Rs"],
  "7.1": ["L", "R", "C", "LFE", "Lb", "Rb", "Ls", "Rs"],
  "5.1.2": ["L", "R", "C", "LFE", "Lb", "Rb", "Ltf", "Rtf"],
  "5.1.4": ["L", "R", "C", "LFE", "Lb", "Rb", "Ltf", "Rtf", "Ltb", "Rtb"],
  "7.1.2": ["L", "R", "C", "LFE", "Lb", "Rb", "Ls", "Rs", "Ltf", "Rtf"],
  "7.1.4": ["L", "R", "C", "LFE", "Lb", "Rb", "Ls", "Rs", "Ltf", "Rtf", "Ltb", "Rtb"],
};

export function channelNames(channels: number, layout?: string): string[] {
  const named = layout ? layoutChannels[layout] : undefined;
  if (named && named.length === channels) return named;
  if (!layout || /channels?$/.test(layout)) {
    if (channels === 1) return ["M"];
    if (channels === 2) return ["L", "R"];
  }
  return Array.from({ length: channels }, (_, i) => String(i + 1));
}

import { z } from "zod";

/**
 * Captions from a sidecar file beside a video (#146): SubRip, WebVTT or TTML, read once into
 * cues when the file is added, then shown over the picture as it plays. Only what is said and
 * when: positions, styles and voices are left to the deliverable itself.
 */

export const captionFormats = ["srt", "vtt", "ttml"] as const;
export type CaptionFormat = (typeof captionFormats)[number];
export const captionFormat = z.enum(captionFormats);

export const captionFormatNames: Record<CaptionFormat, string> = {
  srt: "SubRip",
  vtt: "WebVTT",
  ttml: "TTML",
};

/** A caption file can be at most this large: hours of dialogue are a few hundred kilobytes. */
export const CAPTION_FILE_MAX_BYTES = 2 * 1024 * 1024;
/** And hold at most this many cues. */
export const CAPTION_CUES_MAX = 20_000;
/** A video can carry at most this many caption files (languages, captions and subtitles). */
export const CAPTION_TRACKS_MAX = 12;

export const captionCue = z.object({
  /** Seconds from the start of the video. */
  start: z.number().min(0),
  end: z.number().min(0),
  /** Lines separated by a newline, without markup. */
  text: z.string(),
});
export type CaptionCue = z.infer<typeof captionCue>;

/** What a caption file is called in the player's menu: "English", "SDH", "Français". */
export const captionLabel = z
  .string()
  .trim()
  .min(1, "Name the captions")
  .max(60, "A name can be at most 60 characters");

export interface CaptionTrack {
  id: string;
  /** "English": how the menu names it. */
  label: string;
  /** The sidecar's own file name. */
  name: string;
  format: CaptionFormat;
  cues: CaptionCue[];
  createdAt: string;
}

/** A caption file that cannot be read, with a sentence saying why. */
export class CaptionError extends Error {}

/** The format a file is in, by its contents first and then its name; null when it is none. */
export function captionFormatOf(name: string, text: string): CaptionFormat | null {
  const head = text.replace(/^﻿/, "").trimStart();
  if (/^WEBVTT(\s|$)/.test(head)) return "vtt";
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<(\w+:)?tt[\s>]/.test(head)) return "ttml";
  if (/^\d+\s*\r?\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(head)) return "srt";
  const extension = name.toLowerCase().split(".").pop();
  if (extension === "srt") return "srt";
  if (extension === "vtt") return "vtt";
  if (extension === "ttml" || extension === "dfxp") return "ttml";
  return null;
}

/** The cues of a caption file, in time order. */
export function parseCaptions(text: string, format: CaptionFormat): CaptionCue[] {
  const source = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const cues = format === "ttml" ? readTtml(source) : readBlocks(source, format);
  if (cues.length === 0) throw new CaptionError("No captions were found in this file");
  if (cues.length > CAPTION_CUES_MAX)
    throw new CaptionError(`A caption file can hold at most ${CAPTION_CUES_MAX} captions`);
  return cues.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** The cues showing at a moment: from their start up to, not including, their end. */
export function cuesAt(cues: readonly CaptionCue[], time: number): CaptionCue[] {
  return cues.filter((c) => c.start <= time && time < c.end);
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  lrm: "‎",
  rlm: "‏",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X"
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** One line's text without markup: tags, SubRip's position codes and WebVTT's timestamps. */
function plain(line: string): string {
  return decodeEntities(line.replace(/\{\\[^}]*\}/g, "").replace(/<[^>]*>/g, "")).trim();
}

/** `01:02:03,456`, `01:02:03.456` or WebVTT's `02:03.456`, in seconds. */
function clock(value: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})$/.exec(value.trim());
  if (!m) return null;
  const [, h = "0", min = "0", s = "0", frac = "0"] = m;
  if (Number(min) > 59 || Number(s) > 59) return null;
  return Number(h) * 3600 + Number(min) * 60 + Number(s) + Number(frac.padEnd(3, "0")) / 1000;
}

/** SubRip and WebVTT: blocks apart by a blank line, each a timing line and its text. */
function readBlocks(text: string, format: "srt" | "vtt"): CaptionCue[] {
  const blocks = text.split(/\n[ \t]*\n/);
  if (format === "vtt") {
    if (!/^WEBVTT(\s|$)/.test(blocks[0] ?? ""))
      throw new CaptionError("A WebVTT file begins with WEBVTT");
    blocks.shift();
  }
  const cues: CaptionCue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l, i) => i > 0 || l.trim() !== "");
    const at = lines.findIndex((l) => l.includes("-->"));
    // A WebVTT note, style or region, or a SubRip block with no timing: nothing to show.
    if (at < 0 || at > 1) continue;
    const [from = "", rest = ""] = (lines[at] ?? "").split("-->");
    // WebVTT may follow the end with settings (position, line, align).
    const start = clock(from);
    const end = clock(rest.trim().split(/\s+/)[0] ?? "");
    if (start === null || end === null)
      throw new CaptionError(`This timing cannot be read: ${(lines[at] ?? "").trim()}`);
    if (end < start) continue;
    const words = lines
      .slice(at + 1)
      .map(plain)
      .filter((l) => l !== "")
      .join("\n");
    if (words) cues.push({ start, end, text: words });
  }
  return cues;
}

/** The value of an attribute on a tag, whatever its namespace prefix. */
function attribute(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s(?:[\\w-]+:)?${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
  return m ? (m[2] ?? m[3]) : undefined;
}

interface TtmlRates {
  frameRate: number;
  subFrameRate: number;
  tickRate: number;
}

/** A TTML time expression in seconds: clock time, with or without frames, or an offset. */
function ttmlTime(value: string, rates: TtmlRates): number | null {
  const v = value.trim();
  const full = /^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(v);
  if (full) {
    const [, h = "0", m = "0", s = "0", frac] = full;
    return Number(h) * 3600 + Number(m) * 60 + Number(s) + (frac ? Number(`0.${frac}`) : 0);
  }
  const frames = /^(\d+):(\d{2}):(\d{2}):(\d+)(?:\.(\d+))?$/.exec(v);
  if (frames) {
    const [, h = "0", m = "0", s = "0", f = "0", sub = "0"] = frames;
    return (
      Number(h) * 3600 +
      Number(m) * 60 +
      Number(s) +
      (Number(f) + Number(sub) / rates.subFrameRate) / rates.frameRate
    );
  }
  const offset = /^(\d+(?:\.\d+)?)(h|m|s|ms|f|t)$/.exec(v);
  if (offset) {
    const n = Number(offset[1]);
    switch (offset[2]) {
      case "h":
        return n * 3600;
      case "m":
        return n * 60;
      case "s":
        return n;
      case "ms":
        return n / 1000;
      case "f":
        return n / rates.frameRate;
      default:
        return n / rates.tickRate;
    }
  }
  return null;
}

/**
 * TTML (and DFXP, its older name): each paragraph with a begin and an end (or a duration),
 * relative to the division around it where that has a begin of its own. Line breaks are kept;
 * spans and styling are not.
 */
function readTtml(text: string): CaptionCue[] {
  const root = /<(?:\w+:)?tt[\s>][^>]*>?/.exec(text)?.[0];
  if (!root) throw new CaptionError("A TTML file has a <tt> element at its root");
  const frameRate = Number(attribute(root, "frameRate") ?? 30) || 30;
  const [num = 1, den = 1] = (attribute(root, "frameRateMultiplier") ?? "1 1")
    .split(/\s+/)
    .map(Number);
  const rates: TtmlRates = {
    frameRate: (frameRate * (num || 1)) / (den || 1),
    subFrameRate: Number(attribute(root, "subFrameRate") ?? 1) || 1,
    tickRate: Number(attribute(root, "tickRate") ?? 0) || frameRate,
  };
  const time = (value: string | undefined, what: string) => {
    if (value === undefined) return undefined;
    const t = ttmlTime(value, rates);
    if (t === null) throw new CaptionError(`This ${what} cannot be read: ${value}`);
    return t;
  };
  const cues: CaptionCue[] = [];
  // Each open division's begin, for the paragraphs inside it.
  const offsets: number[] = [];
  for (const m of text.matchAll(/<(\/?)(?:\w+:)?(div|p)\b([^>]*?)(\/?)>/g)) {
    const [tag, closing, name, attrs = "", selfClosing] = m;
    if (name === "div") {
      if (closing) offsets.pop();
      else if (!selfClosing) offsets.push(time(attribute(` ${attrs}`, "begin"), "begin") ?? 0);
      continue;
    }
    if (closing || selfClosing) continue;
    const body = paragraph(text, (m.index ?? 0) + tag.length);
    if (body === null) continue;
    const base = offsets.reduce((a, b) => a + b, 0);
    const begin = time(attribute(` ${attrs}`, "begin"), "begin");
    const end = time(attribute(` ${attrs}`, "end"), "end");
    const dur = time(attribute(` ${attrs}`, "dur"), "duration");
    if (begin === undefined || (end === undefined && dur === undefined)) continue;
    const start = base + begin;
    const finish = end !== undefined ? base + end : start + (dur ?? 0);
    const words = body
      .replace(/<(?:\w+:)?br\b[^>]*\/?>/g, "\n")
      .split("\n")
      .map(plain)
      .filter((l) => l !== "")
      .join("\n");
    if (words && finish > start) cues.push({ start, end: finish, text: words });
  }
  return cues;
}

/** A paragraph's contents from where its start tag ends, spans and all, up to its end tag. */
function paragraph(text: string, from: number): string | null {
  const end = /<\/(?:\w+:)?p\s*>/g;
  end.lastIndex = from;
  const m = end.exec(text);
  return m ? text.slice(from, m.index) : null;
}

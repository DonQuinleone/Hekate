import { z } from "zod";

/**
 * Caption tracks (#146, #201): SubRip, WebVTT or TTML files added to a video or a recording,
 * read once into cues, then shown over the picture (or under the waveform) as it plays, read
 * as a transcript, searched, and exported in any of the three formats. Only what is said and
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
/** A file can carry at most this many caption tracks (languages, captions and subtitles). */
export const CAPTION_TRACKS_MAX = 12;

/** The kinds of file that carry caption tracks: those that play. */
export const captionedKinds: readonly string[] = ["video", "audio"];

/**
 * What a track is for. Subtitles carry the words, for viewers who hear them but may not follow
 * the language; captions (SDH) carry the sounds as well, for viewers who are deaf or hard of
 * hearing. The same distinction as HTML's track kinds.
 */
export const captionKinds = ["subtitles", "captions"] as const;
export type CaptionKind = (typeof captionKinds)[number];
export const captionKind = z.enum(captionKinds);
export const captionKindNames: Record<CaptionKind, string> = {
  subtitles: "Subtitles",
  captions: "Captions (SDH)",
};

/** A language tag (BCP 47), in its canonical form: "en", "fr-CA", "zh-Hant"; null if none. */
export function canonicalLanguage(tag: string): string | null {
  if (!/^[a-z]{2,3}(-[a-z0-9]{1,8})*$/i.test(tag.trim())) return null;
  try {
    return Intl.getCanonicalLocales(tag.trim())[0] ?? null;
  } catch {
    return null;
  }
}

/** A track's language as it is given: a tag such as "en" or "fr-CA", stored canonical. */
export const captionLanguage = z
  .string()
  .trim()
  .max(35)
  .refine(
    (tag) => canonicalLanguage(tag) !== null,
    "Give the language as a tag such as en or fr-CA",
  )
  .transform((tag) => canonicalLanguage(tag) ?? tag);

const languageNames = (() => {
  try {
    return new Intl.DisplayNames(["en-GB"], { type: "language", fallback: "none" });
  } catch {
    return null;
  }
})();

/** A language tag's name in English ("British English", "Canadian French"); null if unknown. */
export function languageName(tag: string): string | null {
  try {
    return languageNames?.of(tag) ?? null;
  } catch {
    return null;
  }
}

/** The languages offered when a track is added, by tag; any other tag is accepted too. */
export const commonCaptionLanguages = [
  "en",
  "en-GB",
  "en-US",
  "fr",
  "fr-CA",
  "de",
  "es",
  "es-419",
  "it",
  "pt",
  "pt-BR",
  "nl",
  "sv",
  "nb",
  "da",
  "fi",
  "is",
  "pl",
  "cs",
  "sk",
  "hu",
  "ro",
  "bg",
  "el",
  "ru",
  "uk",
  "tr",
  "ar",
  "he",
  "fa",
  "hi",
  "th",
  "vi",
  "id",
  "ja",
  "ko",
  "zh-Hans",
  "zh-Hant",
] as const;

/** What a new track is called unless someone names it: "English", "English (SDH)". */
export function defaultCaptionLabel(language: string | null, kind: CaptionKind): string {
  const name = language ? languageName(language) : null;
  if (!name) return kind === "captions" ? "Captions (SDH)" : "Subtitles";
  return kind === "captions" ? `${name} (SDH)` : name;
}

/** Name parts that say what a sidecar is for rather than its language: `titles.sdh.srt`. */
const KIND_WORDS: Record<string, CaptionKind> = {
  sdh: "captions",
  cc: "captions",
  hoh: "captions",
  subs: "subtitles",
  forced: "subtitles",
};

/**
 * The language a caption file says it is in: WebVTT's `Language:` header, TTML's `xml:lang`,
 * or a tag in the name before its extension (`titles.fr-CA.srt`). Null when none says.
 */
export function captionLanguageOf(
  name: string,
  text: string,
  format: CaptionFormat,
): string | null {
  const head = text.replace(/^﻿/, "").slice(0, 4096);
  if (format === "vtt") {
    const header = head.replace(/\r\n?/g, "\n").split(/\n[ \t]*\n/)[0] ?? "";
    const said = /^Language:[ \t]*(\S+)/im.exec(header)?.[1];
    const tag = said ? canonicalLanguage(said) : null;
    if (tag) return tag;
  }
  if (format === "ttml") {
    const root = /<(?:\w+:)?tt[\s>][^>]*>?/.exec(head)?.[0] ?? "";
    const said = /\sxml:lang\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(root);
    const tag = said ? canonicalLanguage(said[1] ?? said[2] ?? "") : null;
    if (tag) return tag;
  }
  const parts = name.split(".").slice(1, -1).reverse();
  for (const part of parts) {
    if (KIND_WORDS[part.toLowerCase()]) continue;
    const tag = canonicalLanguage(part.replace(/_/g, "-"));
    if (tag && languageName(tag)) return tag;
    break;
  }
  return null;
}

/** What a caption file's name says it is for: `titles.en.sdh.srt` is captions (SDH). */
export function captionKindOf(name: string): CaptionKind | null {
  for (const part of name.toLowerCase().split(".").slice(1, -1)) {
    const kind = KIND_WORDS[part];
    if (kind) return kind;
  }
  return null;
}

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

/** Adding a caption track: what the menu calls it, its language and what it is for. */
export const captionUploadQuery = z.object({
  label: captionLabel,
  language: captionLanguage.optional(),
  /** Unless given, read from the file's name (`.sdh.`), else subtitles. */
  kind: captionKind.optional(),
});

/** Renaming a track, or saying again what language it is in and what it is for. */
export const captionUpdate = z
  .object({
    label: captionLabel.optional(),
    language: captionLanguage.nullable().optional(),
    kind: captionKind.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Nothing to change");
export type CaptionUpdate = z.infer<typeof captionUpdate>;

/** Exporting a track, in any of the three formats whatever it came as. */
export const captionExportQuery = z.object({ format: captionFormat });

export interface CaptionTrack {
  id: string;
  /** "English": how the menu names it. */
  label: string;
  /** Its language tag, where it is known: "en", "fr-CA". */
  language: string | null;
  kind: CaptionKind;
  /** The sidecar's own file name. */
  name: string;
  format: CaptionFormat;
  cues: CaptionCue[];
  createdAt: string;
}

/** A caption file that cannot be read, with a sentence saying why. */
export class CaptionError extends Error {}

/** Whether a file opens with TTML's root, after any XML declaration and comments. */
function isTtml(head: string): boolean {
  let rest = head.replace(/^<\?xml[^>]*>/, "").trimStart();
  while (rest.startsWith("<!--")) {
    const end = rest.indexOf("-->");
    if (end < 0) return false;
    rest = rest.slice(end + 3).trimStart();
  }
  return /^<(?:\w+:)?tt[\s>]/.test(rest);
}

/** The format a file is in, by its contents first and then its name; null when it is none. */
export function captionFormatOf(name: string, text: string): CaptionFormat | null {
  const head = text.replace(/^﻿/, "").trimStart();
  if (/^WEBVTT(\s|$)/.test(head)) return "vtt";
  if (isTtml(head)) return "ttml";
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
  // Stripped until none is left, so a tag broken around another ("<<b>i>") goes too.
  let text = line.replace(/\{\\[^}]*\}/g, "");
  let before: string;
  do {
    before = text;
    text = text.replace(/<[^<>]*>/g, "");
  } while (text !== before);
  return decodeEntities(text).trim();
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
  const named = Number(attribute(root, "frameRate"));
  const frameRate = named > 0 ? named : 30;
  const [num = 1, den = 1] = (attribute(root, "frameRateMultiplier") ?? "1 1")
    .split(/\s+/)
    .map(Number);
  const effective = (frameRate * (num || 1)) / (den || 1);
  const subFrameRate = Number(attribute(root, "subFrameRate") ?? 1) || 1;
  // TTML1: with no tick rate, a tick is a sub-frame where a frame rate is given, else a second.
  const tickRate =
    Number(attribute(root, "tickRate") ?? 0) || (named > 0 ? effective * subFrameRate : 1);
  const rates: TtmlRates = { frameRate: effective, subFrameRate, tickRate };
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

/** The type each format is sent and stored as. */
export const captionContentTypes: Record<CaptionFormat, string> = {
  srt: "application/x-subrip",
  vtt: "text/vtt",
  ttml: "application/ttml+xml",
};

/** A time as SubRip (`00:01:02,345`) or WebVTT and TTML (`00:01:02.345`) write it. */
function stamp(seconds: number, separator: "," | "."): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(ms % 1000, 3)}`;
}

const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A cue's lines, none of them blank, which would end the cue in SubRip and WebVTT. */
const linesOf = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");

/**
 * SubRip: numbered blocks, with the CRLF line ends most players expect. SubRip has no
 * escapes, so the words are written as they are.
 */
function writeSrt(cues: readonly CaptionCue[]): string {
  return cues
    .map(
      (c, i) =>
        `${i + 1}\r\n${stamp(c.start, ",")} --> ${stamp(c.end, ",")}\r\n${linesOf(c.text).join("\r\n")}\r\n`,
    )
    .join("\r\n");
}

/** WebVTT, with the language in its header where it is known. */
function writeVtt(cues: readonly CaptionCue[], language: string | null): string {
  const header = language ? `WEBVTT\nLanguage: ${language}\n` : "WEBVTT\n";
  const blocks = cues.map(
    (c) =>
      `${stamp(c.start, ".")} --> ${stamp(c.end, ".")}\n${linesOf(c.text).map(escapeXml).join("\n")}\n`,
  );
  return [header, ...blocks].join("\n");
}

/** TTML: one division of paragraphs, lines apart by breaks, the language on its root. */
function writeTtml(cues: readonly CaptionCue[], language: string | null): string {
  const paragraphs = cues.map(
    (c) =>
      `      <p begin="${stamp(c.start, ".")}" end="${stamp(c.end, ".")}">${linesOf(c.text)
        .map(escapeXml)
        .join("<br/>")}</p>`,
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="${escapeXml(language ?? "").replace(/"/g, "&quot;")}">`,
    "  <body>",
    "    <div>",
    ...paragraphs,
    "    </div>",
    "  </body>",
    "</tt>",
    "",
  ].join("\n");
}

/** A track's cues written out in a format, whichever it was read from (#201). */
export function writeCaptions(
  cues: readonly CaptionCue[],
  format: CaptionFormat,
  language: string | null = null,
): string {
  if (format === "srt") return writeSrt(cues);
  if (format === "vtt") return writeVtt(cues, language);
  return writeTtml(cues, language);
}

/**
 * The name an exported track is saved as, as players look for a sidecar beside its video:
 * the file's name, then the language and `sdh` where they apply, then the format's extension.
 * `Opening titles - Cut 3.mov` gives `Opening titles - Cut 3.en.sdh.srt`.
 */
export function captionFileName(
  fileName: string,
  track: Pick<CaptionTrack, "language" | "kind">,
  format: CaptionFormat,
): string {
  const base = fileName.replace(/\.[^./\\]{1,8}$/, "") || "Captions";
  const parts = [base, track.language, track.kind === "captions" ? "sdh" : null, format];
  return parts.filter((p): p is string => Boolean(p)).join(".");
}

/**
 * The cue to mark in a transcript at a moment: of those showing, the one that began last;
 * -1 between cues.
 */
export function activeCue(cues: readonly CaptionCue[], time: number): number {
  // The last cue to begin by now, found by halves: cues are in time order.
  let lo = 0;
  let hi = cues.length - 1;
  let last = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((cues[mid]?.start ?? 0) <= time) {
      last = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  // An earlier, longer cue can still be showing; a few back is as far as overlaps reach.
  for (let i = last; i >= 0 && i > last - 32; i--) {
    const cue = cues[i];
    if (cue && cue.start <= time && time < cue.end) return i;
  }
  return -1;
}

/**
 * A text folded for searching: lower case, accents dropped, each run of spaces and line
 * breaks one space; with, for each folded letter, where its letter begins and ends in the
 * original, so a match can be marked there.
 */
function fold(text: string): { folded: string; from: number[]; to: number[] } {
  let folded = "";
  const from: number[] = [];
  const to: number[] = [];
  let at = 0;
  for (const ch of text) {
    const f = /\s/.test(ch)
      ? folded.endsWith(" ")
        ? ""
        : " "
      : ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    for (let k = 0; k < f.length; k++) {
      from.push(at);
      to.push(at + ch.length);
    }
    folded += f;
    at += ch.length;
  }
  return { folded, from, to };
}

/** A search box's words as they are matched: folded, without spaces at either end. */
const needle = (query: string) => fold(query.trim()).folded;

/** Where a search matches in a text, as [start, end) ranges of the original, for marking. */
export function matchRanges(text: string, query: string): [number, number][] {
  const n = needle(query);
  if (!n) return [];
  const { folded, from, to } = fold(text);
  const ranges: [number, number][] = [];
  for (let i = folded.indexOf(n); i >= 0; i = folded.indexOf(n, i + n.length))
    ranges.push([from[i] ?? 0, to[i + n.length - 1] ?? text.length]);
  return ranges;
}

/**
 * A transcript searched (#201): the cues whose words hold the search as a phrase, whatever
 * the case and accents, across their line breaks. Their places in the track, in order.
 */
export function searchCues(cues: readonly CaptionCue[], query: string): number[] {
  const n = needle(query);
  if (!n) return [];
  const found: number[] = [];
  cues.forEach((c, i) => {
    if (fold(c.text).folded.includes(n)) found.push(i);
  });
  return found;
}

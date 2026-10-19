import { z } from "zod";
import type { Anchor } from "./anchor.ts";
import { formatAnchor } from "./format.ts";
import { speakerOf } from "./layouts.ts";

/**
 * A file's comment threads as a marker list another application reads (#99): a DAW's
 * markers, an NLE's timeline markers, a spreadsheet or a sheet to read. Everything here is
 * pure; the server gathers the threads, checks the reader may export them and logs it.
 */

/** The shape each application reads. */
export type ExportFormat = "csv" | "reaper" | "avid" | "edl" | "fcpxml" | "xmeml" | "midi" | "text";

export interface TargetInfo {
  label: string;
  format: ExportFormat;
  /** Where the file goes in the application, when its import is documented. */
  howTo?: string;
}

/**
 * Applications, in the order the export dialog lists them. Nuendo reads a CSV whose columns
 * it asks about on import; Pro Tools, a MIDI file of markers. Pyramix, SADiE and Sequoia wait
 * for marker lists exported from them to write against (#233).
 */
const targets = {
  "pro-tools": {
    label: "Pro Tools",
    format: "midi",
    howTo: "File, Import, MIDI, with markers imported.",
  },
  nuendo: {
    label: "Nuendo",
    format: "csv",
    howTo: "File, Import, CSV Marker; give Timecode In, Name and Comment their columns.",
  },
  reaper: {
    label: "Reaper",
    format: "reaper",
    howTo:
      "set the ruler to Hours:Minutes:Seconds:Frames, then Region/Marker Manager, right-click, Import.",
  },
  "final-cut-pro": {
    label: "Final Cut Pro",
    format: "fcpxml",
    howTo: "File, Import, XML: a project with a to-do marker per thread.",
  },
  resolve: {
    label: "DaVinci Resolve",
    format: "edl",
    howTo:
      "right-click the timeline in the media pool, then Timelines, Import, Timeline Markers from EDL.",
  },
  premiere: {
    label: "Premiere Pro",
    format: "xmeml",
    howTo: "File, Import: a sequence carrying the markers.",
  },
  avid: {
    label: "Avid Media Composer",
    format: "avid",
    howTo: "Markers window, right-click, Import Markers.",
  },
  csv: { label: "CSV", format: "csv" },
  text: { label: "Plain text", format: "text" },
} as const satisfies Record<string, TargetInfo>;

export type ExportTarget = keyof typeof targets;
export const exportTargets: Record<ExportTarget, TargetInfo> = targets;
const targetIds = Object.keys(exportTargets) as [ExportTarget, ...ExportTarget[]];

/** Frame rates a timecode can count in. */
export const frameRates = {
  "23.976": { label: "23.976", nominal: 24, num: 24000, den: 1001, drop: false },
  "24": { label: "24", nominal: 24, num: 24, den: 1, drop: false },
  "25": { label: "25", nominal: 25, num: 25, den: 1, drop: false },
  "29.97": { label: "29.97", nominal: 30, num: 30000, den: 1001, drop: false },
  "29.97df": { label: "29.97 drop", nominal: 30, num: 30000, den: 1001, drop: true },
  "30": { label: "30", nominal: 30, num: 30, den: 1, drop: false },
  "50": { label: "50", nominal: 50, num: 50, den: 1, drop: false },
  "59.94": { label: "59.94", nominal: 60, num: 60000, den: 1001, drop: false },
  "59.94df": { label: "59.94 drop", nominal: 60, num: 60000, den: 1001, drop: true },
  "60": { label: "60", nominal: 60, num: 60, den: 1, drop: false },
} as const;

export type FrameRateId = keyof typeof frameRates;
export type FrameRate = (typeof frameRates)[FrameRateId];
const rateIds = Object.keys(frameRates) as [FrameRateId, ...FrameRateId[]];

/** The standard rate nearest a measured one, for a video's own timecode. */
export function nearestFrameRate(fps: number): FrameRateId {
  let best: FrameRateId = "25";
  for (const id of rateIds) {
    const rate = frameRates[id];
    if (rate.drop) continue;
    if (
      Math.abs(rate.num / rate.den - fps) <
      Math.abs(frameRates[best].num / frameRates[best].den - fps)
    )
      best = id;
  }
  return best;
}

/**
 * How times are written. Timecode counts from 00:00:00:00 or, as NLE timelines usually
 * start, from 01:00:00:00; seconds and samples suit a spreadsheet.
 */
export const exportTimeBases = ["timecode", "timecode-hour", "seconds", "samples"] as const;
export type ExportTimeBase = (typeof exportTimeBases)[number];

/** The export dialog's choices, as the export route reads them from its query. */
export const commentExportQuery = z.object({
  target: z.enum(targetIds),
  /** Open threads only, or resolved ones too. */
  threads: z.enum(["open", "all"]).default("open"),
  /** Replies follow their thread's text. */
  replies: z.stringbool().default(false),
  time: z.enum(exportTimeBases).default("timecode"),
  /** For timecode; a video counts in its own rate unless this says otherwise. */
  rate: z.enum(rateIds).optional(),
  /** Older editing systems read Windows Latin-1 only. XML is always UTF-8. */
  encoding: z.enum(["utf-8", "latin-1"]).default("utf-8"),
});

export type CommentExportQuery = z.input<typeof commentExportQuery>;

/** The printable sheet's choices (#134): which threads, and whether their replies follow. */
export const commentSheetQuery = z.object({
  threads: z.enum(["open", "all"]).default("open"),
  replies: z.stringbool().default(true),
});
export type CommentExportOptions = z.output<typeof commentExportQuery>;

/** Which choices mean something for a target: the dialog offers only those. */
export function exportChoices(target: ExportTarget, file: { sampleRate: number | null }) {
  const format: ExportFormat = exportTargets[target].format;
  const free = format === "csv" && target === "csv";
  return {
    /** MIDI places markers in seconds from the file's start; it has no timecode. */
    timeBases: (format === "midi"
      ? []
      : free || format === "text"
        ? exportTimeBases.filter((t) => t !== "samples" || file.sampleRate)
        : (["timecode", "timecode-hour"] as const)) as ExportTimeBase[],
    encoding: format !== "fcpxml" && format !== "xmeml",
    /** Formats with no place for a thread that has no time leave it out. */
    untimed: free || format === "text",
  };
}

export interface ExportReply {
  author: string;
  body: string;
}

export interface ExportThread {
  anchor: Anchor | null;
  /** The channel it is about, by name (#74); null is every channel. */
  channel: string | null;
  author: string;
  body: string;
  resolved: boolean;
  replies: ExportReply[];
}

export interface ExportSource {
  /** The file's name, for titles and the download's name. */
  name: string;
  /** Seconds, when the file has a timeline. */
  duration: number | null;
  sampleRate: number | null;
  /** The video's own rate, used for timecode unless the options name one. */
  fps: number | null;
  /** Whether the file has pictures, which decides an Avid marker's track. */
  video: boolean;
}

export interface CommentExport {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  /** The text as written, for a preview; absent for a binary format. */
  text: string | null;
  /** Threads written, and those left out because the format needs a time they lack. */
  written: number;
  untimed: number;
}

/** A comment as the comments column holds it, with what the exporters need. */
export interface ListedComment {
  id: string;
  parentId: string | null;
  anchor: unknown;
  authorName: string | null;
  body: string;
  resolvedAt: string | Date | null;
  carry: { visible: boolean } | null;
  /** The channel it is about (#74), by its place in the file's order. */
  channel?: number | null;
}

/**
 * A file's comments, in the order the column lists them, as threads to export: hidden
 * carries left out (they are triage's to decide, not yet anyone's feedback), and replies
 * gathered under their thread in the order they were written.
 */
export function threadsForExport(
  rows: ListedComment[],
  /** The file's speakers, to name the channel a thread is about. */
  speakers: readonly string[] = [],
): ExportThread[] {
  const author = (name: string | null) => name ?? "A former member";
  const replies = new Map<string, ExportReply[]>();
  for (const row of rows) {
    if (!row.parentId) continue;
    replies.set(row.parentId, [
      ...(replies.get(row.parentId) ?? []),
      { author: author(row.authorName), body: row.body },
    ]);
  }
  return rows
    .filter((row) => !row.parentId && row.carry?.visible !== false)
    .map((row) => ({
      anchor: (row.anchor as Anchor | null) ?? null,
      channel: row.channel == null ? null : speakerOf(speakers, row.channel),
      author: author(row.authorName),
      body: row.body,
      resolved: row.resolvedAt !== null,
      replies: replies.get(row.id) ?? [],
    }));
}

/** Where a thread sits on the timeline, in seconds, or null when it has no time. */
export function threadTime(anchor: Anchor | null): { start: number; end: number } | null {
  if (!anchor) return null;
  if (anchor.kind === "time") return { start: anchor.start, end: anchor.end };
  if (anchor.at !== undefined)
    return {
      start: anchor.at,
      end: anchor.kind === "region" ? (anchor.end ?? anchor.at) : anchor.at,
    };
  return null;
}

// Timecode.

/** Frames at a rate, from seconds. */
export function framesAt(seconds: number, rate: FrameRate): number {
  return Math.round((seconds * rate.num) / rate.den);
}

/** Frames in the first hour of timecode: 01:00:00:00 as a frame count. */
export function hourFrames(rate: FrameRate): number {
  const drop = rate.drop ? (rate.nominal === 60 ? 4 : 2) : 0;
  return rate.nominal * 3600 - drop * 54;
}

const two = (n: number) => String(n).padStart(2, "0");

/**
 * SMPTE timecode for a frame count. Drop-frame skips labels (two a minute at 29.97,
 * four at 59.94, except every tenth minute) and separates its frames with a semicolon.
 */
export function timecode(frames: number, rate: FrameRate): string {
  let f = frames;
  const n = rate.nominal;
  if (rate.drop) {
    const drop = n === 60 ? 4 : 2;
    const perTen = n * 600 - drop * 9;
    const perMinute = n * 60 - drop;
    const tens = Math.floor(f / perTen);
    const rest = f % perTen;
    f += drop * 9 * tens + (rest > drop ? drop * Math.floor((rest - drop) / perMinute) : 0);
  }
  const ff = f % n;
  const ss = Math.floor(f / n) % 60;
  const mm = Math.floor(f / (n * 60)) % 60;
  const hh = Math.floor(f / (n * 3600)) % 24;
  return `${two(hh)}:${two(mm)}:${two(ss)}${rate.drop ? ";" : ":"}${two(ff)}`;
}

// Text.

const latin1Extras: Record<string, number> = {
  "€": 0x80,
  "‚": 0x82,
  ƒ: 0x83,
  "„": 0x84,
  "…": 0x85,
  "†": 0x86,
  "‡": 0x87,
  ˆ: 0x88,
  "‰": 0x89,
  Š: 0x8a,
  "‹": 0x8b,
  Œ: 0x8c,
  Ž: 0x8e,
  "‘": 0x91,
  "’": 0x92,
  "“": 0x93,
  "”": 0x94,
  "•": 0x95,
  "–": 0x96,
  "—": 0x97,
  "˜": 0x98,
  "™": 0x99,
  š: 0x9a,
  "›": 0x9b,
  œ: 0x9c,
  ž: 0x9e,
  Ÿ: 0x9f,
};

/**
 * Text as bytes. Latin-1 here is Windows-1252, what older editing systems read: letters it
 * lacks lose their accents (ő becomes o), and anything else becomes a question mark.
 */
export function encodeText(text: string, encoding: "utf-8" | "latin-1"): Uint8Array {
  const out: number[] = [];
  if (encoding === "utf-8") {
    for (const ch of text) {
      const c = ch.codePointAt(0) ?? 0x3f;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      else
        out.push(
          0xf0 | (c >> 18),
          0x80 | ((c >> 12) & 0x3f),
          0x80 | ((c >> 6) & 0x3f),
          0x80 | (c & 0x3f),
        );
    }
    return Uint8Array.from(out);
  }
  for (const ch of text.normalize("NFC")) {
    const code = ch.codePointAt(0) ?? 0x3f;
    const extra = latin1Extras[ch];
    if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) out.push(code);
    else if (extra !== undefined) out.push(extra);
    else {
      const bare = ch.normalize("NFD").replace(/\p{M}/gu, "");
      const b = bare.codePointAt(0) ?? 0x3f;
      out.push(bare.length === 1 && (b < 0x80 || (b >= 0xa0 && b <= 0xff)) ? b : 0x3f);
    }
  }
  return Uint8Array.from(out);
}

/** One line: line breaks and tabs become spaces, runs of space one. */
const flat = (s: string) =>
  s
    .replace(/[\t\r\n]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();

/** The first line of a comment, shortened for a marker's name. */
function headline(body: string, max = 72): string {
  const first = flat(body.split(/\r?\n/, 1)[0] ?? "");
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

/**
 * What a marker is called: where a bar was named, the bar; the channel it is about, if one;
 * then who said what.
 */
function markerName(t: ExportThread): string {
  const bar = t.anchor?.kind === "bar" ? `${formatAnchor(t.anchor)} ` : "";
  const channel = t.channel ? `[${t.channel}] ` : "";
  return `${bar}${channel}${t.author}: ${headline(t.body)}`;
}

/** The whole thread as text: the comment, then each reply on a line of its own. */
function threadText(t: ExportThread, newline: string): string {
  return [t.body, ...t.replies.map((r) => `Reply from ${r.author}: ${r.body}`)]
    .map((s) => s.replace(/\r?\n/g, newline))
    .join(newline);
}

/** The whole thread on one line, for formats with a single field. */
const threadLine = (t: ExportThread) =>
  [markerName(t), ...t.replies.map((r) => `Reply from ${r.author}: ${flat(r.body)}`)].join(" / ");

const csvCell = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** People's words in a spreadsheet cell: never read as a formula (OWASP's CSV injection). */
const spreadsheetText = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);

/** XML text: escaped, and without the control characters XML 1.0 forbids. */
const xml = (s: string) =>
  s
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** The download's name: the file's, without its extension, then what it holds. */
function downloadName(source: ExportSource, extension: string): string {
  const base = source.name
    .replace(/\.[^./\\]{1,8}$/, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point.
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
  return `${base || "Comments"} comments.${extension}`;
}

// Writers.

interface Placed {
  thread: ExportThread;
  start: number;
  end: number;
}

interface Context {
  source: ExportSource;
  options: CommentExportOptions;
  rate: FrameRate;
  /** Frames added to every time: one hour when the timeline starts at 01:00:00:00. */
  offset: number;
}

/** A time as the options ask: timecode, seconds or samples. */
function written(seconds: number, ctx: Context): string {
  switch (ctx.options.time) {
    case "seconds":
      return seconds.toFixed(3);
    case "samples":
      return String(Math.round(seconds * (ctx.source.sampleRate ?? 48_000)));
    default:
      return timecode(framesAt(seconds, ctx.rate) + ctx.offset, ctx.rate);
  }
}

function writeCsv(threads: ExportThread[], ctx: Context): string {
  const tc = ctx.options.time === "timecode" || ctx.options.time === "timecode-hour";
  const unit = ctx.options.time === "samples" ? "samples" : "seconds";
  const header = [
    tc ? "Timecode In" : `Start (${unit})`,
    tc ? "Timecode Out" : `End (${unit})`,
    "Name",
    "Comment",
    "Author",
    "Anchor",
    "Status",
    "Channel",
  ];
  const rows = threads.map((t) => {
    const at = threadTime(t.anchor);
    return [
      at ? written(at.start, ctx) : "",
      at ? written(Math.max(at.end, at.start), ctx) : "",
      spreadsheetText(markerName(t)),
      spreadsheetText(threadText(t, "\n")),
      spreadsheetText(t.author),
      t.anchor ? formatAnchor(t.anchor) : "Whole file",
      t.resolved ? "Resolved" : "Open",
      t.channel ?? "Every channel",
    ];
  });
  return `${[header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** Reaper's region and marker list: markers for instants, regions for ranges. */
function writeReaper(placed: Placed[], ctx: Context): string {
  let markers = 0;
  let regions = 0;
  const lines = placed.map(({ thread, start, end }) => {
    const name = csvCell(threadLine(thread));
    if (end > start) {
      regions += 1;
      const length = timecode(framesAt(end, ctx.rate) - framesAt(start, ctx.rate), ctx.rate);
      return `R${regions},${name},${written(start, ctx)},${written(end, ctx)},${length},`;
    }
    markers += 1;
    return `M${markers},${name},${written(start, ctx)},,,`;
  });
  return `${["#,Name,Start,End,Length,Color", ...lines].join("\r\n")}\r\n`;
}

/**
 * Media Composer's marker text: user, timecode, track, colour, comment and duration in
 * frames, tab-separated, with Unix line ends (it refuses others). Open threads are red,
 * resolved ones green.
 */
function writeAvid(placed: Placed[], ctx: Context): string {
  const track = ctx.source.video ? "V1" : "A1";
  const lines = placed.map(({ thread, start, end }) => {
    const frames = Math.max(1, framesAt(end, ctx.rate) - framesAt(start, ctx.rate));
    return [
      flat(thread.author),
      written(start, ctx),
      track,
      thread.resolved ? "green" : "red",
      flat(threadLine(thread)),
      String(frames),
    ].join("\t");
  });
  return lines.map((l) => `${l}\n`).join("");
}

/** A marker EDL as DaVinci Resolve writes and reads it: one event per marker. */
function writeEdl(placed: Placed[], ctx: Context): string {
  const lines = [
    `TITLE: ${flat(ctx.source.name).slice(0, 60)}`,
    `FCM: ${ctx.rate.drop ? "DROP FRAME" : "NON-DROP FRAME"}`,
    "",
  ];
  placed.forEach(({ thread, start, end }, i) => {
    const from = framesAt(start, ctx.rate) + ctx.offset;
    const frames = Math.max(1, framesAt(end, ctx.rate) - framesAt(start, ctx.rate));
    const a = timecode(from, ctx.rate);
    const b = timecode(from + frames, ctx.rate);
    lines.push(
      `${String(i + 1).padStart(3, "0")}  001      V     C        ${a} ${b} ${a} ${b}  `,
      ` |C:${thread.resolved ? "ResolveColorGreen" : "ResolveColorRed"} |M:${threadLine(thread).replace(/\|/g, "/")} |D:${frames}`,
      "",
    );
  });
  return lines.join("\r\n");
}

/** A rational time in seconds, as FCPXML writes it: frames times the frame's duration. */
const rational = (frames: number, rate: FrameRate) =>
  frames === 0 ? "0s" : `${frames * rate.den}/${rate.num}s`;

/** Timeline length in frames: the file, or past the last marker when it is unknown. */
function timelineFrames(placed: Placed[], ctx: Context): number {
  const last = Math.max(0, ...placed.map((p) => p.end));
  return framesAt(Math.max(ctx.source.duration ?? 0, last + 1), ctx.rate);
}

/**
 * Final Cut Pro: a project whose timeline is one gap the length of the file, carrying a
 * to-do marker per thread, completed where the thread is resolved.
 */
function writeFcpxml(placed: Placed[], ctx: Context): string {
  const { rate } = ctx;
  const length = rational(timelineFrames(placed, ctx), rate);
  const start = rational(ctx.offset, rate);
  const name = xml(`${ctx.source.name} comments`);
  const markers = placed.map(({ thread, start: s, end }) => {
    const at = rational(framesAt(s, rate), rate);
    const frames = Math.max(1, framesAt(end, rate) - framesAt(s, rate));
    return `            <marker start="${at}" duration="${rational(frames, rate)}" value="${xml(markerName(thread))}" completed="${thread.resolved ? 1 : 0}" note="${xml(threadText(thread, "\n"))}"/>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<!DOCTYPE fcpxml>",
    '<fcpxml version="1.9">',
    "  <resources>",
    `    <format id="r1" frameDuration="${rational(1, rate)}" width="1920" height="1080"/>`,
    "  </resources>",
    `  <event name="${xml("Hekate comments")}">`,
    `    <project name="${name}">`,
    `      <sequence format="r1" duration="${length}" tcStart="${start}" tcFormat="${rate.drop ? "DF" : "NDF"}">`,
    "        <spine>",
    `          <gap name="Comments" offset="${start}" start="0s" duration="${length}">`,
    ...markers,
    "          </gap>",
    "        </spine>",
    "      </sequence>",
    "    </project>",
    "  </event>",
    "</fcpxml>",
    "",
  ].join("\n");
}

/** Premiere Pro reads Final Cut 7's XML: a sequence carrying markers, in frames. */
function writeXmeml(placed: Placed[], ctx: Context): string {
  const { rate } = ctx;
  const ntsc = rate.den === 1001 ? "TRUE" : "FALSE";
  const timebase = `<rate><timebase>${rate.nominal}</timebase><ntsc>${ntsc}</ntsc></rate>`;
  const markers = placed.flatMap(({ thread, start, end }) => {
    const from = framesAt(start, rate);
    const to = end > start ? framesAt(end, rate) : -1;
    return [
      "    <marker>",
      `      <name>${xml(markerName(thread))}</name>`,
      `      <comment>${xml(threadText(thread, "\n"))}</comment>`,
      `      <in>${from}</in>`,
      `      <out>${to}</out>`,
      "    </marker>",
    ];
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<!DOCTYPE xmeml>",
    '<xmeml version="4">',
    '  <sequence id="sequence-1">',
    `    <name>${xml(`${ctx.source.name} comments`)}</name>`,
    `    <duration>${timelineFrames(placed, ctx)}</duration>`,
    `    ${timebase}`,
    "    <timecode>",
    `      ${timebase}`,
    `      <string>${timecode(ctx.offset, rate)}</string>`,
    `      <frame>${ctx.offset}</frame>`,
    `      <displayformat>${rate.drop ? "DF" : "NDF"}</displayformat>`,
    "    </timecode>",
    "    <media>",
    "      <video>",
    "        <format><samplecharacteristics><width>1920</width><height>1080</height></samplecharacteristics></format>",
    "        <track/>",
    "      </video>",
    "      <audio><track/></audio>",
    "    </media>",
    ...markers,
    "  </sequence>",
    "</xmeml>",
    "",
  ].join("\n");
}

/** A sheet to read: each thread with its place, author, status and replies. */
function writeText(threads: ExportThread[], ctx: Context): string {
  const lines = [`Comments on ${ctx.source.name}`, ""];
  threads.forEach((t, i) => {
    const at = threadTime(t.anchor);
    const when = at ? written(at.start, ctx) : "";
    const where = t.anchor && t.anchor.kind !== "time" ? formatAnchor(t.anchor) : "";
    const channel = t.channel ? `[${t.channel}]` : "";
    const place = [when || where ? "" : "Whole file", when, where, channel]
      .filter(Boolean)
      .join("  ");
    lines.push(
      `${String(i + 1).padStart(3, "0")}  ${place}  ${t.author}${t.resolved ? " (resolved)" : ""}`,
    );
    for (const line of t.body.split(/\r?\n/)) lines.push(`     ${line}`);
    for (const r of t.replies) {
      const [first = "", ...rest] = r.body.split(/\r?\n/);
      lines.push(`     Reply from ${r.author}: ${first}`, ...rest.map((l) => `       ${l}`));
    }
    lines.push("");
  });
  return lines.join("\r\n");
}

// MIDI.

/** A variable-length quantity, as MIDI writes delta times and lengths. */
function vlq(value: number): number[] {
  const bytes = [value & 0x7f];
  let v = value >>> 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return bytes;
}

/** Ticks a second at the file's tempo: 960 a quarter note at 120 beats a minute. */
const TICKS_PER_SECOND = 1920;

/**
 * A Standard MIDI File holding one marker per thread, at 120 beats a minute so a tick is
 * a fixed slice of time. Editing systems read its markers in seconds from the start.
 */
function writeMidi(placed: Placed[], ctx: Context): Uint8Array {
  const meta = (type: number, data: number[] | Uint8Array) => [
    0xff,
    type,
    ...vlq(data.length),
    ...data,
  ];
  const events: number[] = [];
  let last = 0;
  const at = (tick: number) => {
    events.push(...vlq(tick - last));
    last = tick;
  };
  at(0);
  events.push(...meta(0x03, encodeText(`${ctx.source.name} comments`, ctx.options.encoding)));
  at(0);
  events.push(...meta(0x51, [0x07, 0xa1, 0x20]));
  at(0);
  events.push(...meta(0x58, [4, 2, 24, 8]));
  for (const { thread, start } of placed) {
    at(Math.round(start * TICKS_PER_SECOND));
    events.push(...meta(0x06, encodeText(threadLine(thread), ctx.options.encoding)));
  }
  at(last);
  events.push(0xff, 0x2f, 0x00);
  const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  return Uint8Array.from([
    ...[0x4d, 0x54, 0x68, 0x64], // MThd
    ...u32(6),
    0x00,
    0x00, // format 0: one track
    0x00,
    0x01, // one track
    0x03,
    0xc0, // 960 ticks a quarter note
    ...[0x4d, 0x54, 0x72, 0x6b], // MTrk
    ...u32(events.length),
    ...events,
  ]);
}

const formats: Record<ExportFormat, { extension: string; contentType: string }> = {
  csv: { extension: "csv", contentType: "text/csv" },
  reaper: { extension: "csv", contentType: "text/csv" },
  avid: { extension: "txt", contentType: "text/plain" },
  edl: { extension: "edl", contentType: "text/plain" },
  fcpxml: { extension: "fcpxml", contentType: "application/xml" },
  xmeml: { extension: "xml", contentType: "application/xml" },
  midi: { extension: "mid", contentType: "audio/midi" },
  text: { extension: "txt", contentType: "text/plain" },
};

/**
 * A file's threads in a target's format. Threads arrive in the order the comments column
 * shows them; timed ones are written in time order, and those without a time follow where
 * the format has room for them.
 */
export function exportComments(
  all: ExportThread[],
  source: ExportSource,
  options: CommentExportOptions,
): CommentExport {
  const target = exportTargets[options.target];
  const format: ExportFormat = target.format;
  const choices = exportChoices(options.target, source);
  const time = choices.timeBases.includes(options.time)
    ? options.time
    : (choices.timeBases[0] ?? "seconds");
  const opts: CommentExportOptions = { ...options, time };
  const rate = frameRates[options.rate ?? (source.fps ? nearestFrameRate(source.fps) : "25")];
  const ctx: Context = {
    source,
    options: opts,
    rate,
    offset: time === "timecode-hour" ? hourFrames(rate) : 0,
  };
  const chosen = all
    .filter((t) => opts.threads === "all" || !t.resolved)
    .map((t) => (opts.replies ? t : { ...t, replies: [] }));
  const timed = chosen
    .map((thread) => ({ thread, at: threadTime(thread.anchor) }))
    .filter((p): p is { thread: ExportThread; at: { start: number; end: number } } => p.at !== null)
    .map(({ thread, at }) => ({ thread, start: at.start, end: Math.max(at.start, at.end) }))
    .sort((a, b) => a.start - b.start);
  const untimed = chosen.filter((t) => !threadTime(t.anchor));
  const listed = [...timed.map((p) => p.thread), ...untimed];

  let text: string | null = null;
  let bytes: Uint8Array;
  switch (format) {
    case "csv":
      text = writeCsv(choices.untimed ? listed : timed.map((p) => p.thread), ctx);
      break;
    case "reaper":
      text = writeReaper(timed, ctx);
      break;
    case "avid":
      text = writeAvid(timed, ctx);
      break;
    case "edl":
      text = writeEdl(timed, ctx);
      break;
    case "fcpxml":
      text = writeFcpxml(timed, ctx);
      break;
    case "xmeml":
      text = writeXmeml(timed, ctx);
      break;
    case "text":
      text = writeText(listed, ctx);
      break;
    case "midi":
      break;
  }
  if (format === "midi") bytes = writeMidi(timed, ctx);
  else bytes = encodeText(text ?? "", choices.encoding ? opts.encoding : "utf-8");
  const { extension, contentType } = formats[format];
  const charset =
    format === "midi"
      ? ""
      : `; charset=${choices.encoding && opts.encoding === "latin-1" ? "windows-1252" : "utf-8"}`;
  return {
    filename: downloadName(source, extension),
    contentType: `${contentType}${charset}`,
    bytes,
    text,
    written: choices.untimed ? listed.length : timed.length,
    untimed: choices.untimed ? 0 : untimed.length,
  };
}

import { type FrameRate, type FrameRateId, frameRates } from "./comment-export.ts";
import { END_TOLERANCE } from "./comments.ts";

/**
 * A marker list from another application, read back as comments (#134): the reverse of the
 * comment export (#99). Everything here is pure: the browser reads the list and shows what it
 * found, and only the markers chosen reach the server, which checks them like any comment.
 * Pyramix, SADiE and Sequoia wait for lists exported from them to read against (#233).
 */

export type MarkerListFormat =
  | "edl"
  | "fcpxml"
  | "xmeml"
  | "avid"
  | "reaper"
  | "pro-tools"
  | "midi"
  | "csv"
  | "text";

/** What each format is called where a list is shown. */
export const markerListFormats: Record<MarkerListFormat, string> = {
  edl: "DaVinci Resolve marker list",
  fcpxml: "Final Cut Pro XML",
  xmeml: "Premiere Pro XML",
  avid: "Avid Media Composer markers",
  reaper: "Reaper markers and regions",
  "pro-tools": "Pro Tools session text",
  midi: "MIDI markers",
  csv: "CSV",
  text: "Plain text",
};

/** One marker as the list gives it, its times in seconds from the start of the file. */
export interface ListedMarker {
  /** Where it is in the list (a line, a row or the marker's place), for the preview. */
  row: number;
  /** Null where the list's time cannot be read as one (bars and beats, say). */
  start: number | null;
  /** The end of a range; null for a marker at one moment. */
  end: number | null;
  /** The time as the list wrote it. */
  time: string;
  name: string;
  comment: string;
  /** The list's own colour or kind of marker, as it names it. */
  colour: string | null;
  /** Who the list says made it, where it says. */
  author: string | null;
}

export interface MarkerList {
  format: MarkerListFormat;
  markers: ListedMarker[];
  /** The timecode rate it was read at, where it counts in timecode. */
  rate: FrameRateId | null;
  /** Whether that rate was worked out from the frame numbers rather than given. */
  rateGuessed: boolean;
  /** Seconds taken off every time: where the list's timeline starts (01:00:00:00, often). */
  startsAt: number;
}

export class MarkerListError extends Error {}

/** The most markers one list may bring in. */
export const MARKER_LIST_MAX = 2_000;

// Text.

const WINDOWS_1252: Record<number, number> = {
  128: 0x20ac,
  130: 0x201a,
  131: 0x0192,
  132: 0x201e,
  133: 0x2026,
  134: 0x2020,
  135: 0x2021,
  136: 0x02c6,
  137: 0x2030,
  138: 0x0160,
  139: 0x2039,
  140: 0x0152,
  142: 0x017d,
  145: 0x2018,
  146: 0x2019,
  147: 0x201c,
  148: 0x201d,
  149: 0x2022,
  150: 0x2013,
  151: 0x2014,
  152: 0x02dc,
  153: 0x2122,
  154: 0x0161,
  155: 0x203a,
  156: 0x0153,
  158: 0x017e,
  159: 0x0178,
};

/** UTF-8, or null where the bytes are not. */
function utf8(bytes: Uint8Array): string | null {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i] as number;
    let code: number;
    let more: number;
    if (b < 0x80) [code, more] = [b, 0];
    else if (b >= 0xc2 && b < 0xe0) [code, more] = [b & 0x1f, 1];
    else if (b >= 0xe0 && b < 0xf0) [code, more] = [b & 0x0f, 2];
    else if (b >= 0xf0 && b < 0xf5) [code, more] = [b & 0x07, 3];
    else return null;
    if (i + more >= bytes.length && more > 0) return null;
    for (let k = 1; k <= more; k++) {
      const next = bytes[i + k];
      if (next === undefined || (next & 0xc0) !== 0x80) return null;
      code = (code << 6) | (next & 0x3f);
    }
    out += String.fromCodePoint(code);
    i += more + 1;
  }
  return out;
}

/** A list's text: UTF-16 where a byte order mark says so, UTF-8, else Windows Latin-1. */
export function decodeList(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    let out = "";
    for (let i = 2; i + 1 < bytes.length; i += 2)
      out += String.fromCharCode((bytes[i] as number) | ((bytes[i + 1] as number) << 8));
    return out;
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = "";
    for (let i = 2; i + 1 < bytes.length; i += 2)
      out += String.fromCharCode(((bytes[i] as number) << 8) | (bytes[i + 1] as number));
    return out;
  }
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const body = bytes.subarray(start);
  const text = utf8(body);
  if (text !== null) return text;
  let out = "";
  for (const b of body) out += String.fromCharCode(WINDOWS_1252[b] ?? b);
  return out;
}

const lines = (text: string) => text.split(/\r\n|\r|\n/);

// Times.

/** A time as written, before the list's rate is known: seconds, or a timecode to read. */
type Time = { seconds: number } | { timecode: string } | { unreadable: string };

const TIMECODE = /^(\d{1,2}):(\d{2}):(\d{2})([:;])(\d{2})$/;

/**
 * A time as lists write it: a timecode (01:00:06:05, or with ";" for drop frame), a clock
 * (1:02:03.5 or 0:06.200) or plain seconds (6.2). Bars and beats, and anything else, cannot
 * be read as a time without the session's tempo.
 */
export function readTime(text: string): Time {
  const t = text.trim();
  if (TIMECODE.test(t)) return { timecode: t.length === 10 ? `0${t}` : t };
  let m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(t);
  if (m) return { seconds: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) };
  m = /^(\d+):(\d{2}(?:\.\d+)?)$/.exec(t);
  if (m) return { seconds: Number(m[1]) * 60 + Number(m[2]) };
  if (/^\d+(?:\.\d+)?$/.test(t)) return { seconds: Number(t) };
  return { unreadable: t };
}

interface RawMarker {
  row: number;
  start: Time;
  end?: Time | null;
  /** A length in frames at the list's timecode rate, where the list gives one so. */
  frames?: number | null;
  time?: string;
  name: string;
  comment?: string;
  colour?: string | null;
  author?: string | null;
}

interface Read {
  format: MarkerListFormat;
  raw: RawMarker[];
  /** A rate the list states; otherwise one is worked out from its frame numbers. */
  rate?: FrameRateId | null;
  /** Where the list's timeline starts, where it says; otherwise timecodes start on the hour. */
  startsAt?: number;
}

/** The lowest rate every frame number fits under, as for an edit decision list. */
function guessRate(codes: string[]): FrameRateId {
  let highest = 0;
  for (const code of codes) highest = Math.max(highest, Number(code.slice(-2)));
  if (codes.some((c) => c.includes(";"))) return highest >= 30 ? "59.94df" : "29.97df";
  return highest >= 25 ? "30" : "25";
}

/**
 * A timecode in seconds at a rate: frames counted at its whole number (with drop frame's
 * skipped numbers), each lasting as long as the rate's frames do, so 23.976 and 29.97 run a
 * thousandth slower than 24 and 30.
 */
export function timecodeAt(code: string, rate: FrameRate): number | null {
  const m = TIMECODE.exec(code.trim());
  if (!m) return null;
  const [h, min, s, f] = [m[1], m[2], m[3], m[5]].map(Number) as [number, number, number, number];
  if (min > 59 || s > 59 || f >= rate.nominal) return null;
  const minutes = h * 60 + min;
  let frames = (minutes * 60 + s) * rate.nominal + f;
  if (rate.drop) frames -= (rate.nominal === 60 ? 4 : 2) * (minutes - Math.floor(minutes / 10));
  return (frames * rate.den) / rate.num;
}

/** A time as the list wrote it, for the preview. */
const written = (t: Time) =>
  "timecode" in t ? t.timecode : "unreadable" in t ? t.unreadable : String(t.seconds);

function finish(read: Read, chosen?: FrameRateId | null): MarkerList {
  const codes = read.raw.flatMap((m) =>
    [m.start, m.end].flatMap((t) => (t && "timecode" in t ? [t.timecode] : [])),
  );
  let given = read.rate ?? chosen ?? null;
  // A list that writes ";" before its frames is in drop frame, whatever else is said.
  if (given && !frameRates[given].drop && codes.some((c) => c.includes(";")))
    given = frameRates[given].nominal === 60 ? "59.94df" : "29.97df";
  const id = codes.length > 0 ? (given ?? guessRate(codes)) : given;
  const rate = id ? frameRates[id] : null;
  const seconds = (t: Time | null | undefined): number | null => {
    if (!t) return null;
    if ("seconds" in t) return Number.isFinite(t.seconds) ? t.seconds : null;
    if ("timecode" in t) return rate === null ? null : timecodeAt(t.timecode, rate);
    return null;
  };
  const times = read.raw.map((m) => {
    const start = seconds(m.start);
    let end = seconds(m.end);
    if (end === null && start !== null && m.frames && rate)
      end = start + (m.frames * rate.den) / rate.num;
    return { start, end };
  });
  // A timeline in timecode starts on the hour its earliest marker is labelled with, as an
  // editor's does (01:00:00:00, most often), counted at the list's rate.
  const hours = read.raw.flatMap((m) =>
    "timecode" in m.start ? [Number(m.start.timecode.slice(0, 2))] : [],
  );
  const hour = hours.length > 0 ? Math.min(...hours) : null;
  const startsAt =
    read.startsAt ??
    (hour !== null && rate
      ? (timecodeAt(`${String(hour).padStart(2, "0")}:00:00:00`, rate) ?? 0)
      : 0);
  const markers = read.raw.slice(0, MARKER_LIST_MAX).map((m, i): ListedMarker => {
    const { start, end } = times[i] as { start: number | null; end: number | null };
    const shifted = start === null ? null : start - startsAt;
    const until = end === null ? null : end - startsAt;
    return {
      row: m.row,
      start: shifted,
      end: until !== null && shifted !== null && until > shifted ? until : null,
      time: m.time ?? written(m.start),
      name: m.name.trim(),
      comment: (m.comment ?? "").trim(),
      colour: m.colour?.trim() || null,
      author: m.author?.trim() || null,
    };
  });
  return {
    format: read.format,
    markers,
    rate: codes.length > 0 ? id : (read.rate ?? null),
    rateGuessed: codes.length > 0 && given === null,
    startsAt,
  };
}

/** The rate a list names by its frames a second, and whether it drops frames. */
function rateNamed(fps: number, drop: boolean): FrameRateId | null {
  const ids = Object.keys(frameRates) as FrameRateId[];
  return (
    ids.find((id) => {
      const rate = frameRates[id];
      return rate.drop === drop && Math.abs(rate.num / rate.den - fps) < 0.01;
    }) ?? null
  );
}

// CSV.

/** Rows of a delimited text, with quoted fields as spreadsheets write them. */
export function csvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

/** The delimiter a header line uses: the commonest of comma, semicolon and tab. */
function delimiterOf(line: string): string {
  const counts = [",", ";", "\t"].map((d) => [d, line.split(d).length - 1] as const);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ",";
}

const heading = (h: string) => h.trim().toLowerCase().replace(/\s+/g, " ");

/** Which column holds what, by the words its heading uses. */
function columnsOf(header: string[]) {
  const names = header.map(heading);
  const find = (test: (h: string) => boolean) => names.findIndex(test);
  return {
    start: find((h) =>
      /^(timecode in|tc in|record in|start|start time|position|location|in|time|start \(.*\))$/.test(
        h,
      ),
    ),
    end: find((h) => /^(timecode out|tc out|record out|end|end time|out|end \(.*\))$/.test(h)),
    name: find((h) => /^(name|marker|marker name|title|label)$/.test(h)),
    comment: find((h) => /^(comment|comments|description|notes?|text)$/.test(h)),
    colour: find((h) => /^(colou?r)$/.test(h)),
    author: find((h) => /^(author|user|by)$/.test(h)),
    samples: names.some((h) => /\(samples\)$/.test(h)),
  };
}

function readCsv(text: string, sampleRate: number | null): Read {
  const first = lines(text).find((l) => l.trim() !== "") ?? "";
  const rows = csvRows(text, delimiterOf(first));
  const [header, ...body] = rows;
  if (!header) throw new MarkerListError("The list is empty");
  const columns = columnsOf(header);
  if (columns.start < 0) throw new MarkerListError("The list has no column of times");
  const cell = (row: string[], index: number) => (index >= 0 ? (row[index] ?? "").trim() : "");
  const timeOf = (value: string): Time | null => {
    if (value === "") return null;
    if (columns.samples) {
      return /^\d+$/.test(value) && sampleRate
        ? { seconds: Number(value) / sampleRate }
        : { unreadable: value };
    }
    return readTime(value);
  };
  return {
    format: "csv",
    raw: body.map((row, i) => {
      const comment = cell(row, columns.comment);
      const name = cell(row, columns.name);
      return {
        row: i + 2,
        start: timeOf(cell(row, columns.start)) ?? { unreadable: "" },
        end: timeOf(cell(row, columns.end)),
        time: cell(row, columns.start),
        // A list with only a comment column names its markers by their comment.
        name: name || comment,
        comment: name ? comment : "",
        colour: cell(row, columns.colour),
        author: cell(row, columns.author),
      };
    }),
  };
}

/** Reaper's region and marker list: M1 for a marker, R1 for a region with its end. */
function readReaper(text: string): Read {
  const rows = csvRows(text, ",");
  return {
    format: "reaper",
    raw: rows.slice(1).flatMap((row, i) => {
      const [id = "", name = "", start = "", end = "", , colour = ""] = row;
      if (!/^[MR]\d+$/i.test(id.trim())) return [];
      return [
        {
          row: i + 2,
          start: readTime(start),
          end: id.trim().toUpperCase().startsWith("R") && end.trim() ? readTime(end) : null,
          time: start.trim(),
          name,
          colour: colour.trim() ? `#${colour.trim().replace(/^#/, "")}` : null,
        },
      ];
    }),
  };
}

/** The colours Media Composer gives markers. */
const AVID_COLOURS = /^(red|green|blue|cyan|magenta|yellow|black|white)$/i;

/**
 * Media Composer's marker text: user, timecode, track, colour, comment and duration in
 * frames, tab-separated, a line a marker.
 */
function readAvid(text: string): Read {
  return {
    format: "avid",
    raw: lines(text).flatMap((line, i) => {
      const fields = line.split("\t");
      const [user = "", tc = "", , colour = "", comment = "", duration = ""] = fields;
      if (fields.length < 5 || !TIMECODE.test(tc.trim()) || !AVID_COLOURS.test(colour.trim()))
        return [];
      const frames = Number.parseInt(duration, 10);
      return [
        {
          row: i + 1,
          start: readTime(tc),
          frames: frames > 1 ? frames : null,
          name: comment,
          colour,
          author: user,
        },
      ];
    }),
  };
}

/**
 * A marker EDL as DaVinci Resolve writes it: an event a marker, its record timecodes, and a
 * note line with its colour, name and length in frames.
 */
function readResolveEdl(text: string): Read {
  const all = lines(text);
  const raw: RawMarker[] = [];
  const event = /^\s*\d{1,6}\s+\S+\s+\S+\s+\S+\s+(?:\d+\s+)?(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*$/;
  let dropFrame = false;
  all.forEach((line, i) => {
    if (/^FCM:\s*DROP FRAME/i.test(line)) dropFrame = true;
    const m = event.exec(line);
    if (!m || !TIMECODE.test(m[3] as string)) return;
    const note = all[i + 1] ?? "";
    if (!note.includes("|M:") && !note.includes("|C:")) return;
    const name = /\|M:(.*?)(?:\s\|D:|\s\|C:|$)/.exec(note)?.[1] ?? "";
    const colour = /\|C:(?:ResolveColor)?(\S+)/.exec(note)?.[1] ?? null;
    const frames = Number(/\|D:(\d+)/.exec(note)?.[1] ?? "0");
    raw.push({
      row: i + 1,
      start: readTime(m[3] as string),
      frames: frames > 1 ? frames : null,
      name,
      colour: colour?.replace(/([a-z])([A-Z])/g, "$1 $2") ?? null,
    });
  });
  if (raw.length === 0) throw new MarkerListError("This edit decision list has no markers in it");
  return { format: "edl", raw, rate: dropFrame ? "29.97df" : null };
}

/**
 * The marker section of the text Pro Tools exports (File, Export, Session Info as Text): a
 * tab-separated table under "M A R K E R S  L I S T I N G", its columns named in its first
 * row. A time reference in samples, against the session's rate, is the surest time.
 */
function readProTools(text: string): Read {
  const all = lines(text);
  const at = all.findIndex((l) => /M\s?A\s?R\s?K\s?E\s?R\s?S\s+L\s?I\s?S\s?T\s?I\s?N\s?G/.test(l));
  const sampleRate = Number(/^SAMPLE RATE:\s*([\d.]+)/m.exec(text)?.[1] ?? "0") || null;
  const tc = /^TIMECODE FORMAT:\s*([\d.]+)\s*(?:Frame)?\s*(Drop)?/im.exec(text);
  const rate = tc ? rateNamed(Number(tc[1]), Boolean(tc[2])) : null;
  let header: string[] | null = null;
  const raw: RawMarker[] = [];
  for (let i = at + 1; i < all.length; i++) {
    const line = all[i] as string;
    if (line.trim() === "") {
      if (header) break;
      continue;
    }
    const cells = line.split("\t").map((c) => c.trim());
    if (!header) {
      header = cells.map((c) => c.toUpperCase());
      continue;
    }
    const col = (name: string) => cells[header?.indexOf(name) ?? -1] ?? "";
    const location = col("LOCATION");
    const reference = col("TIME REFERENCE");
    const inSamples = /^samples$/i.test(col("UNITS")) && /^\d+$/.test(reference) && sampleRate;
    raw.push({
      row: i + 1,
      start: inSamples
        ? { seconds: Number(reference) / (sampleRate as number) }
        : readTime(location),
      time: location,
      name: col("NAME"),
      comment: col("COMMENTS"),
    });
  }
  if (raw.length === 0) throw new MarkerListError("The session has no markers");
  const sampled = raw.every((m) => "seconds" in m.start);
  return {
    format: "pro-tools",
    raw,
    rate,
    // Samples count from the session's start; a location in timecode starts on the hour.
    ...(sampled ? { startsAt: 0 } : {}),
  };
}

/**
 * Lines of plain text that begin with a time (after a number, as a numbered list has),
 * followed by what the marker says; indented lines under one carry on its comment. Read word
 * by word rather than by one pattern, so a long line costs no more than its length.
 */
function readText(text: string): Read {
  const raw: RawMarker[] = [];
  lines(text).forEach((line, i) => {
    const words = line.trim().split(/\s+/);
    const readable = (word: string | undefined) =>
      word !== undefined && /^\d/.test(word) && !("unreadable" in readTime(word));
    // "001  10.000  Mira Solberg": a number before a time numbers the line.
    const at = /^\d{1,4}[.)]?$/.test(words[0] ?? "") && readable(words[1]) ? 1 : 0;
    const word = words[at];
    if (!/^\s/.test(line) && readable(word)) {
      raw.push({
        row: i + 1,
        start: readTime(word as string),
        time: word as string,
        name: words.slice(at + 1).join(" "),
      });
      return;
    }
    const last = raw.at(-1);
    if (last && /^\s+\S/.test(line)) last.comment = `${last.comment ?? ""}\n${line.trim()}`;
  });
  if (raw.length === 0) throw new MarkerListError("No line of the list starts with a time");
  return { format: "text", raw };
}

// XML.

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
  parent: XmlNode | null;
}

const entity = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e: string) => {
    const lower = e.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[lower] ?? "";
  });

/** Enough of XML for a marker list: elements, attributes and text. */
function parseXml(text: string): XmlNode {
  const root: XmlNode = { name: "", attrs: {}, children: [], text: "", parent: null };
  let current = root;
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("<", i);
    if (open < 0) break;
    if (open > i) current.text += entity(text.slice(i, open));
    if (text.startsWith("<!--", open)) {
      const close = text.indexOf("-->", open);
      i = close < 0 ? text.length : close + 3;
    } else if (text.startsWith("<![CDATA[", open)) {
      const close = text.indexOf("]]>", open);
      current.text += text.slice(open + 9, close < 0 ? text.length : close);
      i = close < 0 ? text.length : close + 3;
    } else if (text.startsWith("<?", open) || text.startsWith("<!", open)) {
      const close = text.indexOf(">", open);
      i = close < 0 ? text.length : close + 1;
    } else {
      const close = text.indexOf(">", open);
      if (close < 0) break;
      const tag = text.slice(open + 1, close);
      i = close + 1;
      if (tag.startsWith("/")) {
        if (current.parent) current = current.parent;
        continue;
      }
      const selfClosing = tag.endsWith("/");
      const body = selfClosing ? tag.slice(0, -1) : tag;
      const name = /^[^\s/>]+/.exec(body)?.[0] ?? "";
      const attrs: Record<string, string> = {};
      for (const m of body.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
        attrs[m[1] as string] = entity(m[2] ?? m[3] ?? "");
      const node: XmlNode = { name, attrs, children: [], text: "", parent: current };
      current.children.push(node);
      if (!selfClosing) current = node;
    }
  }
  return root;
}

function* walk(node: XmlNode): Generator<XmlNode> {
  for (const child of node.children) {
    yield child;
    yield* walk(child);
  }
}

const child = (node: XmlNode | undefined, name: string) =>
  node?.children.find((c) => c.name === name);
const textOf = (node: XmlNode | undefined) => node?.text.trim() ?? "";

/** A rational time as FCPXML writes it: "1001/30000s", "10s". */
function rational(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^(-?\d+)(?:\/(\d+))?s$/.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) / (m[2] ? Number(m[2]) : 1);
}

/**
 * Final Cut Pro's markers, chapter markers and to-dos, wherever they sit: a marker's start
 * is in its clip's own time, so each clip up the way places it (its offset, less its start)
 * until the project's timeline, whose timecode starts at `tcStart`.
 */
function readFcpxml(root: XmlNode): Read {
  const nodes = [...walk(root)];
  const sequence = nodes.find((n) => n.name === "sequence");
  const scope = sequence ?? root;
  // A marker one frame long marks a moment; longer, a range.
  const format = nodes.find((n) => n.name === "format" && n.attrs.id === sequence?.attrs.format);
  const frame = rational(format?.attrs.frameDuration) ?? 1 / 25;
  const raw: RawMarker[] = [];
  let index = 0;
  for (const node of walk(scope)) {
    if (node.name !== "marker" && node.name !== "chapter-marker") continue;
    index++;
    let t = rational(node.attrs.start);
    const duration = rational(node.attrs.duration);
    for (let up = node.parent; up && up !== scope && t !== null; up = up.parent) {
      const offset = rational(up.attrs.offset);
      if (offset !== null) t = offset + (t - (rational(up.attrs.start) ?? 0));
    }
    const kind =
      node.name === "chapter-marker"
        ? "Chapter"
        : node.attrs.completed === undefined
          ? "Standard"
          : node.attrs.completed === "1"
            ? "Completed"
            : "To do";
    raw.push({
      row: index,
      start: t === null ? { unreadable: node.attrs.start ?? "" } : { seconds: t },
      end: t !== null && duration && duration > frame * 1.5 ? { seconds: t + duration } : null,
      time: node.attrs.start ?? "",
      name: node.attrs.value ?? "",
      comment: node.attrs.note ?? "",
      colour: kind,
    });
  }
  if (raw.length === 0) throw new MarkerListError("The project has no markers");
  return {
    format: "fcpxml",
    raw,
    startsAt: rational(sequence?.attrs.tcStart) ?? 0,
  };
}

/**
 * Final Cut 7's XML, as Premiere Pro writes it: a sequence's markers, in frames from its
 * start at the sequence's rate.
 */
function readXmeml(root: XmlNode): Read {
  const sequence = [...walk(root)].find((n) => n.name === "sequence");
  if (!sequence) throw new MarkerListError("The XML has no sequence");
  const rate = child(sequence, "rate");
  const timebase = Number(textOf(child(rate, "timebase"))) || 25;
  const ntsc = /^true$/i.test(textOf(child(rate, "ntsc")));
  const fps = ntsc ? (timebase * 1000) / 1001 : timebase;
  const raw = sequence.children
    .filter((n) => n.name === "marker")
    .map((marker, i): RawMarker => {
      const from = Number.parseInt(textOf(child(marker, "in")), 10);
      const to = Number.parseInt(textOf(child(marker, "out")), 10);
      return {
        row: i + 1,
        start: Number.isFinite(from) && from >= 0 ? { seconds: from / fps } : { unreadable: "" },
        end: Number.isFinite(to) && to > from ? { seconds: to / fps } : null,
        time: textOf(child(marker, "in")),
        name: textOf(child(marker, "name")),
        comment: textOf(child(marker, "comment")),
        colour: textOf(child(marker, "color")) || null,
      };
    });
  if (raw.length === 0) throw new MarkerListError("The sequence has no markers");
  return { format: "xmeml", raw, startsAt: 0 };
}

// MIDI.

/**
 * A Standard MIDI File's markers (and cue points), placed in seconds through its tempo map,
 * as Pro Tools and most editing systems read and write them.
 */
function readMidi(bytes: Uint8Array): Read {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = () => new MarkerListError("This MIDI file cannot be read");
  if (bytes.length < 14 || view.getUint32(0) !== 0x4d546864) throw fail();
  const tracks = view.getUint16(10);
  const division = view.getUint16(12);
  const smpte = (division & 0x8000) !== 0;
  const tempos: { tick: number; perQuarter: number }[] = [];
  const found: { tick: number; text: Uint8Array; type: number }[] = [];
  let at = 8 + view.getUint32(4);
  for (let t = 0; t < tracks && at + 8 <= bytes.length; t++) {
    if (view.getUint32(at) !== 0x4d54726b) throw fail();
    const end = Math.min(bytes.length, at + 8 + view.getUint32(at + 4));
    let i = at + 8;
    let tick = 0;
    let status = 0;
    const vlq = () => {
      let value = 0;
      for (let k = 0; k < 4 && i < end; k++) {
        const b = bytes[i++] as number;
        value = (value << 7) | (b & 0x7f);
        if (!(b & 0x80)) break;
      }
      return value;
    };
    while (i < end) {
      tick += vlq();
      let b = bytes[i] as number;
      if (b & 0x80) i++;
      else b = status;
      if (b === 0xff) {
        const type = bytes[i++] as number;
        const length = vlq();
        const data = bytes.subarray(i, i + length);
        i += length;
        if (type === 0x51 && length === 3)
          tempos.push({
            tick,
            perQuarter:
              ((data[0] as number) << 16) | ((data[1] as number) << 8) | (data[2] as number),
          });
        else if (type === 0x06 || type === 0x07) found.push({ tick, text: data, type });
        else if (type === 0x2f) break;
      } else if (b === 0xf0 || b === 0xf7) {
        i += vlq();
      } else {
        status = b;
        i += (b & 0xf0) === 0xc0 || (b & 0xf0) === 0xd0 ? 1 : 2;
      }
    }
    at = end;
  }
  const seconds = (tick: number) => {
    if (smpte) {
      // The high byte is minus the frame rate; -29 stands for 29.97.
      const code = 256 - (division >> 8);
      const fps = code === 29 ? 30_000 / 1001 : code;
      return tick / (fps * (division & 0xff));
    }
    let time = 0;
    let last = 0;
    let perQuarter = 500_000;
    for (const tempo of [...tempos].sort((a, b) => a.tick - b.tick)) {
      if (tempo.tick >= tick) break;
      time += ((tempo.tick - last) / division) * (perQuarter / 1e6);
      last = tempo.tick;
      perQuarter = tempo.perQuarter;
    }
    return time + ((tick - last) / division) * (perQuarter / 1e6);
  };
  const markers = found.some((f) => f.type === 0x06) ? found.filter((f) => f.type === 0x06) : found;
  if (markers.length === 0) throw new MarkerListError("The MIDI file has no markers");
  return {
    format: "midi",
    raw: markers
      .sort((a, b) => a.tick - b.tick)
      .map((m, i) => {
        const s = seconds(m.tick);
        return { row: i + 1, start: { seconds: s }, time: s.toFixed(3), name: decodeList(m.text) };
      }),
    startsAt: 0,
  };
}

// Reading.

/**
 * A marker list, whatever it came from: the format is told by its contents, not its name.
 * Times come back in seconds from the start of the file; a list counting in timecode is read
 * at its own rate, or the one given, or one worked out from its frame numbers.
 */
export function readMarkerList(
  bytes: Uint8Array,
  options: { rate?: FrameRateId | null; sampleRate?: number | null } = {},
): MarkerList {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x4d &&
    bytes[1] === 0x54 &&
    bytes[2] === 0x68 &&
    bytes[3] === 0x64
  )
    return finish(readMidi(bytes));
  const text = decodeList(bytes);
  if (text.includes("\u0000"))
    throw new MarkerListError("This is not a marker list Hekate can read");
  const trimmed = text.trimStart();
  if (trimmed.startsWith("<")) {
    const root = parseXml(trimmed);
    const top = root.children.find((n) => n.name !== "");
    if (top?.name === "fcpxml") return finish(readFcpxml(root));
    if (top?.name === "xmeml") return finish(readXmeml(root));
    throw new MarkerListError("This XML is neither Final Cut Pro's nor Premiere Pro's");
  }
  if (/M\s?A\s?R\s?K\s?E\s?R\s?S\s+L\s?I\s?S\s?T\s?I\s?N\s?G/.test(text))
    return finish(readProTools(text), options.rate);
  if (/^\s*#\s*,\s*name\s*,\s*start/i.test(trimmed)) return finish(readReaper(text), options.rate);
  if (/^TITLE:/m.test(text) || /\|M:|\|C:ResolveColor/.test(text))
    return finish(readResolveEdl(text), options.rate);
  const avid = readAvid(text);
  if (avid.raw.length > 0) return finish(avid, options.rate);
  const first = lines(trimmed)[0] ?? "";
  if (/[,;\t]/.test(first) && columnsOf(csvRows(first, delimiterOf(first))[0] ?? []).start >= 0)
    return finish(readCsv(text, options.sampleRate ?? null), options.rate);
  return finish(readText(text), options.rate);
}

/** Why a marker cannot become a comment on a file of this length, or null if it can. */
export function markerProblem(marker: ListedMarker, duration: number | null): string | null {
  if (marker.start === null) return "no time it can read";
  if (marker.start < 0) return "before the start of the file";
  if (
    duration !== null &&
    Math.max(marker.start, marker.end ?? marker.start) > duration + END_TOLERANCE
  )
    return "past the end of the file";
  if (marker.name === "" && marker.comment === "") return "says nothing";
  return null;
}

/** What a marker says, as a comment: its name, and its comment under it where it has one. */
export function markerBody(marker: ListedMarker): string {
  const parts = [marker.name, marker.comment].filter(
    (p, i, all) => p !== "" && (i === 0 || p !== all[0]),
  );
  return parts.join("\n").slice(0, 10_000);
}

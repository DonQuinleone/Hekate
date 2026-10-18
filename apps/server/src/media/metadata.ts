/**
 * What a recording says about itself (#41): Broadcast Wave's bext and iXML chunks, and an ADM
 * master's chna and axml (#74), read from the file itself as ffprobe folds bext into other
 * tags and skips the rest; and the common tags of ID3, Vorbis comments, MP4 and RIFF INFO,
 * from ffprobe.
 */

import { open } from "node:fs/promises";
import {
  type EmbeddedMetadata,
  layoutOf,
  MAX_BEXT,
  MAX_CHUNKS,
  MAX_IXML,
  parseBext,
  parseIxml,
} from "@hekate/shared";

// Read here as in a browser (#45); kept under these names for the tests.
export { parseBext, parseIxml };

type Bext = NonNullable<EmbeddedMetadata["bext"]>;
type Ixml = NonNullable<EmbeddedMetadata["ixml"]>;
type Adm = NonNullable<EmbeddedMetadata["adm"]>;
type Tags = EmbeddedMetadata["tags"];

/** Longest value kept of any one field; metadata is shown, not archived. */
const MAX_VALUE = 500;
/** Most of an axml chunk read; an hour of moving objects can run to megabytes. */
const MAX_AXML = 16 * 1024 * 1024;
/** Most chna entries read: far more tracks than any ADM master carries. */
const MAX_CHNA_ENTRIES = 4096;

const clean = (text: string) => {
  const end = text.indexOf("\0");
  const value = (end >= 0 ? text.slice(0, end) : text).trim().slice(0, MAX_VALUE);
  return value || undefined;
};

const entities: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

/**
 * The first value of an element in iXML, found by searching for its tags rather than with a
 * pattern, so a long or hostile document costs no more than its length.
 */
function element(xml: string, name: string): string | undefined {
  const open = xml.indexOf(`<${name}>`);
  if (open < 0) return undefined;
  const start = open + name.length + 2;
  const close = xml.indexOf(`</${name}>`, start);
  if (close < 0) return undefined;
  const raw = xml.slice(start, Math.min(close, start + MAX_VALUE * 2));
  return clean(raw.replace(/&(amp|lt|gt|quot|apos);/g, (e) => entities[e] ?? e));
}

/** One track of an ADM master, as its chna chunk lists it. */
export interface ChnaTrack {
  /** 1-based, as chna counts. */
  index: number;
  /** The audioTrackFormat it plays, "AT_00010001_01": its type and channel format follow. */
  trackRef: string;
}

/** A chna chunk's tracks (EBU Tech 3285 supplement 7). Exported for tests. */
export function parseChna(body: Buffer): ChnaTrack[] {
  if (body.length < 4) return [];
  const entries = Math.min(body.readUInt16LE(2), MAX_CHNA_ENTRIES);
  const tracks: ChnaTrack[] = [];
  // Each entry: track index (2 bytes), UID (12), track format (14), pack format (11), pad (1).
  for (let i = 0, at = 4; i < entries && at + 40 <= body.length; i += 1, at += 40) {
    const index = body.readUInt16LE(at);
    // An index of 0 marks an unused entry.
    if (index === 0) continue;
    tracks.push({ index, trackRef: body.subarray(at + 14, at + 28).toString("latin1") });
  }
  return tracks;
}

/**
 * The common definitions' speakers (ITU-R BS.2094) that are LFE or above the listener, by
 * the last four digits of their channel format ("AC_00010004" is LFE).
 */
const commonLfe = new Set(["0004", "0020", "0021", "0804"]);
const commonHeight = new Set([
  "000c",
  "000d",
  "000e",
  "000f",
  "0010",
  "0011",
  "0012",
  "0013",
  "0014",
  "001e",
  "001f",
  "0022",
  "0023",
  "0028",
]);

/** An ADM speaker label's role: "RC_LFE" and "urn:itu:bs:2051:0:speaker:LFE1" are LFE. */
export function speakerRole(label: string): "lfe" | "height" | "main" {
  const name = label.slice(label.lastIndexOf(":") + 1).replace(/^RC_/, "");
  if (/^LFE\d?$/i.test(name)) return "lfe";
  // ITU's upper and top layers (U+030, UH+180, T+000), and Dolby's top speakers: front,
  // middle, rear and side (Ltf, Rtm, Ltr, Lts).
  if (/^(U|UH|T)[+-]/.test(name) || /^[LRC]t[fmrs]$/.test(name)) return "height";
  return "main";
}

const attribute = (xml: string, from: number, name: string) => {
  const key = `${name}="`;
  const at = xml.indexOf(key, from);
  if (at < 0) return undefined;
  const start = at + key.length;
  const end = xml.indexOf('"', start);
  return end < 0 ? undefined : xml.slice(start, Math.min(end, start + MAX_VALUE * 2));
};

/** The speaker label the axml gives a channel format, searched for rather than parsed. */
function speakerLabelOf(xml: string, channelFormat: string): string | undefined {
  const at = xml.indexOf(`audioChannelFormatID="${channelFormat}"`);
  if (at < 0) return undefined;
  const end = xml.indexOf("</audioChannelFormat>", at);
  const label = element(end < 0 ? xml.slice(at) : xml.slice(at, end), "speakerLabel");
  return label;
}

/**
 * An ADM master's bed and objects (#74), from its chna tracks and, where present, its axml:
 * a DirectSpeakers track is the bed, an Objects track an object. The bed's speakers come from
 * the common definitions, or from the speaker labels the axml gives custom ones. Exported for
 * tests.
 */
export function parseAdm(
  tracks: readonly ChnaTrack[],
  axml: Buffer | undefined,
  bytes: number,
  dolby: boolean,
): Adm {
  const xml = axml?.toString("utf8") ?? "";
  const counts = { main: 0, lfe: 0, height: 0 };
  const lfe: number[] = [];
  let objects = 0;
  let unknown = false;
  const seen = new Set<number>();
  for (const track of tracks) {
    if (seen.has(track.index)) continue;
    seen.add(track.index);
    // "AT_yyyyxxxx_zz": yyyy is the type, 0001 DirectSpeakers and 0003 Objects.
    const type = track.trackRef.slice(3, 7);
    const id = track.trackRef.slice(7, 11).toLowerCase();
    if (type === "0003") {
      objects += 1;
      continue;
    }
    if (type !== "0001") continue;
    let role: ReturnType<typeof speakerRole> | undefined;
    if (Number.parseInt(id, 16) < 0x1000) {
      role = commonLfe.has(id) ? "lfe" : commonHeight.has(id) ? "height" : "main";
    } else {
      const label = speakerLabelOf(xml, `AC_0001${track.trackRef.slice(7, 11)}`);
      if (label) role = speakerRole(label);
      else unknown = true;
    }
    if (role === "lfe") lfe.push(track.index - 1);
    counts[role ?? "main"] += 1;
  }
  const adm: Adm = {
    bytes,
    bed: counts.main + counts.lfe + counts.height,
    objects,
    lfe: lfe.sort((a, b) => a - b),
    dolby,
  };
  // A bed whose speakers are not all known has no layout to name.
  if (adm.bed > 0 && !unknown) adm.layout = layoutOf(counts);
  const programme = xml.indexOf("<audioProgramme ");
  if (programme >= 0) {
    const name = attribute(xml, programme, "audioProgrammeName");
    const kept =
      name === undefined
        ? undefined
        : clean(name.replace(/&(amp|lt|gt|quot|apos);/g, (e) => entities[e] ?? e));
    if (kept) adm.programme = kept;
  }
  return adm;
}

/**
 * The bext and iXML chunks of a RIFF, RF64 or BW64 wave file, walked chunk by chunk without
 * reading the audio. Anything that is not a wave file, or stops making sense, gives what was
 * found so far.
 */
export async function readWaveChunks(
  path: string,
): Promise<{ bext?: Bext; ixml?: Ixml; adm?: Adm | null }> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const read = async (position: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead);
    };
    const head = await read(0, 12);
    const form = head.subarray(0, 4).toString("latin1");
    if (
      head.length < 12 ||
      !["RIFF", "RF64", "BW64"].includes(form) ||
      head.subarray(8, 12).toString("latin1") !== "WAVE"
    )
      return {};
    const found: { bext?: Bext; ixml?: Ixml; adm?: Adm | null } = {};
    let chna: ChnaTrack[] | undefined;
    let axml: { body: Buffer; bytes: number } | undefined;
    let dolby = false;
    /** RF64 keeps the data chunk's real size in ds64, as it may not fit in 32 bits. */
    let dataSize: number | undefined;
    let position = 12;
    for (let n = 0; n < MAX_CHUNKS && position + 8 <= size; n += 1) {
      const header = await read(position, 8);
      if (header.length < 8) break;
      const id = header.subarray(0, 4).toString("latin1");
      let length = header.readUInt32LE(4);
      if (id === "ds64") {
        const ds64 = await read(position + 8, 16);
        if (ds64.length === 16) dataSize = Number(ds64.readBigUInt64LE(8));
      } else if (id === "data" && length === 0xffffffff && dataSize !== undefined) {
        length = dataSize;
      } else if (id === "bext") {
        found.bext = parseBext(await read(position + 8, Math.min(length, MAX_BEXT)));
      } else if (id === "iXML") {
        found.ixml = parseIxml(await read(position + 8, Math.min(length, MAX_IXML)), length);
      } else if (id === "chna") {
        chna = parseChna(await read(position + 8, Math.min(length, 4 + 40 * MAX_CHNA_ENTRIES)));
      } else if (id === "axml") {
        axml = { body: await read(position + 8, Math.min(length, MAX_AXML)), bytes: length };
      } else if (id === "dbmd") {
        dolby = true;
      }
      // Chunks are padded to an even length.
      position += 8 + length + (length % 2);
    }
    // An ADM master is known by its chna: the axml alone does not say which track is which.
    found.adm = chna?.length ? parseAdm(chna, axml?.body, axml?.bytes ?? 0, dolby) : null;
    return found;
  } finally {
    await handle.close();
  }
}

/** ffprobe's tag names, which differ by container, for each common field. */
const tagNames: Record<keyof Tags, readonly string[]> = {
  title: ["title"],
  artist: ["artist"],
  album: ["album"],
  albumArtist: ["album_artist", "albumartist", "album artist"],
  composer: ["composer", "tcom"],
  genre: ["genre"],
  date: ["date", "year", "tdrc", "tyer"],
  isrc: ["isrc", "tsrc"],
  copyright: ["copyright", "tcop"],
};

/** The common fields from ffprobe's tags, the container's before a stream's. Exported for tests. */
export function tagsOf(...sources: (Record<string, string> | undefined)[]): Tags {
  const tags: Tags = {};
  for (const [field, names] of Object.entries(tagNames) as [keyof Tags, readonly string[]][]) {
    for (const source of sources) {
      if (!source || tags[field] !== undefined) continue;
      for (const [key, value] of Object.entries(source)) {
        if (!names.includes(key.toLowerCase())) continue;
        const kept = clean(String(value));
        if (kept !== undefined) {
          tags[field] = kept;
          break;
        }
      }
    }
  }
  return tags;
}

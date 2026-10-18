/**
 * What a recording says about itself (#41): Broadcast Wave's bext and iXML chunks, read from
 * the file itself as ffprobe folds bext into other tags and skips iXML; and the common tags
 * of ID3, Vorbis comments, MP4 and RIFF INFO, from ffprobe.
 */

import { open } from "node:fs/promises";
import type { EmbeddedMetadata } from "@hekate/shared";

type Bext = NonNullable<EmbeddedMetadata["bext"]>;
type Ixml = NonNullable<EmbeddedMetadata["ixml"]>;
type Tags = EmbeddedMetadata["tags"];

/** Longest value kept of any one field; metadata is shown, not archived. */
const MAX_VALUE = 500;
/** Most of a bext chunk read: its fixed part and a generous coding history. */
const MAX_BEXT = 64 * 1024;
/** Most of an iXML chunk read for its fields; its size is still reported whole. */
const MAX_IXML = 1024 * 1024;
/** Most chunks walked in a file, so a malformed one cannot keep the reader going. */
const MAX_CHUNKS = 1000;

const clean = (text: string) => {
  const end = text.indexOf("\0");
  const value = (end >= 0 ? text.slice(0, end) : text).trim().slice(0, MAX_VALUE);
  return value || undefined;
};

/** A bext chunk's fields (EBU Tech 3285), from its body. Exported for tests. */
export function parseBext(body: Buffer): Bext | undefined {
  // The fixed part runs to the coding history at byte 602; anything shorter is not bext.
  if (body.length < 602) return undefined;
  const text = (from: number, to: number) => clean(body.subarray(from, to).toString("latin1"));
  const bext: Bext = {};
  const set = <K extends keyof Bext>(key: K, value: Bext[K] | undefined) => {
    if (value !== undefined) bext[key] = value;
  };
  set("description", text(0, 256));
  set("originator", text(256, 288));
  set("originatorReference", text(288, 320));
  set("originationDate", text(320, 330));
  set("originationTime", text(330, 338));
  const reference = body.readUInt32LE(342) * 2 ** 32 + body.readUInt32LE(338);
  // Zero is midnight, as good a start as any.
  if (Number.isSafeInteger(reference)) bext.timeReference = reference;
  set("codingHistory", text(602, body.length));
  return bext;
}

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

/** An iXML chunk's fields an editor reads first. Exported for tests. */
export function parseIxml(body: Buffer, bytes: number): Ixml {
  const xml = body.toString("utf8");
  const ixml: Ixml = { bytes };
  const fields = [
    ["project", "PROJECT"],
    ["scene", "SCENE"],
    ["take", "TAKE"],
    ["tape", "TAPE"],
    ["note", "NOTE"],
    ["timecodeRate", "TIMECODE_RATE"],
  ] as const;
  for (const [key, name] of fields) {
    const value = element(xml, name);
    if (value !== undefined) ixml[key] = value;
  }
  return ixml;
}

/**
 * The bext and iXML chunks of a RIFF, RF64 or BW64 wave file, walked chunk by chunk without
 * reading the audio. Anything that is not a wave file, or stops making sense, gives what was
 * found so far.
 */
export async function readWaveChunks(path: string): Promise<{ bext?: Bext; ixml?: Ixml }> {
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
    const found: { bext?: Bext; ixml?: Ixml } = {};
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
      }
      // Chunks are padded to an even length.
      position += 8 + length + (length % 2);
    }
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

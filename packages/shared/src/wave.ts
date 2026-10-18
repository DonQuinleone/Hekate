import type { EmbeddedMetadata } from "./media.ts";

/**
 * Broadcast Wave's own chunks (#41, #45): bext and iXML, read from their bytes; and a wave
 * file's header walked chunk by chunk without reading the audio, through a reader that works
 * on a file on disk (the media worker) as well as on one chosen in a browser (the take import,
 * which reads a session's files before anything is uploaded).
 */

type Bext = NonNullable<EmbeddedMetadata["bext"]>;
type Ixml = NonNullable<EmbeddedMetadata["ixml"]>;

/** Longest value kept of any one field; metadata is shown, not archived. */
const MAX_VALUE = 500;
/** Most of a bext chunk read: its fixed part and a generous coding history. */
export const MAX_BEXT = 64 * 1024;
/** Most of an iXML chunk read for its fields; its size is still reported whole. */
export const MAX_IXML = 1024 * 1024;
/** Most chunks walked in a file, so a malformed one cannot keep the reader going. */
export const MAX_CHUNKS = 1000;
/** Most microphones named in an iXML track list. */
const MAX_TRACKS = 256;

const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder("utf-8");

const clean = (text: string) => {
  const end = text.indexOf("\0");
  const value = (end >= 0 ? text.slice(0, end) : text).trim().slice(0, MAX_VALUE);
  return value || undefined;
};

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.length);

/** Four bytes as the chunk name they spell. */
export const fourcc = (bytes: Uint8Array, at = 0) => latin1.decode(bytes.subarray(at, at + 4));

/** A bext chunk's fields (EBU Tech 3285), from its body. */
export function parseBext(body: Uint8Array): Bext | undefined {
  // The fixed part runs to the coding history at byte 602; anything shorter is not bext.
  if (body.length < 602) return undefined;
  const text = (from: number, to: number) => clean(latin1.decode(body.subarray(from, to)));
  const bext: Bext = {};
  const set = <K extends keyof Bext>(key: K, value: Bext[K] | undefined) => {
    if (value !== undefined) bext[key] = value;
  };
  set("description", text(0, 256));
  set("originator", text(256, 288));
  set("originatorReference", text(288, 320));
  set("originationDate", text(320, 330));
  set("originationTime", text(330, 338));
  const data = view(body);
  const reference = data.getUint32(342, true) * 2 ** 32 + data.getUint32(338, true);
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

export const unescapeXml = (text: string) =>
  text.replace(/&(amp|lt|gt|quot|apos);/g, (e) => entities[e] ?? e);

/**
 * The first value of an element in iXML from `from`, found by searching for its tags rather
 * than with a pattern, so a long or hostile document costs no more than its length.
 */
function element(xml: string, name: string, from = 0, until = xml.length) {
  const open = xml.indexOf(`<${name}>`, from);
  if (open < 0 || open >= until) return undefined;
  const start = open + name.length + 2;
  const close = xml.indexOf(`</${name}>`, start);
  if (close < 0 || close > until) return undefined;
  const raw = xml.slice(start, Math.min(close, start + MAX_VALUE * 2));
  return { value: clean(unescapeXml(raw)), end: close + name.length + 3 };
}

/** An iXML chunk's fields an editor reads first. */
export function parseIxml(body: Uint8Array, bytes: number): Ixml {
  const xml = utf8.decode(body);
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
    const value = element(xml, name)?.value;
    if (value !== undefined) ixml[key] = value;
  }
  return ixml;
}

/** The microphones an iXML track list names, in channel order ("Mix L", "Spot vln"). */
export function ixmlTrackNames(body: Uint8Array): string[] {
  const xml = utf8.decode(body);
  const list = xml.indexOf("<TRACK_LIST>");
  if (list < 0) return [];
  const end = xml.indexOf("</TRACK_LIST>", list);
  const until = end < 0 ? xml.length : end;
  const names: string[] = [];
  let at = list;
  while (names.length < MAX_TRACKS) {
    const track = element(xml, "TRACK", at, until);
    if (!track) break;
    const name = element(xml, "NAME", xml.indexOf("<TRACK>", at), track.end)?.value;
    if (name) names.push(name);
    at = track.end;
  }
  return names;
}

/** What a wave file's header says, as far as it says it. */
export interface WaveHeader {
  channels?: number;
  sampleRate?: number;
  bitsPerSample?: number;
  /** Bytes of audio, from the data chunk (or ds64 for RF64). */
  dataBytes?: number;
  bext?: Bext;
  ixml?: Ixml;
  /** The microphones its iXML track list names. */
  microphones?: string[];
}

/** Reads `length` bytes from `position`; fewer at the end of the file. */
export type ByteReader = (position: number, length: number) => Promise<Uint8Array>;

/**
 * A RIFF, RF64 or BW64 wave file's header: its format, how much audio it holds, and its bext
 * and iXML, walked chunk by chunk without reading the audio. Anything that is not a wave file
 * gives null; one that stops making sense gives what was found so far.
 */
export async function readWaveHeader(read: ByteReader, size: number): Promise<WaveHeader | null> {
  const head = await read(0, 12);
  if (
    head.length < 12 ||
    !["RIFF", "RF64", "BW64"].includes(fourcc(head)) ||
    fourcc(head, 8) !== "WAVE"
  )
    return null;
  const found: WaveHeader = {};
  /** RF64 keeps the data chunk's real size in ds64, as it may not fit in 32 bits. */
  let dataSize: number | undefined;
  let position = 12;
  for (let n = 0; n < MAX_CHUNKS && position + 8 <= size; n += 1) {
    const header = await read(position, 8);
    if (header.length < 8) break;
    const id = fourcc(header);
    let length = view(header).getUint32(4, true);
    if (id === "ds64") {
      const ds64 = await read(position + 8, 16);
      if (ds64.length === 16) dataSize = Number(view(ds64).getBigUint64(8, true));
    } else if (id === "fmt ") {
      const fmt = await read(position + 8, 16);
      if (fmt.length === 16) {
        const data = view(fmt);
        found.channels = data.getUint16(2, true);
        found.sampleRate = data.getUint32(4, true);
        found.bitsPerSample = data.getUint16(14, true);
      }
    } else if (id === "data") {
      if (length === 0xffffffff && dataSize !== undefined) length = dataSize;
      found.dataBytes = Math.min(length, size - position - 8);
    } else if (id === "bext") {
      found.bext = parseBext(await read(position + 8, Math.min(length, MAX_BEXT)));
    } else if (id === "iXML") {
      const body = await read(position + 8, Math.min(length, MAX_IXML));
      found.ixml = parseIxml(body, length);
      const microphones = ixmlTrackNames(body);
      if (microphones.length > 0) found.microphones = microphones;
    }
    // Chunks are padded to an even length.
    position += 8 + length + (length % 2);
  }
  return found;
}

/** How long a wave file's audio runs, in seconds, where its header says enough. */
export function waveSeconds(header: WaveHeader): number | null {
  const { channels, sampleRate, bitsPerSample, dataBytes } = header;
  if (!channels || !sampleRate || !bitsPerSample || dataBytes === undefined) return null;
  return dataBytes / (channels * Math.ceil(bitsPerSample / 8)) / sampleRate;
}

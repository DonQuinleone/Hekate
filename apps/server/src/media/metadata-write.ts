/**
 * Corrected metadata written into a recording as it leaves (decision 260). The stored original
 * is never rewritten: a download is made from a decrypted copy in the private workspace.
 *
 * A wave file (RIFF, RF64, BW64) is written by Hekate itself, chunk by chunk: its bext chunk,
 * its iXML and its RIFF INFO tags are replaced by corrected ones (or added before the audio
 * where it had none), and every other chunk, the audio among them, is copied as it is. FLAC
 * and MP3 have their tags written by ffmpeg, copying the sound without decoding it.
 */

import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import {
  type MetadataCorrections,
  type MetadataField,
  type MetadataFormat,
  metadataFieldSpecs,
} from "@hekate/shared";
import { safeInputArgs } from "./ffmpeg.ts";

/** Most of an iXML or INFO chunk taken in hand to be rewritten. */
const MAX_REWRITTEN = 16 * 1024 * 1024;
/** Most chunks walked, as when the file was read. */
const MAX_CHUNKS = 1000;

const latin1 = (text: string) => Buffer.from(text, "latin1");

/** Where each bext field sits in the chunk's fixed part (EBU Tech 3285), and its width. */
const bextSlots = {
  description: [0, 256],
  originator: [256, 32],
  originatorReference: [288, 32],
  originationDate: [320, 10],
  originationTime: [330, 8],
} as const;

/** The corrections of one group, as field and value. */
function of(corrections: MetadataCorrections, group: "bext" | "ixml" | "tags") {
  return (Object.entries(corrections) as [MetadataField, { value: string }][])
    .filter(([field]) => metadataFieldSpecs[field].group === group)
    .map(([field, c]) => [field, c.value] as const);
}

/**
 * A bext chunk's body with corrections written in: from the file's own (its version, UMID,
 * loudness and coding history kept), or a new one of version 1 where it had none.
 */
export function bextBody(original: Uint8Array | null, corrections: MetadataCorrections): Buffer {
  const body = Buffer.alloc(Math.max(602, original?.length ?? 0));
  if (original) body.set(original);
  else body.writeUInt16LE(1, 346);
  for (const [field, value] of of(corrections, "bext")) {
    if (field === "timeReference") {
      const samples = value === "" ? 0 : Number(value);
      body.writeUInt32LE(samples % 2 ** 32, 338);
      body.writeUInt32LE(Math.floor(samples / 2 ** 32), 342);
      continue;
    }
    if (!(field in bextSlots)) continue;
    const [at, width] = bextSlots[field as keyof typeof bextSlots];
    body.fill(0, at, at + width);
    latin1(value).copy(body, at, 0, width);
  }
  return body;
}

const escapeXml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const ixmlNames: Partial<Record<MetadataField, string>> = {
  project: "PROJECT",
  scene: "SCENE",
  take: "TAKE",
  tape: "TAPE",
  note: "NOTE",
};

/**
 * An iXML document with corrections written in: each element's first value replaced (the one
 * Hekate reads), or the element added at the end of the document; a new document where the
 * file had none. Null where the file's own has no end to add to.
 */
export function ixmlText(original: string | null, corrections: MetadataCorrections): string | null {
  let xml =
    original ??
    '<?xml version="1.0" encoding="UTF-8"?>\n<BWFXML><IXML_VERSION>1.61</IXML_VERSION></BWFXML>';
  for (const [field, value] of of(corrections, "ixml")) {
    const name = ixmlNames[field];
    if (!name) continue;
    const element = `<${name}>${escapeXml(value)}</${name}>`;
    const start = xml.indexOf(`<${name}>`);
    const close = start < 0 ? -1 : xml.indexOf(`</${name}>`, start);
    if (start >= 0 && close >= 0) {
      xml = xml.slice(0, start) + element + xml.slice(close + name.length + 3);
      continue;
    }
    const end = xml.lastIndexOf("</BWFXML>");
    if (end < 0) return null;
    xml = xml.slice(0, end) + element + xml.slice(end);
  }
  return xml;
}

/** RIFF INFO's ids for the tags a wave file can carry; ffmpeg reads them back by these. */
const infoIds: Partial<Record<MetadataField, string>> = {
  title: "INAM",
  artist: "IART",
  album: "IPRD",
  genre: "IGNR",
  date: "ICRD",
  copyright: "ICOP",
  isrc: "ISRC",
};

/**
 * A LIST chunk's body of type INFO with corrections written in: each tag's entry replaced,
 * removed where it was cleared, or added; every other entry kept as it was.
 */
export function infoBody(original: Uint8Array | null, corrections: MetadataCorrections): Buffer {
  const entries: [string, Buffer][] = [];
  if (original && original.length >= 4) {
    const bytes = Buffer.from(original.buffer, original.byteOffset, original.length);
    for (let at = 4; at + 8 <= bytes.length; ) {
      const id = bytes.subarray(at, at + 4).toString("latin1");
      const length = bytes.readUInt32LE(at + 4);
      entries.push([id, bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + length))]);
      at += 8 + length + (length % 2);
    }
  }
  for (const [field, value] of of(corrections, "tags")) {
    const id = infoIds[field];
    if (!id) continue;
    const at = entries.findIndex(([e]) => e === id);
    const text = Buffer.concat([Buffer.from(value, "utf8"), Buffer.alloc(1)]);
    if (value === "") {
      if (at >= 0) entries.splice(at, 1);
    } else if (at >= 0) entries[at] = [id, text];
    else entries.push([id, text]);
  }
  return Buffer.concat([
    latin1("INFO"),
    ...entries.map(([id, body]) => chunkBytes(id, body)),
  ]);
}

/** A chunk as written: its id, its length, its body and a pad byte to an even length. */
function chunkBytes(id: string, body: Uint8Array): Buffer {
  const header = Buffer.alloc(8);
  header.write(id, 0, 4, "latin1");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body, Buffer.alloc(body.length % 2)]);
}

/** A piece of the file sent: bytes made here, or a range of a file on disk. */
type Piece = Buffer | { path: string; start: number; end: number };

/** Whether corrections touch a group a wave file holds in a chunk of its own. */
const touches = (corrections: MetadataCorrections, group: "bext" | "ixml" | "tags") =>
  of(corrections, group).some(([field]) =>
    group === "tags" ? Boolean(infoIds[field]) : group === "ixml" ? Boolean(ixmlNames[field]) : true,
  );

/** One chunk of a wave file, as walked: where it starts, its id and its real length. */
interface Chunk {
  id: string;
  position: number;
  length: number;
  /** A LIST chunk's type ("INFO", "adtl"). */
  list?: string;
}

/**
 * A wave file with corrected metadata, as the pieces to send: the original's chunks in their
 * order, bext, iXML and INFO written again (or added just before the audio where the file has
 * none), and the audio from `samples` where it is given (a marked download's samples, the
 * same size as the original's). Null where the file is not a wave file Hekate can walk.
 */
export async function correctedWave(
  original: string,
  corrections: MetadataCorrections,
  samples?: { path: string; offset: number; size: number },
): Promise<AsyncGenerator<Buffer> | null> {
  const handle = await open(original, "r");
  const pieces: Piece[] = [];
  let form: string;
  /** The ds64 chunk made here, whose RIFF size is written once the size is known. */
  let ds64: Buffer | null = null;
  try {
    const { size: fileSize } = await handle.stat();
    const read = async (position: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead);
    };
    const head = await read(0, 12);
    form = head.subarray(0, 4).toString("latin1");
    if (
      head.length < 12 ||
      !["RIFF", "RF64", "BW64"].includes(form) ||
      head.subarray(8, 12).toString("latin1") !== "WAVE"
    )
      return null;
    // First the chunks as they are, then the file again with the corrected ones.
    const chunks: Chunk[] = [];
    let large: number | undefined;
    for (let n = 0, position = 12; n < MAX_CHUNKS && position + 8 <= fileSize; n += 1) {
      const header = await read(position, 8);
      if (header.length < 8) return null;
      const id = header.subarray(0, 4).toString("latin1");
      let length = header.readUInt32LE(4);
      if (id === "ds64") {
        const body = await read(position + 8, Math.min(length, 64));
        if (body.length >= 16) large = Number(body.readBigUInt64LE(8));
      }
      if (id === "data" && length === 0xffffffff && large !== undefined) length = large;
      const list = id === "LIST" ? (await read(position + 8, 4)).toString("latin1") : undefined;
      chunks.push({ id, position, length, ...(list ? { list } : {}) });
      position += 8 + length + (length % 2);
    }
    const data = chunks.find((c) => c.id === "data");
    if (!data || data.position + 8 + data.length > fileSize) return null;
    if (samples && samples.size !== data.length) return null;
    const isInfo = (c: Chunk) => c.id === "LIST" && c.list === "INFO";
    const has = {
      bext: chunks.some((c) => c.id === "bext"),
      ixml: chunks.some((c) => c.id === "iXML"),
      info: chunks.some(isInfo),
    };
    const wanted = {
      bext: touches(corrections, "bext"),
      ixml: touches(corrections, "ixml"),
      info: touches(corrections, "tags"),
    };
    const done = { bext: false, ixml: false, info: false };
    const asItIs = (c: Chunk) => ({
      path: original,
      start: c.position,
      end: Math.min(fileSize, c.position + 8 + c.length + (c.length % 2)),
    });
    for (const chunk of chunks) {
      const body = () => read(chunk.position + 8, chunk.length);
      if (chunk === data) {
        if (wanted.bext && !has.bext) pieces.push(chunkBytes("bext", bextBody(null, corrections)));
        const xml = wanted.ixml && !has.ixml ? ixmlText(null, corrections) : null;
        if (xml) pieces.push(chunkBytes("iXML", Buffer.from(xml, "utf8")));
        if (wanted.info && !has.info) pieces.push(chunkBytes("LIST", infoBody(null, corrections)));
        if (!samples) {
          pieces.push(asItIs(chunk));
          continue;
        }
        pieces.push(await read(chunk.position, 8));
        pieces.push({
          path: samples.path,
          start: samples.offset,
          end: samples.offset + samples.size,
        });
        if (chunk.length % 2) pieces.push(Buffer.alloc(1));
      } else if (chunk.id === "ds64") {
        ds64 = chunkBytes("ds64", await body());
        pieces.push(ds64);
      } else if (chunk.id === "bext" && wanted.bext && !done.bext) {
        pieces.push(chunkBytes("bext", bextBody(await body(), corrections)));
        done.bext = true;
      } else if (chunk.id === "iXML" && wanted.ixml && !done.ixml) {
        done.ixml = true;
        // One too large to take in hand, or with no end to add to, is left as it was.
        const xml =
          chunk.length <= MAX_REWRITTEN ? ixmlText((await body()).toString("utf8"), corrections) : null;
        pieces.push(xml === null ? asItIs(chunk) : chunkBytes("iXML", Buffer.from(xml, "utf8")));
      } else if (isInfo(chunk) && wanted.info && !done.info && chunk.length <= MAX_REWRITTEN) {
        pieces.push(chunkBytes("LIST", infoBody(await body(), corrections)));
        done.info = true;
      } else pieces.push(asItIs(chunk));
    }
  } finally {
    await handle.close();
  }
  const size = pieces.reduce((n, p) => n + (Buffer.isBuffer(p) ? p.length : p.end - p.start), 12);
  const riff = Buffer.alloc(12);
  riff.write(form, 0, 4, "latin1");
  riff.write("WAVE", 8, 4, "latin1");
  if (form === "RIFF") {
    if (size - 8 > 0xffffffff) throw new Error("The corrected file would be too large for RIFF");
    riff.writeUInt32LE(size - 8, 4);
  } else {
    // RF64 and BW64 keep the file's real size in ds64 (its body's first eight bytes).
    riff.writeUInt32LE(0xffffffff, 4);
    const found = ds64 as Buffer | null;
    if (found && found.length >= 16) found.writeBigUInt64LE(BigInt(size - 8), 8);
  }
  async function* send() {
    yield riff;
    for (const piece of pieces) {
      if (Buffer.isBuffer(piece)) yield piece;
      else if (piece.end > piece.start)
        for await (const chunk of createReadStream(piece.path, {
          start: piece.start,
          end: piece.end - 1,
        }))
          yield chunk as Buffer;
    }
  }
  return send();
}

/** The names ffmpeg writes each tag under, for FLAC's Vorbis comments and MP3's ID3v2. */
const ffmpegKeys: Record<"flac" | "mp3", Partial<Record<MetadataField, string>>> = {
  flac: {
    title: "title",
    artist: "artist",
    album: "album",
    albumArtist: "album_artist",
    composer: "composer",
    genre: "genre",
    date: "date",
    isrc: "ISRC",
    copyright: "copyright",
  },
  mp3: {
    title: "title",
    artist: "artist",
    album: "album",
    albumArtist: "album_artist",
    composer: "composer",
    genre: "genre",
    date: "date",
    isrc: "TSRC",
    copyright: "copyright",
  },
};

/** `-metadata` arguments for corrected tags: an empty value removes the tag. */
export function tagArgs(muxer: "flac" | "mp3", corrections: MetadataCorrections): string[] {
  return of(corrections, "tags").flatMap(([field, value]) => {
    const key = ffmpegKeys[muxer][field];
    return key ? ["-metadata", `${key}=${value}`] : [];
  });
}

/**
 * ffmpeg's arguments for a FLAC or MP3 file with corrected tags: every stream copied as it is
 * (the sound, and any artwork), its own tags kept, and the corrections over them.
 */
export function retagArgs(
  input: string,
  output: string,
  muxer: "flac" | "mp3",
  corrections: MetadataCorrections,
): string[] {
  return [
    ...safeInputArgs("ffmpeg"),
    ...["-v", "error", "-i", `file:${input}`],
    ...["-map", "0", "-c", "copy", "-map_metadata", "0"],
    ...tagArgs(muxer, corrections),
    ...["-f", muxer, "-y", `file:${output}`],
  ];
}

/** Whether a file's corrections change anything a download of this format carries. */
export function carriesCorrections(
  format: MetadataFormat | "aiff" | null,
  corrections: MetadataCorrections | null | undefined,
): boolean {
  if (!corrections || !format || format === "aiff") return false;
  if (format === "wave")
    return touches(corrections, "bext") || touches(corrections, "ixml") || touches(corrections, "tags");
  return tagArgs(format, corrections).length > 0;
}

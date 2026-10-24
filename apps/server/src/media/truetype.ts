/**
 * A TrueType font as the PDF writers need it (decision 238): which glyph draws a character, how
 * wide each glyph is, and a subset holding only the glyphs a PDF uses, so a document embeds a
 * few kilobytes of the font rather than all of it. Only outlines in `glyf` are read (a font with
 * PostScript outlines, OTTO, is refused); a collection (.ttc) gives its first face.
 */

import { deflateSync } from "node:zlib";

interface Table {
  offset: number;
  length: number;
}

export interface TrueType {
  /** The PostScript name, letters, digits and hyphens only. */
  name: string;
  unitsPerEm: number;
  numGlyphs: number;
  /** In font units. */
  ascent: number;
  descent: number;
  capHeight: number;
  bbox: [number, number, number, number];
  /** The glyph drawing a code point, if the font has one. */
  glyphOf(codePoint: number): number | undefined;
  /** A glyph's advance in font units. */
  advance(glyph: number): number;
  /** What a glyph says, for copying text out: its character, or a ligature's characters. */
  textOf(glyph: number): string | undefined;
  /** The font holding only these glyphs (and what they are built from), numbered as before. */
  subset(glyphs: Iterable<number>): Buffer;
}

/** The PostScript name, or the fallback when the font has none worth using. */
function postScriptName(data: Buffer, table: Table | undefined, fallback: string): string {
  if (!table) return fallback;
  const at = table.offset;
  const count = data.readUInt16BE(at + 2);
  const strings = at + data.readUInt16BE(at + 4);
  for (let i = 0; i < count; i++) {
    const record = at + 6 + i * 12;
    const platform = data.readUInt16BE(record);
    const nameId = data.readUInt16BE(record + 6);
    if (nameId !== 6) continue;
    const length = data.readUInt16BE(record + 8);
    const start = strings + data.readUInt16BE(record + 10);
    const bytes = data.subarray(start, start + length);
    const text =
      platform === 3 || platform === 0
        ? Buffer.from(bytes).swap16().toString("utf16le")
        : bytes.toString("latin1");
    const clean = text.replace(/[^A-Za-z0-9-]/g, "");
    if (clean) return clean;
  }
  return fallback;
}

/** Every code point the font maps, from the best Unicode subtable it has. */
function readCmap(data: Buffer, table: Table): Map<number, number> {
  const at = table.offset;
  const count = data.readUInt16BE(at + 2);
  let best: { offset: number; rank: number } | undefined;
  for (let i = 0; i < count; i++) {
    const record = at + 4 + i * 8;
    const platform = data.readUInt16BE(record);
    const encoding = data.readUInt16BE(record + 2);
    const offset = at + data.readUInt32BE(record + 4);
    const format = data.readUInt16BE(offset);
    // Full Unicode first, then the Basic Multilingual Plane; never a symbol or Mac table.
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode || (format !== 4 && format !== 12)) continue;
    const rank = format === 12 ? 2 : 1;
    if (!best || rank > best.rank) best = { offset, rank };
  }
  const map = new Map<number, number>();
  if (!best) return map;
  const o = best.offset;
  if (data.readUInt16BE(o) === 12) {
    const groups = data.readUInt32BE(o + 12);
    for (let g = 0; g < groups; g++) {
      const group = o + 16 + g * 12;
      const start = data.readUInt32BE(group);
      const end = Math.min(data.readUInt32BE(group + 4), 0x10ffff);
      const glyph = data.readUInt32BE(group + 8);
      for (let c = start; c <= end; c++) map.set(c, glyph + c - start);
    }
    return map;
  }
  const segments = data.readUInt16BE(o + 6) / 2;
  const ends = o + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const ranges = deltas + segments * 2;
  for (let s = 0; s < segments; s++) {
    const end = data.readUInt16BE(ends + s * 2);
    const start = data.readUInt16BE(starts + s * 2);
    const delta = data.readInt16BE(deltas + s * 2);
    const range = data.readUInt16BE(ranges + s * 2);
    for (let c = start; c <= end && c !== 0xffff; c++) {
      let glyph: number;
      if (range === 0) glyph = (c + delta) & 0xffff;
      else {
        const at = ranges + s * 2 + range + (c - start) * 2;
        glyph = data.readUInt16BE(at);
        if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
      }
      if (glyph !== 0) map.set(c, glyph);
    }
  }
  return map;
}

/** The presentation forms whose glyph should copy out as the letters they show. */
const presentationForm = (c: number) =>
  (c >= 0xfb00 && c <= 0xfdff) || (c >= 0xfe70 && c <= 0xfeff);

/** The bytes of a font file, read as a TrueType font; `fallbackName` names one without a name. */
export function readTrueType(file: Buffer, fallbackName = "Font"): TrueType {
  const data = file;
  let base = 0;
  const tag = data.toString("latin1", 0, 4);
  if (tag === "ttcf") base = data.readUInt32BE(12);
  const version = data.readUInt32BE(base);
  if (data.toString("latin1", base, base + 4) === "OTTO") {
    throw new Error("The font has PostScript (CFF) outlines; a TrueType font is needed");
  }
  if (version !== 0x00010000 && data.toString("latin1", base, base + 4) !== "true") {
    throw new Error("Not a TrueType font");
  }
  const tables = new Map<string, Table>();
  const count = data.readUInt16BE(base + 4);
  for (let i = 0; i < count; i++) {
    const record = base + 12 + i * 16;
    tables.set(data.toString("latin1", record, record + 4), {
      offset: data.readUInt32BE(record + 8),
      length: data.readUInt32BE(record + 12),
    });
  }
  const need = (name: string): Table => {
    const t = tables.get(name);
    if (!t) throw new Error(`The font has no ${name} table`);
    return t;
  };
  const head = need("head");
  const hhea = need("hhea");
  const maxp = need("maxp");
  const hmtx = need("hmtx");
  const loca = need("loca");
  const glyf = need("glyf");
  const cmap = need("cmap");

  const unitsPerEm = data.readUInt16BE(head.offset + 18);
  const bbox: [number, number, number, number] = [
    data.readInt16BE(head.offset + 36),
    data.readInt16BE(head.offset + 38),
    data.readInt16BE(head.offset + 40),
    data.readInt16BE(head.offset + 42),
  ];
  const longLoca = data.readInt16BE(head.offset + 50) === 1;
  const ascent = data.readInt16BE(hhea.offset + 4);
  const descent = data.readInt16BE(hhea.offset + 6);
  const metrics = data.readUInt16BE(hhea.offset + 34);
  const numGlyphs = data.readUInt16BE(maxp.offset + 4);
  const os2 = tables.get("OS/2");
  const capHeight =
    os2 && data.readUInt16BE(os2.offset) >= 2 && os2.length >= 90
      ? data.readInt16BE(os2.offset + 88)
      : ascent;

  const advances = new Uint16Array(numGlyphs);
  for (let g = 0; g < numGlyphs; g++) {
    advances[g] = data.readUInt16BE(hmtx.offset + Math.min(g, metrics - 1) * 4);
  }
  const lsb = (g: number) =>
    g < metrics
      ? data.readInt16BE(hmtx.offset + g * 4 + 2)
      : data.readInt16BE(hmtx.offset + metrics * 4 + (g - metrics) * 2);
  const offsets = new Uint32Array(numGlyphs + 1);
  for (let g = 0; g <= numGlyphs; g++) {
    offsets[g] = longLoca
      ? data.readUInt32BE(loca.offset + g * 4)
      : data.readUInt16BE(loca.offset + g * 2) * 2;
  }
  const glyphData = (g: number) =>
    data.subarray(glyf.offset + (offsets[g] ?? 0), glyf.offset + (offsets[g + 1] ?? 0));

  const characters = readCmap(data, cmap);
  let texts: Map<number, string> | undefined;
  const textOf = (glyph: number) => {
    if (!texts) {
      texts = new Map();
      // The lowest code point drawing a glyph speaks for it; a presentation form speaks as
      // the letters it shows (an Arabic letter's final form copies out as the letter).
      const ordered = [...characters].sort(([a], [b]) => {
        const pa = presentationForm(a) ? 1 : 0;
        const pb = presentationForm(b) ? 1 : 0;
        return pa - pb || a - b;
      });
      for (const [c, g] of ordered) {
        if (texts.has(g)) continue;
        const ch = String.fromCodePoint(c);
        texts.set(g, presentationForm(c) ? ch.normalize("NFKC") : ch);
      }
    }
    return texts.get(glyph);
  };

  /** The glyphs a composite glyph is built from. */
  const components = (g: number): number[] => {
    const bytes = glyphData(g);
    if (bytes.length < 10 || bytes.readInt16BE(0) >= 0) return [];
    const out: number[] = [];
    let at = 10;
    for (;;) {
      const flags = bytes.readUInt16BE(at);
      out.push(bytes.readUInt16BE(at + 2));
      at += 4 + (flags & 0x1 ? 4 : 2);
      if (flags & 0x8) at += 2;
      else if (flags & 0x40) at += 4;
      else if (flags & 0x80) at += 8;
      if (!(flags & 0x20)) break;
    }
    return out;
  };

  const subset = (wanted: Iterable<number>): Buffer => {
    const keep = new Set<number>();
    const queue = [0, ...[...wanted].filter((g) => g >= 0 && g < numGlyphs)];
    while (queue.length > 0) {
      const g = queue.pop() as number;
      if (keep.has(g)) continue;
      keep.add(g);
      for (const c of components(g)) if (!keep.has(c)) queue.push(c);
    }
    // Glyphs keep their numbers, so the PDF can name them directly (Identity); an empty glyph
    // and a zero advance stand in for each one left out, and compress to almost nothing.
    const pieces: Buffer[] = [];
    const newLoca = Buffer.alloc((numGlyphs + 1) * 4);
    const newHmtx = Buffer.alloc(numGlyphs * 4);
    let at = 0;
    for (let g = 0; g < numGlyphs; g++) {
      newLoca.writeUInt32BE(at, g * 4);
      if (!keep.has(g)) continue;
      newHmtx.writeUInt16BE(advances[g] ?? 0, g * 4);
      newHmtx.writeInt16BE(lsb(g), g * 4 + 2);
      const bytes = glyphData(g);
      const padded = Buffer.alloc((bytes.length + 3) & ~3);
      bytes.copy(padded);
      pieces.push(padded);
      at += padded.length;
    }
    newLoca.writeUInt32BE(at, numGlyphs * 4);
    const copy = (name: string) => {
      const t = tables.get(name);
      return t ? Buffer.from(data.subarray(t.offset, t.offset + t.length)) : undefined;
    };
    const newHead = copy("head") as Buffer;
    newHead.writeUInt32BE(0, 8);
    newHead.writeInt16BE(1, 50);
    const newHhea = copy("hhea") as Buffer;
    newHhea.writeUInt16BE(numGlyphs, 34);
    const out: [string, Buffer | undefined][] = [
      ["cvt ", copy("cvt ")],
      ["fpgm", copy("fpgm")],
      ["glyf", Buffer.concat(pieces)],
      ["head", newHead],
      ["hhea", newHhea],
      ["hmtx", newHmtx],
      ["loca", newLoca],
      ["maxp", copy("maxp")],
      ["prep", copy("prep")],
    ];
    return assemble(out.filter((e): e is [string, Buffer] => e[1] !== undefined));
  };

  return {
    name: postScriptName(data, tables.get("name"), fallbackName.replace(/[^A-Za-z0-9-]/g, "")),
    unitsPerEm,
    numGlyphs,
    ascent,
    descent,
    capHeight,
    bbox,
    glyphOf: (c) => characters.get(c),
    advance: (g) => advances[g] ?? 0,
    textOf,
    subset,
  };
}

/** A table's checksum: its 32-bit words summed. */
function checksum(bytes: Buffer): number {
  let sum = 0;
  const padded =
    bytes.length % 4 ? Buffer.concat([bytes, Buffer.alloc(4 - (bytes.length % 4))]) : bytes;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
}

/** A font file of these tables, given in tag order. */
function assemble(tables: [string, Buffer][]): Buffer {
  const count = tables.length;
  let power = 1;
  let log = 0;
  while (power * 2 <= count) {
    power *= 2;
    log++;
  }
  const header = Buffer.alloc(12 + count * 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(count, 4);
  header.writeUInt16BE(power * 16, 6);
  header.writeUInt16BE(log, 8);
  header.writeUInt16BE(count * 16 - power * 16, 10);
  const bodies: Buffer[] = [];
  let offset = header.length;
  let headAt = -1;
  tables.forEach(([tag, bytes], i) => {
    const record = 12 + i * 16;
    header.write(tag, record, "latin1");
    header.writeUInt32BE(checksum(bytes), record + 4);
    header.writeUInt32BE(offset, record + 8);
    header.writeUInt32BE(bytes.length, record + 12);
    if (tag === "head") headAt = offset;
    const padded = Buffer.alloc((bytes.length + 3) & ~3);
    bytes.copy(padded);
    bodies.push(padded);
    offset += padded.length;
  });
  const font = Buffer.concat([header, ...bodies]);
  if (headAt >= 0) font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headAt + 8);
  return font;
}

/** A subset, compressed as a PDF's FontFile2 stream carries it. */
export function compressed(font: Buffer): Buffer {
  return deflateSync(font, { level: 9 });
}

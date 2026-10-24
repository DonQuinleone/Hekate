import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { hasRightToLeft, shapeArabic, visualOrder } from "./bidi.ts";
import { widthOf as helveticaWidth, inWinAnsi, pdfString } from "./helvetica.ts";
import { compressed, readTrueType, type TrueType } from "./truetype.ts";

/**
 * The one text writer the PDF writers share (decision 238): the score overlay, the patch list,
 * the stage plan, the schedule and the plain-text PDFs. Text Helvetica can print (WinAnsi) is
 * set in Helvetica exactly as it always was, so nothing is embedded and Latin output is
 * unchanged. Anything else (Greek, Cyrillic, Hebrew, Arabic, Japanese, a Czech ř) is set in the
 * configured Unicode fonts, embedded as a Type 0 font with Identity-H, its glyphs subset at write
 * time and mapped back to Unicode so the text copies out. Without those fonts (development,
 * tests), Helvetica prints what it can, as before.
 *
 * Drawing operators carry the glyphs: each Unicode run is written `/U<n> <size> Tf <glyphs> Tj`,
 * so a page's drawing says which fonts and glyphs it uses (`fontsUsed`), and the document writer
 * embeds just those (`fontObjects`).
 */

export type Face = "regular" | "bold" | "oblique";

/** The Helvetica each face is set in, under the resource names the PDF writers give it. */
const LATIN: Record<Face, string> = { regular: "H", bold: "HB", oblique: "HO" };

interface Loaded {
  key: string;
  font: TrueType;
}

/** In order: the regular face, the bold one if any, then the fallbacks. */
let loaded: Loaded[] = [];
let boldKey: string | undefined;

export interface PdfFontPaths {
  regular?: string | undefined;
  bold?: string | undefined;
  fallback?: readonly string[] | undefined;
}

/**
 * Reads the Unicode fonts the PDFs are set in; a font that cannot be read is left out and said
 * in `problems`. Without a regular face, every PDF is set in Helvetica alone.
 */
export function usePdfFonts(paths: PdfFontPaths): { fonts: string[]; problems: string[] } {
  const problems: string[] = [];
  const read = (path: string | undefined): TrueType | undefined => {
    if (!path) return undefined;
    try {
      return readTrueType(readFileSync(path), basename(path).replace(/\.\w+$/, ""));
    } catch (error) {
      const code = (error as { code?: string }).code;
      problems.push(
        `${path}: ${code === "ENOENT" ? "no such file" : error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  };
  const regular = read(paths.regular);
  const bold = regular ? read(paths.bold) : undefined;
  const fallbacks = regular ? (paths.fallback ?? []).map(read) : [];
  const fonts = [regular, bold, ...fallbacks].filter((f): f is TrueType => f !== undefined);
  loaded = fonts.map((font, i) => ({ key: `U${i + 1}`, font }));
  boldKey = bold ? "U2" : undefined;
  layouts.clear();
  return { fonts: fonts.map((f) => f.name), problems };
}

/** Whether a Unicode font is in use. */
export const hasUnicodeFont = () => loaded.length > 0;

const num = (n: number) => String(Math.round(n * 100) / 100);

/**
 * Whether words go in Helvetica: all of them in WinAnsi (a control character, which Helvetica
 * always printed as a question mark, never calls for a font), or no Unicode font to set them in.
 */
export const inHelvetica = (words: string) =>
  loaded.length === 0 || inWinAnsi(words.replace(/\p{Cc}/gu, ""));

interface Run {
  key: string;
  glyphs: number[];
  /** Drawn heavier: bold asked of a font without a bold face. */
  heavier: boolean;
}

interface Layout {
  runs: Run[];
  /** In thousandths of the size. */
  width: number;
  /**
   * The words as they read, where the glyphs drawn do not copy out as them (a character no font
   * has). Never for right-to-left text: readers put glyphs drawn in visual order back in reading
   * order themselves, and Poppler would reverse an ActualText a second time.
   */
  actual: string | null;
}

const layouts = new Map<string, Layout>();

const drawable = (c: number) => loaded.some((l) => l.font.glyphOf(c) !== undefined);

/** Words as runs of glyphs in the fonts that hold them, in the order they are drawn. */
function layout(words: string, face: Face): Layout {
  const cacheKey = `${face}\u0000${words}`;
  const cached = layouts.get(cacheKey);
  if (cached) return cached;
  const logical = words.replace(/\p{Cc}/gu, "").normalize("NFC");
  const shown = visualOrder(shapeArabic(logical, drawable)).replace(/\p{Cf}/gu, "");
  const order = loaded.filter((l) => face === "bold" || l.key !== boldKey);
  if (face === "bold" && boldKey) {
    const b = order.findIndex((l) => l.key === boldKey);
    order.unshift(...order.splice(b, 1));
  }
  const runs: Run[] = [];
  let width = 0;
  let copied = "";
  let previous: Loaded | undefined;
  for (const ch of shown) {
    const c = ch.codePointAt(0) ?? 0;
    // A combining mark stays in its letter's font where that font has it.
    const mark = /\p{M}/u.test(ch) && previous?.font.glyphOf(c) !== undefined;
    const holder = mark ? previous : order.find((l) => l.font.glyphOf(c) !== undefined);
    const use = holder ?? (order[0] as Loaded);
    const glyph = holder ? (use.font.glyphOf(c) as number) : 0;
    const heavier = face === "bold" && use.key !== boldKey;
    const last = runs.at(-1);
    if (last && last.key === use.key && last.heavier === heavier) last.glyphs.push(glyph);
    else runs.push({ key: use.key, glyphs: [glyph], heavier });
    width += (use.font.advance(glyph) * 1000) / use.font.unitsPerEm;
    copied += use.font.textOf(glyph) ?? "�";
    previous = use;
  }
  const result: Layout = {
    runs,
    width,
    actual: copied === logical || hasRightToLeft(logical) ? null : logical,
  };
  if (layouts.size > 5000) layouts.clear();
  layouts.set(cacheKey, result);
  return result;
}

/** How wide words are as they will print, at a size in points. */
export function widthOf(words: string, size: number, bold = false): number {
  if (inHelvetica(words)) return helveticaWidth(words, size, bold);
  return unicodeWidthOf(words, size, bold);
}

/** How wide words are set in the Unicode fonts (in Helvetica where there are none). */
function unicodeWidthOf(words: string, size: number, bold: boolean): number {
  if (loaded.length === 0) return helveticaWidth(words, size, bold);
  return (layout(words, bold ? "bold" : "regular").width / 1000) * size;
}

const hex = (glyphs: number[]) =>
  glyphs.map((g) => g.toString(16).toUpperCase().padStart(4, "0")).join("");

/** Text as a PDF text string in UTF-16, for ActualText and document information. */
export function unicodeString(words: string): string {
  const units = Buffer.from(words, "utf16le").swap16().toString("hex").toUpperCase();
  return `<FEFF${units}>`;
}

/**
 * The operators drawing words at (x, y), left aligned, in a face and size, coloured by a fill
 * operator (`0.4 g`, `1 0 0 rg`). Helvetica's form is the one the writers always wrote, under
 * the resource name `latin`; with `latin` null, the words go in the Unicode font whenever there
 * is one (the lines of a paragraph that needed it stay in one typeface).
 */
export function showText(
  face: Face,
  size: number,
  x: number,
  y: number,
  words: string,
  fill: string,
  latin: string | null = LATIN[face],
): string {
  if (latin !== null && inHelvetica(words)) {
    return `BT /${latin} ${num(size)} Tf ${fill} ${num(x)} ${num(y)} Td ${pdfString(words)} Tj ET`;
  }
  const { runs, actual } = layout(words, face === "bold" ? "bold" : "regular");
  // Oblique has no face of its own: the text is slanted, as Helvetica Oblique is (12 degrees).
  const at = face === "oblique" ? `1 0 0.21 1 ${num(x)} ${num(y)} Tm` : `${num(x)} ${num(y)} Td`;
  const parts = [`BT ${fill} ${at}`];
  let heavier = false;
  const stroke = fill.replace(/ rg$/, " RG").replace(/ g$/, " G");
  for (const run of runs) {
    if (run.heavier !== heavier) {
      // A bold for a font without one: the letters outlined in their own colour as well.
      parts.push(run.heavier ? `2 Tr ${num(size * 0.035)} w ${stroke}` : "0 Tr");
      heavier = run.heavier;
    }
    parts.push(`/${run.key} ${num(size)} Tf <${hex(run.glyphs)}> Tj`);
  }
  parts.push("ET");
  let ops = parts.join(" ");
  if (runs.some((r) => r.heavier)) ops = `q ${ops} Q`;
  // Missing glyphs copy out as the words they stand for.
  if (actual !== null) ops = `/Span << /ActualText ${unicodeString(actual)} >> BDC ${ops} EMC`;
  return ops;
}

/**
 * Words broken into lines no wider than `width` points as the Unicode fonts set them (showText
 * with `latin` null): at spaces where it can, between Chinese, Japanese and Korean characters,
 * and inside a word too long for a line.
 */
export function wrapToWidth(text: string, width: number, size: number, bold = false): string[] {
  const out: string[] = [];
  const pieces =
    /\s+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]+/gu;
  for (const paragraph of text.split("\n")) {
    let line = "";
    let used = 0;
    const flush = () => {
      out.push(line.trimEnd());
      line = "";
      used = 0;
    };
    for (const piece of paragraph.match(pieces) ?? []) {
      const w = unicodeWidthOf(piece, size, bold);
      if (used + w <= width || (/^\s+$/.test(piece) && line)) {
        line += piece;
        used += w;
        continue;
      }
      if (line.trim()) flush();
      if (/^\s+$/.test(piece)) continue;
      if (w <= width) {
        line = piece;
        used = w;
        continue;
      }
      // Too long for any line: cut it where it reaches the edge.
      for (const ch of piece) {
        const cw = unicodeWidthOf(ch, size, bold);
        if (used + cw > width && line) flush();
        line += ch;
        used += cw;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** Objects each embedded font takes: the font, its glyphs' font, descriptor, file and map. */
export const FONT_OBJECTS = 5;

/** The Unicode fonts drawings use, with the glyphs used of each, added to `into`. */
export function fontsUsed(
  contents: Iterable<string>,
  into: Map<string, Set<number>> = new Map(),
): Map<string, Set<number>> {
  for (const content of contents) {
    for (const [, key, glyphs] of content.matchAll(/\/(U\d+) [0-9.]+ Tf <([0-9A-F]*)>/g)) {
      if (!key || !loaded.some((l) => l.key === key)) continue;
      const set = into.get(key) ?? new Set<number>();
      into.set(key, set);
      for (let i = 0; i + 4 <= (glyphs ?? "").length; i += 4) {
        set.add(Number.parseInt((glyphs as string).slice(i, i + 4), 16));
      }
    }
  }
  return into;
}

/** A font's entries in a page's /Font dictionary, given each font's first object. */
export const fontEntries = (at: Map<string, number>) =>
  [...at].map(([key, n]) => ` /${key} ${n} 0 R`).join("");

/** UTF-16 code units in hex, as a ToUnicode map gives a glyph's text. */
const utf16 = (text: string) => Buffer.from(text, "utf16le").swap16().toString("hex").toUpperCase();

/**
 * The PDF objects embedding a font's glyphs, numbered from `first` (the Type 0 font, which a
 * page names): bodies as latin1 strings, the font file deflated.
 */
export function fontObjects(key: string, glyphs: Set<number>, first: number): string[] {
  const entry = loaded.find((l) => l.key === key);
  if (!entry) throw new Error(`No font ${key}`);
  const { font } = entry;
  const used = [...new Set([0, ...glyphs])].sort((a, b) => a - b);
  const scale = (v: number) => Math.round((v * 1000) / font.unitsPerEm);
  // A subset's name begins with six capitals of its own (ISO 32000, 9.6.4).
  let hash = 0;
  for (const g of used) hash = (hash * 31 + g) >>> 0;
  let tag = "";
  for (let i = 0; i < 6; i++) {
    tag += String.fromCharCode(65 + (hash % 26));
    hash = Math.floor(hash / 26) + i * 7;
  }
  const name = `${tag}+${font.name}`;
  const widths: string[] = [];
  for (let i = 0; i < used.length; ) {
    let j = i;
    while (j + 1 < used.length && (used[j + 1] as number) === (used[j] as number) + 1) j++;
    const ws = used.slice(i, j + 1).map((g) => scale(font.advance(g)));
    widths.push(`${used[i]} [${ws.join(" ")}]`);
    i = j + 1;
  }
  const mapped = used
    .map((g) => [g, font.textOf(g)] as const)
    .filter((e): e is readonly [number, string] => e[1] !== undefined);
  const blocks: string[] = [];
  for (let i = 0; i < mapped.length; i += 100) {
    const block = mapped.slice(i, i + 100);
    blocks.push(
      `${block.length} beginbfchar\n${block
        .map(([g, t]) => `<${g.toString(16).toUpperCase().padStart(4, "0")}> <${utf16(t)}>`)
        .join("\n")}\nendbfchar`,
    );
  }
  const cmap = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    ...blocks,
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  ].join("\n");
  const file = font.subset(used);
  const packed = compressed(file);
  const [x0, y0, x1, y1] = font.bbox.map(scale);
  return [
    `<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H` +
      ` /DescendantFonts [${first + 1} 0 R] /ToUnicode ${first + 4} 0 R >>`,
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name}` +
      " /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>" +
      ` /FontDescriptor ${first + 2} 0 R /CIDToGIDMap /Identity /W [${widths.join(" ")}] >>`,
    `<< /Type /FontDescriptor /FontName /${name} /Flags 4 /FontBBox [${x0} ${y0} ${x1} ${y1}]` +
      ` /ItalicAngle 0 /Ascent ${scale(font.ascent)} /Descent ${scale(font.descent)}` +
      ` /CapHeight ${scale(font.capHeight)} /StemV 80 /FontFile2 ${first + 3} 0 R >>`,
    `<< /Length ${packed.length} /Length1 ${file.length} /Filter /FlateDecode >>\nstream\n` +
      `${packed.toString("latin1")}\nendstream`,
    `<< /Length ${Buffer.byteLength(cmap, "latin1")} >>\nstream\n${cmap}\nendstream`,
  ];
}

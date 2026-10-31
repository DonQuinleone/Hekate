import { FONT_OBJECTS, fontEntries, fontObjects, fontsUsed } from "./pdf-text.ts";

/**
 * A PDF made of pictures, one a page, written as the pages come so that a long document is
 * never held at once (#136): how a marked document leaves as a download. Each page is a JPEG
 * drawn to fill it, with the score marks drawn over it where asked (#52); nothing else is in
 * the file (no text layer, no scripts, no metadata).
 */

export interface PdfPage {
  /** A baseline JPEG, three components (YCbCr or RGB). */
  jpeg: Buffer;
  /** The picture's size in pixels. */
  width: number;
  height: number;
  /** The page's size in points; a picture fills it. */
  points: { width: number; height: number };
  /**
   * Drawn over the picture: PDF drawing operators in the page's points, in ASCII, that may
   * set text in /H (Helvetica) or /HO (Helvetica Oblique), or in the embedded Unicode fonts
   * (pdf-text.ts). See score-overlay.ts.
   */
  overlay?: string;
}

/**
 * The standard fonts an overlay may use: every PDF reader has them, so none is embedded. The
 * Unicode fonts text outside WinAnsi needs (decision 238) follow, embedded, where a page uses them.
 */
const font = (key: string, name: string) =>
  `/${key} << /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`;
const fonts = (embedded = "") =>
  `/Font << ${font("H", "Helvetica")} ${font("HO", "Helvetica-Oblique")}${embedded} >>`;
/** And for a page of text: Helvetica, oblique and bold. */
const textFonts = (embedded = "") =>
  `<< ${font("H", "Helvetica")} ${font("HO", "Helvetica-Oblique")} ${font("HB", "Helvetica-Bold")}${embedded} >>`;

const CATALOG = 1;
const PAGES = 2;

/** A number as PDF writes it: at most two decimals, no exponent. */
const num = (n: number) => String(Math.round(n * 100) / 100);

/**
 * The PDF's bytes, chunk by chunk, for pictures given in order; the first chunk holds the
 * first page. Refuses a PDF of none.
 */
export async function* pdfOf(pages: AsyncIterable<PdfPage>): AsyncGenerator<Buffer> {
  const offsets: number[] = [];
  let written = 0;
  const emit = (...parts: (string | Buffer)[]) => {
    const chunk = Buffer.concat(
      parts.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : p)),
    );
    written += chunk.length;
    return chunk;
  };
  const object = (n: number, ...body: (string | Buffer)[]) => {
    offsets[n] = written;
    return emit(`${n} 0 obj\n`, ...body, "\nendobj\n");
  };
  // A binary comment says to anything that reads it that the file is not text. It leaves
  // with the first page, so nothing leaves until a page has been made.
  const header = emit("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");
  let count = 0;
  // Each page takes three objects (the picture, what draws it, the page itself); an embedded
  // font takes its objects from the first page to use it, and is written at the end, with
  // every glyph the pages used.
  let next = 3;
  const kidsOf: number[] = [];
  const glyphs = new Map<string, Set<number>>();
  const fontAt = new Map<string, number>();
  for await (const page of pages) {
    const image = next;
    next += 3;
    kidsOf.push(image + 2);
    const used = page.overlay ? fontsUsed([page.overlay]) : new Map<string, Set<number>>();
    const onPage = new Map<string, number>();
    for (const [key, set] of used) {
      let at = fontAt.get(key);
      if (at === undefined) {
        at = next;
        next += FONT_OBJECTS;
        fontAt.set(key, at);
        glyphs.set(key, new Set());
      }
      for (const g of set) glyphs.get(key)?.add(g);
      onPage.set(key, at);
    }
    const { width, height } = page.points;
    const draw =
      `q ${num(width)} 0 0 ${num(height)} 0 0 cm /P Do Q` +
      (page.overlay ? `\n${page.overlay}` : "");
    const picture = object(
      image,
      `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height}` +
        ` /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
      page.jpeg,
      "\nendstream",
    );
    yield count === 0 ? Buffer.concat([header, picture]) : picture;
    yield object(image + 1, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
    yield object(
      image + 2,
      `<< /Type /Page /Parent ${PAGES} 0 R /MediaBox [0 0 ${num(width)} ${num(height)}]` +
        ` /Resources << /XObject << /P ${image} 0 R >>${page.overlay ? ` ${fonts(fontEntries(onPage))}` : ""} >>` +
        ` /Contents ${image + 1} 0 R >>`,
    );
    count++;
  }
  if (count === 0) throw new Error("A PDF needs at least one page");
  for (const [key, at] of fontAt) {
    const bodies = fontObjects(key, glyphs.get(key) ?? new Set(), at);
    for (const [i, body] of bodies.entries()) yield object(at + i, body);
  }
  const kids = kidsOf.map((n) => `${n} 0 R`).join(" ");
  yield object(PAGES, `<< /Type /Pages /Kids [${kids}] /Count ${count} >>`);
  yield object(CATALOG, `<< /Type /Catalog /Pages ${PAGES} 0 R >>`);
  const size = next;
  const xref = written;
  // Each entry is exactly twenty bytes, as the format requires.
  const entries = ["0000000000 65535 f \n"];
  for (let n = 1; n < size; n++) entries.push(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
  yield emit(
    `xref\n0 ${size}\n`,
    entries.join(""),
    `trailer\n<< /Size ${size} /Root ${CATALOG} 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );
}

/**
 * A page's size in points for a picture drawn without one: its longest side as long as an
 * A4 page's (842 points), keeping its shape.
 */
export function pointsOf(width: number, height: number): { width: number; height: number } {
  const scale = 842 / Math.max(width, height);
  return { width: width * scale, height: height * scale };
}

/** The width and height a JPEG declares in its frame header. */
export function jpegSize(jpeg: Buffer): { width: number; height: number } {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("Not a JPEG");
  let at = 2;
  while (at + 9 <= jpeg.length) {
    if (jpeg[at] !== 0xff) throw new Error("Not a JPEG");
    const marker = jpeg[at + 1] ?? 0;
    // Start of frame: baseline, extended or progressive, never the arithmetic or lossless kinds.
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return { height: jpeg.readUInt16BE(at + 5), width: jpeg.readUInt16BE(at + 7) };
    }
    at += 2 + jpeg.readUInt16BE(at + 2);
  }
  throw new Error("The JPEG has no frame header");
}

/**
 * A picture a page of text can draw (a workspace's logo on a report, #515): eight-bit RGB
 * samples, deflated, with an alpha channel likewise where it has one. A page draws it as
 * `/<name> Do` within a transformation that sizes it.
 */
export interface PdfImage {
  width: number;
  height: number;
  /** Deflated: `width × height × 3` bytes, row by row. */
  rgb: Buffer;
  /** Deflated: `width × height` bytes of opacity, or null where it is opaque. */
  alpha: Buffer | null;
}

export interface TextPdfOptions {
  /** Pictures every page may draw, by the name it draws them with. */
  images?: Record<string, PdfImage>;
  /** Fill opacities every page may set, `/<name> gs`, by name: 0 to 1. */
  opacities?: Record<string, number>;
}

/**
 * A PDF of text, a page for each drawing given (PDF operators in points, ASCII only, setting text
 * in /H, /HO or /HB, or the embedded Unicode fonts): how a list such as the patch list leaves as
 * a PDF (#54). It may also draw pictures and set opacities given in `options`.
 */
export function textPdfOf(
  pages: { points: { width: number; height: number }; content: string }[],
  options: TextPdfOptions = {},
): Buffer {
  if (pages.length === 0) throw new Error("A PDF needs at least one page");
  const objects: string[] = [];
  const add = (body: string) => objects.push(body);
  add(`<< /Type /Catalog /Pages 2 0 R >>`);
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  add(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  // The embedded fonts follow the pages, then the pictures.
  const used = fontsUsed(pages.map((p) => p.content));
  const fontAt = new Map<string, number>();
  let next = 4 + pages.length * 2;
  for (const key of used.keys()) {
    fontAt.set(key, next);
    next += FONT_OBJECTS;
  }
  const images = Object.entries(options.images ?? {});
  const imageAt = new Map<string, number>();
  for (const [name, image] of images) {
    imageAt.set(name, next);
    next += image.alpha ? 2 : 1;
  }
  add(textFonts(fontEntries(fontAt)));
  const xobjects =
    images.length > 0
      ? ` /XObject << ${images.map(([name]) => `/${name} ${imageAt.get(name)} 0 R`).join(" ")} >>`
      : "";
  const opacities = Object.entries(options.opacities ?? {});
  const states =
    opacities.length > 0
      ? ` /ExtGState << ${opacities.map(([name, a]) => `/${name} << /Type /ExtGState /ca ${num(a)} /CA ${num(a)} >>`).join(" ")} >>`
      : "";
  for (const page of pages) {
    const { width, height } = page.points;
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(width)} ${num(height)}]` +
        ` /Resources << /Font 3 0 R${xobjects}${states} >> /Contents ${objects.length + 2} 0 R >>`,
    );
    add(`<< /Length ${page.content.length} >>\nstream\n${page.content}\nendstream`);
  }
  for (const [key, at] of fontAt) {
    for (const body of fontObjects(key, used.get(key) ?? new Set(), at)) add(body);
  }
  for (const [name, image] of images) {
    const at = imageAt.get(name) as number;
    const stream = (dictionary: string, bytes: Buffer) =>
      `<< ${dictionary} /BitsPerComponent 8 /Filter /FlateDecode /Length ${bytes.length} >>\nstream\n${bytes.toString("latin1")}\nendstream`;
    const size = `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height}`;
    add(
      stream(
        `${size} /ColorSpace /DeviceRGB${image.alpha ? ` /SMask ${at + 1} 0 R` : ""}`,
        image.rgb,
      ),
    );
    if (image.alpha) add(stream(`${size} /ColorSpace /DeviceGray`, image.alpha));
  }
  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

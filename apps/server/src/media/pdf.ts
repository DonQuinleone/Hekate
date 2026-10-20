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
   * set text in /H (Helvetica) or /HO (Helvetica Oblique). See score-overlay.ts.
   */
  overlay?: string;
}

/** The standard fonts an overlay may use: every PDF reader has them, so none is embedded. */
const FONTS =
  "/Font << /H << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>" +
  " /HO << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >> >>";

const CATALOG = 1;
const PAGES = 2;
/** Each page takes three objects: the picture, what draws it, and the page itself. */
const firstObjectOf = (index: number) => 3 + index * 3;

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
  for await (const page of pages) {
    const image = firstObjectOf(count);
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
        ` /Resources << /XObject << /P ${image} 0 R >>${page.overlay ? ` ${FONTS}` : ""} >>` +
        ` /Contents ${image + 1} 0 R >>`,
    );
    count++;
  }
  if (count === 0) throw new Error("A PDF needs at least one page");
  const kids = Array.from({ length: count }, (_, i) => `${firstObjectOf(i) + 2} 0 R`).join(" ");
  yield object(PAGES, `<< /Type /Pages /Kids [${kids}] /Count ${count} >>`);
  yield object(CATALOG, `<< /Type /Catalog /Pages ${PAGES} 0 R >>`);
  const size = firstObjectOf(count);
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

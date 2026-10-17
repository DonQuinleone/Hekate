/**
 * A PDF of plain text, written by Hekate itself (#43): A4 pages in Helvetica, the font every
 * PDF reader has, so nothing is embedded. Lines wrap at the page's width and run on to new
 * pages. Only what Latin-1 can say is kept; the few typographic marks outside it are written
 * plainly (a minus sign as a hyphen), and anything else as a question mark.
 */

export interface TextLine {
  text: string;
  /** Points; 10 unless said. */
  size?: number;
  bold?: boolean;
  /** Extra space above the line, in points. */
  space?: number;
  /** Quieter: grey rather than black. */
  quiet?: boolean;
}

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 56;
const LEADING = 1.35;
/** Helvetica's average character width, as a share of its size: enough to wrap by. */
const AVERAGE_WIDTH = 0.5;

const plain: Record<string, string> = {
  "−": "-",
  "–": "-",
  "—": "-",
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "…": "...",
  "→": "->",
};

/** The text as Latin-1 can say it. */
export function latin1(text: string): string {
  return [...text]
    .map((ch) => {
      const code = ch.charCodeAt(0);
      // Control characters say nothing on a page; a line break stays, to wrap on.
      if ((code < 32 && ch !== "\n") || (code >= 0x7f && code < 0xa0)) return "";
      return plain[ch] ?? (code <= 0xff ? ch : "?");
    })
    .join("");
}

/** A string as PDF writes it, between parentheses. */
const pdfString = (text: string) => `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`;

/** A line broken into the lines that fit across the page, on spaces where it can. */
export function wrap(text: string, size: number): string[] {
  const fits = Math.max(10, Math.floor((PAGE.width - 2 * MARGIN) / (size * AVERAGE_WIDTH)));
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let rest = paragraph;
    while (rest.length > fits) {
      const cut = rest.lastIndexOf(" ", fits);
      const at = cut > fits / 3 ? cut : fits;
      out.push(rest.slice(0, at).trimEnd());
      rest = rest.slice(at).trimStart();
    }
    out.push(rest);
  }
  return out;
}

/** The PDF's bytes for these lines, on as many pages as they need. */
export function textPdf(lines: readonly TextLine[], title: string): Buffer {
  // Lay the lines out on pages: each a list of drawing commands.
  const pages: string[][] = [[]];
  let y = PAGE.height - MARGIN;
  for (const line of lines) {
    const size = line.size ?? 10;
    const step = size * LEADING;
    y -= line.space ?? 0;
    for (const part of wrap(latin1(line.text), size)) {
      if (y - step < MARGIN) {
        pages.push([]);
        y = PAGE.height - MARGIN;
      }
      y -= step;
      const colour = line.quiet ? "0.4 0.4 0.4 rg" : "0 0 0 rg";
      (pages.at(-1) as string[]).push(
        `BT ${colour} /${line.bold ? "F2" : "F1"} ${size} Tf ${MARGIN} ${y.toFixed(2)} Td ${pdfString(part)} Tj ET`,
      );
    }
  }
  // Objects: 1 catalogue, 2 pages, 3 and 4 the fonts, 5 the information, then two a page.
  const objects: string[] = [];
  const first = 6;
  const kids = pages.map((_, i) => `${first + i * 2} 0 R`).join(" ");
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  objects[5] = `<< /Title ${pdfString(latin1(title))} /Producer (Hekate) >>`;
  pages.forEach((commands, i) => {
    const content = commands.join("\n");
    objects[first + i * 2] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${first + i * 2 + 1} 0 R >>`;
    objects[first + i * 2 + 1] =
      `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`;
  });
  let body = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = Buffer.byteLength(body, "latin1");
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n++)
    body += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

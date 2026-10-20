/** For tests: documents to draw, made here rather than kept as files. */

/**
 * A small, valid PDF of A4 pages, each with one line of text, written by hand. With `bars`,
 * each page has four systems numbered as a score numbers them: the first system of the piece
 * unnumbered, then 5, 9, 13 and on, four bars a system, at the left of each.
 */
export function samplePdf(pages: number, { bars = false }: { bars?: boolean } = {}): Buffer {
  const objects: string[] = [];
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  const font = 3 + pages * 2;
  for (let i = 0; i < pages; i++) {
    const numbers = bars
      ? [650, 500, 350, 200]
          .map((y, system) => ({ y, bar: 1 + (i * 4 + system) * 4 }))
          .filter((n) => n.bar > 1)
          .map((n) => ` BT /F1 10 Tf 40 ${n.y} Td (${n.bar}) Tj ET`)
          .join("")
      : "";
    const text = `BT /F1 48 Tf 72 700 Td (Page ${i + 1}) Tj ET${numbers}`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
    );
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

import { crc32, deflateRawSync } from "node:zlib";

/**
 * Spreadsheets for download (#54): a workbook of plain sheets, written here rather than by a
 * library, as a zip of a few XML parts. Text is written inline, numbers as numbers; the first
 * row of each sheet is its header, in bold and frozen.
 */

export interface Sheet {
  name: string;
  rows: (string | number)[][];
}

/** A zip of the files given, each deflated. */
export function zipOf(files: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const packed = deflateRawSync(file.data);
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // names in UTF-8
    local.writeUInt16LE(8, 8); // deflated
    local.writeUInt32LE(0, 10); // time and date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // made by
    entry.writeUInt16LE(20, 6); // needed
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(0, 12);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(file.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

/** Text as XML takes it: escaped, without the control characters XML 1.0 refuses. */
const xml = (text: string) =>
  text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: these are what XML refuses.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** A column's letters: 0 is A, 25 is Z, 26 is AA. */
export function columnOf(index: number): string {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rest = (n - 1) % 26;
    letters = String.fromCharCode(65 + rest) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/**
 * Sheet names as a workbook allows them: at most 31 characters, none of `[]:*?/\`, no
 * apostrophe at either end, not blank, and no two the same (ignoring case).
 */
export function sheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((name, i) => {
    const base =
      name
        .replace(/[[\]:*?/\\]/g, " ")
        .slice(0, 31)
        .replace(/^[\s']+|[\s']+$/g, "") || `Sheet ${i + 1}`;
    let candidate = base;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) {
      const suffix = ` (${n})`;
      candidate = base.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

function sheetXml(rows: Sheet["rows"]): string {
  const width = Math.max(1, ...rows.map((r) => r.length));
  const body = rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          const ref = `${columnOf(c)}${r + 1}`;
          const style = r === 0 ? ' s="1"' : "";
          return typeof value === "number"
            ? `<c r="${ref}"${style}><v>${value}</v></c>`
            : `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols><col min="1" max="1" width="8" customWidth="1"/><col min="2" max="${width}" width="22" customWidth="1"/></cols>` +
    `<sheetData>${body}</sheetData></worksheet>`
  );
}

/** A workbook of the sheets given, as the bytes of an .xlsx file. */
export function xlsxOf(sheets: Sheet[]): Buffer {
  const names = sheetNames(sheets.map((s) => s.name));
  const text = (name: string, content: string) => ({ name, data: Buffer.from(content, "utf8") });
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  return zipOf([
    text(
      "[Content_Types].xml",
      `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join("") +
        "</Types>",
    ),
    text(
      "_rels/.rels",
      `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        "</Relationships>",
    ),
    text(
      "xl/workbook.xml",
      `${head}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
        names
          .map((name, i) => `<sheet name="${xml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
          .join("") +
        "</sheets></workbook>",
    ),
    text(
      "xl/_rels/workbook.xml.rels",
      `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        sheets
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join("") +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        "</Relationships>",
    ),
    text(
      "xl/styles.xml",
      `${head}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        "</styleSheet>",
    ),
    ...sheets.map((s, i) => text(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows))),
  ]);
}

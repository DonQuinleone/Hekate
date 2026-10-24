import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StageBox } from "@hekate/shared";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { PATCH_PAGE, patchListPages } from "../patch-pdf.ts";
import { textPdf } from "../text-pdf.ts";
import { run } from "./ffmpeg.ts";
import { type PdfPage, pdfOf, textPdfOf } from "./pdf.ts";
import { hasUnicodeFont, showText, usePdfFonts, widthOf, wrapToWidth } from "./pdf-text.ts";
import { scoreOverlay } from "./score-overlay.ts";
import { readTrueType } from "./truetype.ts";

const hasPoppler = spawnSync("pdftotext", ["-v"]).status === 0;
const ci = Boolean(process.env.CI);
/** DejaVu as CI and the image install it. */
const REGULAR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
const BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
/** Droid Sans Fallback, for Chinese, Japanese and Korean: CI installs it; elsewhere, say where. */
const CJK =
  process.env.PDF_FONT_FALLBACK ?? "/usr/share/fonts-droid-fallback/truetype/DroidSansFallback.ttf";
const hasDejaVu = existsSync(REGULAR) && existsSync(BOLD);
const hasCjk = existsSync(CJK);

/** Each script's version of the sample names. */
const NAMES = {
  greek: "Μίρα Σόλμπεργκ",
  cyrillic: "Мира Сольберг",
  hebrew: "מירה סולברג",
  arabic: "ميرا سولبرغ",
  czech: "Dvořák, Łódź",
};
const CJK_NAMES = {
  japanese: "ミラ・ソルベルグ 東京",
  chinese: "米拉索尔伯格",
  korean: "미라 솔베르그",
};

const unicodeFonts = (cjk = hasCjk) =>
  usePdfFonts({ regular: REGULAR, bold: BOLD, fallback: cjk ? [CJK] : [] });

const row = (channel: number, source: string, notes = "") => ({
  id: `r${channel}`,
  channel,
  source,
  device: "DPA 4006",
  cable: `A${channel}`,
  notes,
});
const patchPdf = (name: string, sources: string[]) => {
  const box: StageBox = {
    id: "a",
    name,
    inputs: sources.map((s, i) => row(i + 1, s)),
    outputs: [row(1, "Talkback", "To the piano")],
  };
  return textPdfOf(
    patchListPages("Joplin Rags", [box]).map((content) => ({ points: PATCH_PAGE, content })),
  );
};

/** A stand-in JPEG: only its frame header is read. */
const fakeJpeg = (width: number, height: number) => {
  const sof = Buffer.from([0xff, 0xc0, 0, 17, 8, 0, 0, 0, 0, 3]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0]), sof]);
};
const collect = async (chunks: AsyncIterable<Buffer>) => {
  const all: Buffer[] = [];
  for await (const chunk of chunks) all.push(chunk);
  return Buffer.concat(all);
};
async function* pagesOf(pages: PdfPage[]) {
  yield* pages;
}
const overlayPdf = (notes: string[]) => {
  const points = { width: 595, height: 842 };
  const overlay = scoreOverlay(
    notes.map((text, i) => ({
      kind: "note",
      x: 0.1,
      y: 0.1 + i * 0.1,
      width: null,
      height: null,
      points: null,
      text,
      categoryId: null,
      fixedBy: null,
      resolved: false,
      from: null,
      to: null,
    })),
    () => "signal",
    points,
  );
  return collect(
    pdfOf(pagesOf([{ jpeg: fakeJpeg(10, 14), width: 10, height: 14, points, overlay }])),
  );
};

describe("text outside Latin scripts in the PDFs", () => {
  const dir = mkdtempSync(join(tmpdir(), "hekate-pdf-text-"));
  afterEach(() => usePdfFonts({}));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** The text Poppler reads from a PDF, without its direction marks, spaces made single. */
  const extract = async (pdf: Buffer, name: string) => {
    const path = join(dir, `${name}.pdf`);
    writeFileSync(path, pdf);
    const { stdout } = await run("pdftotext", [path, "-"]);
    return stdout.replace(/[‎‏‪-‮]/g, "").replace(/\s+/g, " ");
  };

  it("prints in Helvetica alone without a Unicode font, as before", () => {
    const { fonts, problems } = usePdfFonts({ regular: join(dir, "none.ttf"), bold: BOLD });
    expect(fonts).toEqual([]);
    expect(problems).toEqual([`${join(dir, "none.ttf")}: no such file`]);
    expect(hasUnicodeFont()).toBe(false);
    expect(showText("regular", 9, 10, 20, "Мира", "0 g")).toBe(
      "BT /H 9 Tf 0 g 10 20 Td (????) Tj ET",
    );
  });

  it("refuses a font with PostScript outlines, and anything that is not a font", () => {
    const otf = Buffer.alloc(64);
    otf.write("OTTO", 0, "latin1");
    expect(() => readTrueType(otf)).toThrow("PostScript (CFF) outlines");
    expect(() => readTrueType(Buffer.from("%PDF-1.4 not a font at all"))).toThrow(
      "Not a TrueType font",
    );
  });

  it.runIf(hasDejaVu || ci)("reads a TrueType font's glyphs, widths and names", () => {
    const font = readTrueType(readFileSync(REGULAR));
    expect(font.name).toBe("DejaVuSans");
    const zhe = font.glyphOf("Ж".codePointAt(0) as number) as number;
    expect(zhe).toBeGreaterThan(0);
    expect(font.advance(zhe)).toBeGreaterThan(0);
    expect(font.textOf(zhe)).toBe("Ж");
    // An Arabic letter's final form copies out as the letter.
    expect(font.textOf(font.glyphOf(0xfeb2) as number)).toBe("س");
    // A subset keeps every glyph's number and only a few glyphs' outlines.
    const subset = font.subset([zhe]);
    expect(subset.readUInt32BE(0)).toBe(0x00010000);
    expect(subset.length).toBeLessThan(readFileSync(REGULAR).length / 10);
  });

  it.runIf(hasDejaVu || ci)("keeps Latin output exactly as it was, embedding nothing", async () => {
    const latin = ["Mira Solberg", "Crème brûlée", "Tomas Varga – take 3", "Ines Arlow"];
    const before = {
      patch: patchPdf("Stage box A", latin),
      text: textPdf(
        latin.map((text) => ({ text })),
        "Opening titles",
      ),
      overlay: await overlayPdf(latin),
    };
    unicodeFonts();
    expect(hasUnicodeFont()).toBe(true);
    const after = {
      patch: patchPdf("Stage box A", latin),
      text: textPdf(
        latin.map((text) => ({ text })),
        "Opening titles",
      ),
      overlay: await overlayPdf(latin),
    };
    expect(after.patch.equals(before.patch)).toBe(true);
    expect(after.text.equals(before.text)).toBe(true);
    expect(after.overlay.equals(before.overlay)).toBe(true);
    expect(after.patch.toString("latin1")).not.toContain("/FontFile2");
  });

  it.runIf((hasDejaVu && hasPoppler) || ci)(
    "sets Greek, Cyrillic, Hebrew, Arabic and Latin beyond WinAnsi, and they copy out",
    async () => {
      unicodeFonts(false);
      const names = Object.values(NAMES);
      const pdf = patchPdf(NAMES.cyrillic, names);
      const text = await extract(pdf, "scripts");
      for (const name of [...names, "Joplin Rags · Patch list", "To the piano"]) {
        expect(text).toContain(name);
      }
      // A subset of a few glyphs: kilobytes, where the whole font is 740 KB.
      expect(pdf.length).toBeLessThan(40_000);
      const raw = pdf.toString("latin1");
      expect(raw).toContain("/Subtype /CIDFontType2");
      expect(raw).toContain("/Encoding /Identity-H");
      // Latin cells are still Helvetica.
      expect(raw).toContain("(DPA 4006) Tj");
    },
  );

  it.runIf((hasDejaVu && hasCjk && hasPoppler) || ci)(
    "sets Japanese, Chinese and Korean from the fallback font",
    async () => {
      unicodeFonts(true);
      const names = Object.values(CJK_NAMES);
      const text = await extract(patchPdf(`${CJK_NAMES.japanese} · A`, names), "cjk");
      for (const name of names) expect(text.replace(/ /g, "")).toContain(name.replace(/ /g, ""));
      // A Japanese line is as wide as its characters: each about an em.
      expect(widthOf("東京東京", 10)).toBeGreaterThan(widthOf("Mira", 10) * 1.5);
    },
  );

  it.runIf((hasDejaVu && hasPoppler) || ci)(
    "writes a text PDF whose non-Latin lines wrap and copy out, title too",
    async () => {
      unicodeFonts();
      const long = `${NAMES.cyrillic}: ${"длинная заметка о второй части ".repeat(12)}`;
      const lines = wrapToWidth(long, 483, 10);
      expect(lines.length).toBeGreaterThan(2);
      for (const line of lines) expect(widthOf(line, 10)).toBeLessThanOrEqual(483);
      const pdf = textPdf(
        [{ text: NAMES.greek, bold: true, size: 14 }, { text: long }, { text: NAMES.hebrew }],
        NAMES.cyrillic,
      );
      const text = await extract(pdf, "text");
      expect(text).toContain(NAMES.greek);
      expect(text).toContain(NAMES.hebrew);
      expect(text).toContain("длинная заметка о второй части");
      const path = join(dir, "text.pdf");
      const { stdout } = await run("pdfinfo", [path]);
      expect(stdout).toMatch(new RegExp(`^Title:\\s+${NAMES.cyrillic}$`, "m"));
    },
  );

  it.runIf((hasDejaVu && hasPoppler) || ci)(
    "draws score notes in any script over the page",
    async () => {
      unicodeFonts();
      const text = await extract(await overlayPdf([NAMES.cyrillic, NAMES.arabic]), "overlay");
      expect(text).toContain(NAMES.cyrillic);
      expect(text).toContain(NAMES.arabic);
    },
  );

  it.runIf((hasDejaVu && hasPoppler) || ci)(
    "says what a character no font has stood for, though it cannot draw it",
    async () => {
      unicodeFonts(false);
      const ops = showText("regular", 9, 0, 0, "Mira ภาษา", "0 g");
      expect(ops).toContain("/ActualText");
      const text = await extract(patchPdf("Stage box A", ["Mira ภาษา"]), "missing");
      expect(text).toContain("Mira ภาษา");
    },
  );

  it.runIf(hasDejaVu || ci)("draws bold without a bold face heavier, oblique slanted", () => {
    usePdfFonts({ regular: REGULAR });
    const bold = showText("bold", 12, 10, 20, "Мира", "0.4 g");
    expect(bold).toMatch(
      /^q BT 0\.4 g 10 20 Td 2 Tr 0\.42 w 0\.4 G \/U1 12 Tf <[0-9A-F]+> Tj ET Q$/,
    );
    const oblique = showText("oblique", 12, 10, 20, "Мира", "1 0 0 rg");
    expect(oblique).toMatch(/^BT 1 0 0 rg 1 0 0\.21 1 10 20 Tm \/U1 12 Tf <[0-9A-F]+> Tj ET$/);
  });
});

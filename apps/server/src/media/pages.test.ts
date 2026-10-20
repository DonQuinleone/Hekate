import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { InvalidMediaError, run } from "./ffmpeg.ts";
import {
  PRINT_DPI,
  PRINT_LONGEST,
  pageSourceOf,
  parsePageSizes,
  parsePrintedNumbers,
  pdfPageSizes,
  pngSize,
  printDpi,
  printedBars,
  type RenderedPage,
  renderPages,
  renderPdfPage,
  THUMB_SIZE,
  VIEW_SIZE,
  webpComplete,
} from "./pages.ts";
import { samplePdf } from "./sample-pdf.ts";

const hasTools =
  spawnSync("pdftoppm", ["-v"]).status === 0 && spawnSync("ffmpeg", ["-version"]).status === 0;

describe("which files become pages", () => {
  it("draws PDFs and pictures, never SVG or anything else", () => {
    expect(pageSourceOf("Score.pdf", "application/octet-stream")).toBe("pdf");
    expect(pageSourceOf("cover", "image/jpeg")).toBe("image");
    expect(pageSourceOf("Cover.TIFF", "")).toBe("image");
    expect(pageSourceOf("logo.svg", "image/svg+xml")).toBeNull();
    expect(pageSourceOf("Notes.docx", "application/msword")).toBeNull();
  });
});

describe("pages drawn for print", () => {
  it("reads each page's size, turned pages turned", () => {
    const text = [
      "Pages:          3",
      "Page    1 size: 595.276 x 841.89 pts (A4)",
      "Page    1 rot:  0",
      "Page    2 size: 595.276 x 841.89 pts (A4)",
      "Page    2 rot:  90",
      "Page    3 size: 1190.55 x 1683.78 pts (A2)",
      "Page    3 rot:  270",
    ].join("\n");
    expect(parsePageSizes(text, 3)).toEqual([
      { width: 595.276, height: 841.89 },
      { width: 841.89, height: 595.276 },
      { width: 1683.78, height: 1190.55 },
    ]);
    expect(() => parsePageSizes(text, 4)).toThrow(InvalidMediaError);
  });

  it("draws at print resolution, and a poster smaller", () => {
    expect(printDpi({ width: 595, height: 842 })).toBe(PRINT_DPI);
    // A0: drawn at the size limit instead.
    const dpi = printDpi({ width: 2384, height: 3370 });
    expect(dpi).toBeLessThan(PRINT_DPI);
    expect(Math.round((3370 * dpi) / 72)).toBe(PRINT_LONGEST);
  });
});

describe("the bar numbers a score prints", () => {
  it("reads whole numbers and where they sit, leaving out large ones", () => {
    const xhtml = [
      '<doc><page width="600.000000" height="800.000000">',
      '<word xMin="72.0" yMin="100.0" xMax="180.0" yMax="148.0">1</word>',
      '<word xMin="30.0" yMin="200.0" xMax="40.0" yMax="210.0">5</word>',
      '<word xMin="60.0" yMin="200.0" xMax="90.0" yMax="210.0">Allegro</word>',
      '</page><page width="600.000000" height="800.000000">',
      '<word xMin="30.0" yMin="400.0" xMax="42.0" yMax="410.0">17</word>',
      "</page></doc>",
    ].join("\n");
    expect(parsePrintedNumbers(xhtml)).toEqual([
      { page: 1, x: 0.05, y: 0.25, bar: 5 },
      { page: 2, x: 0.05, y: 0.5, bar: 17 },
    ]);
  });
});

describe.runIf(hasTools || process.env.CI)("drawing pages", () => {
  const dir = mkdtempSync(join(tmpdir(), "hekate-pages-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const signal = new AbortController().signal;
  /** Every page drawn, as the worker would be handed them one by one. */
  const draw = async (path: string, source: "pdf" | "image", work: string) => {
    const pages: RenderedPage[] = [];
    const result = await renderPages(path, source, work, signal, async (p) => {
      pages.push(p);
    });
    return { pages, ...result };
  };

  it("finds the bar numbers a score prints in its text", async () => {
    const pdf = join(dir, "bars.pdf");
    writeFileSync(pdf, samplePdf(2, { bars: true }));
    const bars = await printedBars(pdf, 2, signal);
    expect(bars.map((b) => [b.page, b.bar])).toEqual([
      [1, 5],
      [1, 9],
      [1, 13],
      [2, 17],
      [2, 21],
      [2, 25],
      [2, 29],
    ]);
    // A PDF without them has none.
    writeFileSync(pdf, samplePdf(2));
    expect(await printedBars(pdf, 2, signal)).toEqual([]);
  });

  it("draws one page of a PDF for print, at its own size", async () => {
    const pdf = join(dir, "print.pdf");
    writeFileSync(pdf, samplePdf(2));
    const sizes = await pdfPageSizes(pdf, 2);
    expect(sizes).toEqual([
      { width: 595, height: 842 },
      { width: 595, height: 842 },
    ]);
    const out = join(dir, "print-2.png");
    await renderPdfPage(pdf, 2, 150, out);
    // 595 by 842 points at 150 dots an inch, give or take Poppler's rounding.
    const size = pngSize(readFileSync(out));
    expect(Math.abs(size.width - 1240)).toBeLessThanOrEqual(1);
    expect(Math.abs(size.height - 1754)).toBeLessThanOrEqual(1);
  });

  it("draws every page of a PDF at review size, with a thumbnail", async () => {
    const pdf = join(dir, "score.pdf");
    writeFileSync(pdf, samplePdf(3));
    const work = mkdtempSync(join(dir, "w-"));
    const { pages, total, drawn } = await draw(pdf, "pdf", work);
    expect(total).toBe(3);
    expect(drawn).toBe(3);
    expect(pages.map((p) => p.page)).toEqual([1, 2, 3]);
    // A4 portrait: the height is the long side.
    expect(pages[0]?.height).toBe(VIEW_SIZE);
    expect(pages[0]?.width).toBeCloseTo((VIEW_SIZE * 595) / 842, -1);
    for (const p of pages) {
      // Complete, as browsers need: the RIFF header says how long the image is.
      expect(webpComplete(p.view)).toBe(true);
      expect(webpComplete(p.thumb)).toBe(true);
      expect(p.thumb.length).toBeLessThan(p.view.length);
    }
  });

  it("draws a picture as one page, never larger than it was", async () => {
    const png = join(dir, "cover.png");
    await run("ffmpeg", [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=640x480",
      "-frames:v",
      "1",
      png,
    ]);
    const work = mkdtempSync(join(dir, "w-"));
    const { pages } = await draw(png, "image", work);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ page: 1, width: 640, height: 480 });
    expect(() => pngSize(Buffer.from("short"))).toThrow();
    expect(THUMB_SIZE).toBeLessThan(VIEW_SIZE);
  });

  it("refuses a file that is not what it claims", async () => {
    const fake = join(dir, "fake.pdf");
    writeFileSync(fake, "not a pdf at all");
    const work = mkdtempSync(join(dir, "w-"));
    await expect(draw(fake, "pdf", work)).rejects.toBeInstanceOf(InvalidMediaError);
    const fakePicture = join(dir, "fake.png");
    writeFileSync(fakePicture, "not a picture");
    await expect(draw(fakePicture, "image", work)).rejects.toBeInstanceOf(InvalidMediaError);
  });
});

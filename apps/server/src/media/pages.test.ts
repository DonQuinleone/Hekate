import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { InvalidMediaError, run } from "./ffmpeg.ts";
import {
  pageSourceOf,
  pngSize,
  type RenderedPage,
  renderPages,
  THUMB_SIZE,
  VIEW_SIZE,
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
      expect(p.view.subarray(8, 12).toString()).toBe("WEBP");
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

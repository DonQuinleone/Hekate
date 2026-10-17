import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { run } from "./ffmpeg.ts";
import { jpegSize, type PdfPage, pdfOf, pointsOf } from "./pdf.ts";

const hasTools =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("pdfinfo", ["-v"]).status === 0;

/** A stand-in JPEG: only its frame header is read here. */
const fakeJpeg = (width: number, height: number) => {
  const sof = Buffer.from([0xff, 0xc0, 0, 17, 8, 0, 0, 0, 0, 3]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0]), sof]);
};

async function* pagesOf(pages: PdfPage[]) {
  yield* pages;
}

const collect = async (chunks: AsyncIterable<Buffer>) => {
  const all: Buffer[] = [];
  for await (const chunk of chunks) all.push(chunk);
  return Buffer.concat(all);
};

describe("PDFs of pictures", () => {
  const dir = mkdtempSync(join(tmpdir(), "hekate-pdf-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads a JPEG's size from its frame header, past the markers before it", () => {
    expect(jpegSize(fakeJpeg(1414, 2000))).toEqual({ width: 1414, height: 2000 });
    expect(() => jpegSize(Buffer.from("RIFF0000WEBP"))).toThrow("Not a JPEG");
  });

  it("sizes a page without a size of its own as A4 on its longest side", () => {
    expect(pointsOf(1414, 2000)).toEqual({ width: 1414 * 0.421, height: 842 });
    expect(pointsOf(2000, 1000)).toEqual({ width: 842, height: 421 });
  });

  it("points every cross-reference at its object, page by page", async () => {
    const pdf = await collect(
      pdfOf(
        pagesOf([
          { jpeg: fakeJpeg(10, 20), width: 10, height: 20, points: { width: 421, height: 842 } },
          { jpeg: fakeJpeg(20, 10), width: 20, height: 10, points: { width: 842, height: 421 } },
        ]),
      ),
    );
    const text = pdf.toString("latin1");
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text.endsWith("%%EOF\n")).toBe(true);
    const start = Number(/startxref\n(\d+)\n/.exec(text)?.[1]);
    expect(text.slice(start, start + 4)).toBe("xref");
    const entries = text.slice(start).split("\n").slice(3, 11);
    expect(entries).toHaveLength(8);
    entries.forEach((entry, i) => {
      const offset = Number(entry.slice(0, 10));
      expect(text.slice(offset).startsWith(`${i + 1} 0 obj\n`)).toBe(true);
    });
    expect(text).toContain("/Type /Pages /Kids [5 0 R 8 0 R] /Count 2");
    expect(text).toContain("/MediaBox [0 0 842 421]");
  });

  it("refuses a PDF of no pages, and sends nothing before the first page is made", async () => {
    await expect(collect(pdfOf(pagesOf([])))).rejects.toThrow("at least one page");
    const failing: AsyncIterable<PdfPage> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error("Cannot draw page 1")),
      }),
    };
    const chunks = pdfOf(failing);
    await expect(chunks.next()).rejects.toThrow("Cannot draw page 1");
    const first = await pdfOf(
      pagesOf([
        { jpeg: fakeJpeg(10, 20), width: 10, height: 20, points: { width: 421, height: 842 } },
      ]),
    ).next();
    const text = first.value?.toString("latin1") ?? "";
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text).toContain("/Subtype /Image");
  });

  it.runIf(hasTools || process.env.CI)("writes a PDF that Poppler reads and draws", async () => {
    const jpg = join(dir, "page.jpg");
    await run("ffmpeg", [
      ...["-hide_banner", "-nostdin", "-v", "error", "-f", "lavfi"],
      ...["-i", "color=red:s=300x400", "-frames:v", "1", "-pix_fmt", "yuvj444p", jpg],
    ]);
    const jpeg = readFileSync(jpg);
    const page = { jpeg, ...jpegSize(jpeg), points: pointsOf(300, 400) };
    const path = join(dir, "out.pdf");
    writeFileSync(path, await collect(pdfOf(pagesOf([page, page, page]))));
    const { stdout } = await run("pdfinfo", [path]);
    expect(stdout).toMatch(/^Pages:\s+3$/m);
    expect(stdout).toMatch(/^Page size:\s+631.5 x 842 pts/m);
    await run("pdftoppm", [
      "-png",
      "-r",
      "10",
      "-f",
      "2",
      "-l",
      "2",
      "-singlefile",
      path,
      join(dir, "drawn"),
    ]);
    expect(readFileSync(join(dir, "drawn.png")).subarray(1, 4).toString()).toBe("PNG");
  });
});

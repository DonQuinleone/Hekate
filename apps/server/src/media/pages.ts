import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { barNumbersOf, isPdf, type PrintedBar } from "@hekate/shared";
import { InvalidMediaError, MediaToolError, run } from "./ffmpeg.ts";

/**
 * Protected viewing (#29, docs/security.md): scores, documents and artwork reach a browser
 * only as pages the server has drawn, never as the file itself. A PDF becomes one image a
 * page (Poppler), a picture becomes one page (ffmpeg); each page is kept at review size
 * and as a thumbnail, both WebP, both encrypted like everything else in storage.
 */

/** The longest side of a page as reviewers see it. */
export const VIEW_SIZE = 2000;
/** And of its thumbnail. */
export const THUMB_SIZE = 320;
/** Pages drawn from one document; the rest are left out, and the file says so. */
export const MAX_PAGES = 300;

/** Single-picture demuxers only: no image sequences, playlists or devices. */
export const IMAGE_DEMUXERS = [
  "png_pipe",
  "jpeg_pipe",
  "webp_pipe",
  "tiff_pipe",
  "bmp_pipe",
  "gif",
  "gif_pipe",
].join(",");

const IMAGE_ARGS = ["-hide_banner", "-nostdin", "-protocol_whitelist", "file"];

export type PageSource = "pdf" | "image";

/** Whether a file can be drawn as pages, and how. SVG is left out: it is a program, not a picture. */
export function pageSourceOf(name: string, contentType: string): PageSource | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (isPdf(name, contentType)) return "pdf";
  if (["jpg", "jpeg", "png", "webp", "tif", "tiff", "bmp", "gif"].includes(ext)) return "image";
  if (/^image\/(jpeg|png|webp|tiff|bmp|gif)$/.test(contentType)) return "image";
  return null;
}

export interface RenderedPage {
  /** 1-based. */
  page: number;
  width: number;
  height: number;
  view: Buffer;
  thumb: Buffer;
}

/** The width and height a PNG declares in its header. */
export function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.toString("latin1", 12, 16) !== "IHDR") {
    throw new MediaToolError("Not a PNG");
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * A PNG at most `size` on its longest side, as WebP. Written to a file, not a pipe: on a
 * pipe ffmpeg cannot go back to fill in the RIFF size, and browsers refuse larger images
 * without it.
 */
async function webp(png: string, size: number, signal: AbortSignal): Promise<Buffer> {
  const out = `${png}.${size}.webp`;
  await run(
    "ffmpeg",
    [
      ...IMAGE_ARGS,
      "-format_whitelist",
      "png_pipe",
      "-v",
      "error",
      "-i",
      `file:${png}`,
      "-vf",
      `scale='min(${size},iw)':'min(${size},ih)':force_original_aspect_ratio=decrease`,
      "-frames:v",
      "1",
      "-c:v",
      "libwebp",
      "-quality",
      "82",
      "-y",
      `file:${out}`,
    ],
    { signal, timeoutMs: 60_000 },
  );
  return readFile(out);
}

/** A WebP's width and height, from its first chunk (lossy, lossless or extended). */
export function webpSize(image: Buffer): { width: number; height: number } | null {
  if (image.length < 30 || image.toString("latin1", 8, 12) !== "WEBP") return null;
  const chunk = image.toString("latin1", 12, 16);
  if (chunk === "VP8 ")
    return { width: image.readUInt16LE(26) & 0x3fff, height: image.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = image.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X")
    return { width: image.readUIntLE(24, 3) + 1, height: image.readUIntLE(27, 3) + 1 };
  return null;
}

/** Whether a WebP says how long it is, as browsers need; ffmpeg leaves 0 on a pipe. */
export const webpComplete = (image: Buffer) =>
  image.length >= 12 &&
  image.toString("latin1", 0, 4) === "RIFF" &&
  image.toString("latin1", 8, 12) === "WEBP" &&
  image.readUInt32LE(4) === image.length - 8;

/** How many pages a PDF has, from Poppler's own count. */
export async function pdfPageCount(path: string, signal: AbortSignal): Promise<number> {
  let stdout: string;
  try {
    ({ stdout } = await run("pdfinfo", [path], { signal, timeoutMs: 60_000 }));
  } catch (error) {
    if (error instanceof MediaToolError && !/timed out|cancelled/.test(error.message)) {
      throw new InvalidMediaError(`Not a readable PDF: ${error.message}`);
    }
    throw error;
  }
  const pages = Number(/^Pages:\s+(\d+)/m.exec(stdout)?.[1]);
  if (!Number.isInteger(pages) || pages < 1) throw new InvalidMediaError("The PDF has no pages");
  return pages;
}

/**
 * Draw a document or picture as pages, in the job's workspace. Each page is handed to
 * `onPage` as soon as it is drawn, so a long document is never held in memory at once.
 * Returns how many pages were drawn, and how many the document has.
 */
export async function renderPages(
  path: string,
  source: PageSource,
  dir: string,
  signal: AbortSignal,
  onPage: (page: RenderedPage) => Promise<void>,
): Promise<{ drawn: number; total: number }> {
  let pngs: string[];
  let total = 1;
  if (source === "pdf") {
    total = await pdfPageCount(path, signal);
    // Poppler draws each page with its longest side at the view size.
    await run(
      "pdftoppm",
      [
        "-png",
        "-scale-to",
        String(VIEW_SIZE),
        "-l",
        String(Math.min(total, MAX_PAGES)),
        path,
        join(dir, "page"),
      ],
      { signal, timeoutMs: 20 * 60_000 },
    );
    pngs = (await readdir(dir))
      .filter((n) => /^page-\d+\.png$/.test(n))
      .sort((a, b) => Number(/\d+/.exec(a)?.[0]) - Number(/\d+/.exec(b)?.[0]))
      .map((n) => join(dir, n));
  } else {
    const png = join(dir, "page-1.png");
    try {
      await run(
        "ffmpeg",
        [
          ...IMAGE_ARGS,
          "-format_whitelist",
          IMAGE_DEMUXERS,
          "-v",
          "error",
          "-i",
          `file:${path}`,
          "-vf",
          `scale='min(${VIEW_SIZE},iw)':'min(${VIEW_SIZE},ih)':force_original_aspect_ratio=decrease`,
          "-frames:v",
          "1",
          png,
        ],
        { signal, timeoutMs: 2 * 60_000 },
      );
    } catch (error) {
      if (error instanceof MediaToolError && !/timed out|cancelled/.test(error.message)) {
        throw new InvalidMediaError(`Not a readable picture: ${error.message}`);
      }
      throw error;
    }
    pngs = [png];
  }
  if (pngs.length === 0) throw new InvalidMediaError("Nothing could be drawn from the file");
  for (const [i, png] of pngs.entries()) {
    const size = pngSize(await readFile(png));
    await onPage({
      page: i + 1,
      ...size,
      view: await webp(png, VIEW_SIZE, signal),
      thumb: await webp(png, THUMB_SIZE, signal),
    });
  }
  return { drawn: pngs.length, total };
}

/** Pages of a document downloaded as its original are drawn at this resolution (#136)... */
export const PRINT_DPI = 300;
/** ...unless their longest side would pass this many pixels, as a poster's would. */
export const PRINT_LONGEST = 4200;

/**
 * Each page's size in points, as it is shown (turned pages turned), for the first `pages`
 * pages of a PDF, from Poppler's own reading.
 */
export async function pdfPageSizes(
  path: string,
  pages: number,
  signal?: AbortSignal,
): Promise<{ width: number; height: number }[]> {
  const { stdout } = await run("pdfinfo", ["-f", "1", "-l", String(pages), path], {
    signal,
    timeoutMs: 60_000,
    maxOutput: 16 * 1024 * 1024,
  });
  return parsePageSizes(stdout, pages);
}

/** Page sizes from what `pdfinfo -f -l` prints: a `size` line and a `rot` line a page. */
export function parsePageSizes(text: string, pages: number): { width: number; height: number }[] {
  const sizes: { width: number; height: number }[] = [];
  for (const m of text.matchAll(/^Page\s+(\d+)\s+size:\s+([\d.]+) x ([\d.]+) pts/gm)) {
    sizes[Number(m[1]) - 1] = { width: Number(m[2]), height: Number(m[3]) };
  }
  for (const m of text.matchAll(/^Page\s+(\d+)\s+rot:\s+(\d+)/gm)) {
    const size = sizes[Number(m[1]) - 1];
    if (size && Number(m[2]) % 180 === 90)
      sizes[Number(m[1]) - 1] = { width: size.height, height: size.width };
  }
  const out = Array.from({ length: pages }, (_, i) => sizes[i]);
  if (out.some((s) => !s || !(s.width > 0) || !(s.height > 0)))
    throw new InvalidMediaError("The PDF's page sizes could not be read");
  return out as { width: number; height: number }[];
}

/** The resolution a page of this size is drawn at for print. */
export const printDpi = (points: { width: number; height: number }) =>
  Math.min(PRINT_DPI, (PRINT_LONGEST * 72) / Math.max(points.width, points.height));

/** One page of a PDF drawn at `dpi`, as a PNG at `out`. */
export async function renderPdfPage(
  path: string,
  page: number,
  dpi: number,
  out: string,
  signal?: AbortSignal,
): Promise<void> {
  // Poppler adds the extension itself.
  const stem = out.replace(/\.png$/, "");
  await run(
    "pdftoppm",
    [
      "-png",
      "-r",
      dpi.toFixed(2),
      "-f",
      String(page),
      "-l",
      String(page),
      "-singlefile",
      path,
      stem,
    ],
    { signal, timeoutMs: 5 * 60_000 },
  );
}

/** A bar number is printed small; a title's or a heading's number is not one. */
const TALLEST_NUMBER = 0.03;

/**
 * The whole numbers printed in a PDF's text, from what `pdftotext -bbox` writes: each placed by
 * page and by its top left corner, in shares of the page. Words in a large size are left out.
 */
export function parsePrintedNumbers(xhtml: string): PrintedBar[] {
  const out: PrintedBar[] = [];
  let page = 0;
  for (const part of xhtml.split("<page ").slice(1)) {
    page++;
    const width = Number(/width="([\d.]+)"/.exec(part)?.[1]);
    const height = Number(/height="([\d.]+)"/.exec(part)?.[1]);
    if (!(width > 0) || !(height > 0)) continue;
    for (const w of part.matchAll(
      /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="[\d.]+" yMax="([\d.]+)">(\d{1,5})<\/word>/g,
    )) {
      const [, x, y, bottom, digits] = w;
      if ((Number(bottom) - Number(y)) / height > TALLEST_NUMBER) continue;
      out.push({ page, x: Number(x) / width, y: Number(y) / height, bar: Number(digits) });
    }
  }
  return out;
}

/**
 * The bar numbers a score prints, on its first `pages` pages (#52), for going to a bar.
 * Nothing for a score whose text holds none, as a scanned one does not.
 */
export async function printedBars(
  path: string,
  pages: number,
  signal: AbortSignal,
): Promise<PrintedBar[]> {
  const { stdout } = await run("pdftotext", ["-bbox", "-f", "1", "-l", String(pages), path, "-"], {
    signal,
    timeoutMs: 2 * 60_000,
    maxOutput: 64 * 1024 * 1024,
  });
  return barNumbersOf(parsePrintedNumbers(stdout));
}

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
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
const IMAGE_DEMUXERS = [
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
  if (contentType === "application/pdf" || ext === "pdf") return "pdf";
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

/** A PNG at most `size` on its longest side, as WebP. */
async function webp(png: string, size: number, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
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
      "-f",
      "webp",
      "pipe:1",
    ],
    { signal, timeoutMs: 60_000, onStdout: (chunk) => chunks.push(chunk) },
  );
  return Buffer.concat(chunks);
}

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

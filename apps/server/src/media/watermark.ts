import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "./ffmpeg.ts";
import { withWorkspace } from "./workspace.ts";

/**
 * The visible watermark (docs/security.md, Watermarking): who is looking, burned into the
 * page on the server, so a screenshot or a saved page says whose it was. Guests' pages
 * carry it; the page as stored never does.
 */

/** Fonts tried in turn; the image installs DejaVu. Without any, fontconfig picks a sans. */
const FONTS = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans.ttf",
];
const font = FONTS.find((f) => existsSync(f));

/** The two lines of the mark: who, and where and when. */
export function watermarkText(
  viewer: { name: string; email: string },
  organisation: string,
  at: Date,
): string {
  const day = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(at);
  // One line each, whatever was typed into a name.
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  return `${flat(viewer.name)} · ${flat(viewer.email)}\n${flat(organisation)} · ${day}`;
}

/**
 * Where the mark is drawn, in shares of the page: staggered rows down the whole page at
 * review size, so no crop leaves it out; one line across the middle of a thumbnail.
 */
function tiles(size: "view" | "thumb"): { x: number; y: number }[] {
  if (size === "thumb") return [{ x: 0.08, y: 0.45 }];
  const rows = [0.06, 0.22, 0.38, 0.54, 0.7, 0.86];
  return rows.map((y, i) => ({ x: i % 2 === 0 ? 0.04 : 0.3, y }));
}

/** A page (WebP) with the viewer's mark drawn over it, as WebP. */
export async function watermark(
  page: Buffer,
  text: string,
  size: "view" | "thumb",
  signal?: AbortSignal,
): Promise<Buffer> {
  return withWorkspace(undefined, async (dir) => {
    const input = join(dir, "page.webp");
    const mark = join(dir, "mark.txt");
    await writeFile(input, page);
    // From a file, with expansion off: nothing in a name is read as a filter or a code.
    await writeFile(mark, text);
    const scale = size === "thumb" ? 30 : 60;
    const face = font ? `fontfile='${font}'` : "font=Sans";
    const filters = tiles(size).map(
      (t) =>
        `drawtext=${face}:textfile='${mark}':expansion=none:fontsize=h/${scale}:line_spacing=6` +
        `:fontcolor=0x808080@0.3:x=w*${t.x}:y=h*${t.y}`,
    );
    const chunks: Buffer[] = [];
    await run(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostdin",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        "webp_pipe",
        "-v",
        "error",
        "-f",
        "webp_pipe",
        "-i",
        `file:${input}`,
        "-vf",
        filters.join(","),
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
  });
}

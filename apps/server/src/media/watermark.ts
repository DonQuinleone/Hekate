import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultWatermark, type WatermarkPosition, type WatermarkSettings } from "@hekate/shared";
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

/**
 * Where the mark is drawn, in shares of the page: staggered rows down the whole page when
 * tiled, so no crop leaves it out; once in the bottom right corner or across the middle.
 * A thumbnail carries one line across its middle, whatever the project chose.
 */
function places(size: "view" | "thumb", position: WatermarkPosition): { x: string; y: string }[] {
  if (size === "thumb" || position === "centre") return [{ x: "(w-text_w)/2", y: "(h-text_h)/2" }];
  if (position === "corner") return [{ x: "w-text_w-w*0.03", y: "h-text_h-h*0.03" }];
  const rows = [0.06, 0.22, 0.38, 0.54, 0.7, 0.86];
  return rows.map((y, i) => ({ x: `w*${i % 2 === 0 ? 0.04 : 0.3}`, y: `h*${y}` }));
}

/** A page (WebP) with the viewer's mark drawn over it, as WebP. */
export async function watermark(
  page: Buffer,
  text: string,
  size: "view" | "thumb",
  signal?: AbortSignal,
  style: Pick<WatermarkSettings, "position" | "opacity"> = defaultWatermark,
): Promise<Buffer> {
  return withWorkspace(undefined, async (dir) => {
    const input = join(dir, "page.webp");
    const mark = join(dir, "mark.txt");
    await writeFile(input, page);
    // From a file, with expansion off: nothing in a name is read as a filter or a code.
    await writeFile(mark, text);
    const scale = size === "thumb" ? 30 : 60;
    const face = font ? `fontfile='${font}'` : "font=Sans";
    const alpha = (style.opacity / 100).toFixed(2);
    const filters = places(size, style.position).map(
      (t) =>
        `drawtext=${face}:textfile='${mark}':expansion=none:fontsize=h/${scale}:line_spacing=6` +
        `:fontcolor=0x808080@${alpha}:x=${t.x}:y=${t.y}`,
    );
    // To a file, so that the WebP says how long it is (see `webp` in pages.ts).
    const output = join(dir, "marked.webp");
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
        "-y",
        `file:${output}`,
      ],
      { signal, timeoutMs: 60_000 },
    );
    return readFile(output);
  });
}

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

/**
 * The ffmpeg filter that draws the mark written in the file at `textPath`: read from a file,
 * with expansion off, so nothing in a name is read as a filter or a code.
 */
export function markFilter(
  textPath: string,
  size: "view" | "thumb",
  style: Pick<WatermarkSettings, "position" | "opacity">,
): string {
  const scale = size === "thumb" ? 30 : 60;
  const face = font ? `fontfile='${font}'` : "font=Sans";
  const alpha = (style.opacity / 100).toFixed(2);
  return places(size, style.position)
    .map(
      (t) =>
        `drawtext=${face}:textfile='${textPath}':expansion=none:fontsize=h/${scale}:line_spacing=6` +
        `:fontcolor=0x808080@${alpha}:x=${t.x}:y=${t.y}`,
    )
    .join(",");
}

/** What a marked picture is written as. */
export type MarkedFormat = "webp" | "jpeg" | "png" | "tiff";

const encoders: Record<MarkedFormat, string[]> = {
  webp: ["-c:v", "libwebp", "-quality", "82"],
  // Three components, as a PDF page takes them (see pdf.ts).
  jpeg: ["-c:v", "mjpeg", "-q:v", "2", "-pix_fmt", "yuvj444p", "-update", "1"],
  png: ["-c:v", "png", "-update", "1"],
  tiff: ["-c:v", "tiff", "-compression_algo", "deflate", "-update", "1"],
};

export const extensionOf: Record<MarkedFormat, string> = {
  webp: "webp",
  jpeg: "jpg",
  png: "png",
  tiff: "tif",
};

/**
 * Draw the viewer's mark over the picture at `input`, written to `output` as `format`. Only
 * the demuxers named are tried, so nothing but a single picture is read.
 */
export async function markPicture(
  input: string,
  output: string,
  options: {
    text: string;
    demuxers: string;
    format: MarkedFormat;
    size?: "view" | "thumb";
    signal?: AbortSignal;
    style?: Pick<WatermarkSettings, "position" | "opacity">;
  },
): Promise<void> {
  const { size = "view", style = defaultWatermark } = options;
  const mark = `${output}.txt`;
  await writeFile(mark, options.text);
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-protocol_whitelist",
      "file",
      "-format_whitelist",
      options.demuxers,
      "-v",
      "error",
      "-i",
      `file:${input}`,
      "-vf",
      markFilter(mark, size, style),
      "-frames:v",
      "1",
      ...encoders[options.format],
      "-y",
      `file:${output}`,
    ],
    { signal: options.signal, timeoutMs: 2 * 60_000 },
  );
}

/** A page (WebP) with the viewer's mark drawn over it, as WebP, or as JPEG for a PDF page. */
export async function watermark(
  page: Buffer,
  text: string,
  size: "view" | "thumb",
  signal?: AbortSignal,
  style: Pick<WatermarkSettings, "position" | "opacity"> = defaultWatermark,
  format: "webp" | "jpeg" = "webp",
  /** Where decrypted pages may be written (WORK_DIR); the system's temporary directory if unset. */
  workDir?: string,
): Promise<Buffer> {
  return withWorkspace(workDir, async (dir) => {
    const input = join(dir, "page.webp");
    await writeFile(input, page);
    // To a file, so that the WebP says how long it is (see `webp` in pages.ts).
    const output = join(dir, `marked.${extensionOf[format]}`);
    await markPicture(input, output, {
      text,
      demuxers: "webp_pipe",
      format,
      size,
      signal,
      style,
    });
    return readFile(output);
  });
}

/** What a picture's original is written back as once marked: its own format, or PNG. */
export function markedFormatOf(name: string, contentType: string): MarkedFormat {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "jpg" || ext === "jpeg" || contentType === "image/jpeg") return "jpeg";
  if (ext === "webp" || contentType === "image/webp") return "webp";
  if (ext === "tif" || ext === "tiff" || contentType === "image/tiff") return "tiff";
  return "png";
}

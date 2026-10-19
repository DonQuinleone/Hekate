import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { run, safeInputArgs } from "./ffmpeg.ts";

/** How many frames a filmstrip holds: enough to find a scene, few enough to stay small. */
export const FILMSTRIP_FRAMES = 12;
/** Each frame's height in the picture; its width follows the video's shape. */
export const FILMSTRIP_HEIGHT = 90;

/**
 * A video's filmstrip (#16): FILMSTRIP_FRAMES frames at even steps along it, each from the
 * middle of its step (so not the black of a fade in), scaled to one height and laid side by
 * side in one WebP. Written to a file, so the WebP says how long it is (see `webp` in pages.ts).
 */
export async function makeFilmstrip(
  input: string,
  dir: string,
  duration: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const output = join(dir, "filmstrip.webp");
  const step = duration / FILMSTRIP_FRAMES;
  await run(
    "ffmpeg",
    [
      ...safeInputArgs("ffmpeg"),
      "-v",
      "error",
      "-ss",
      (step / 2).toFixed(3),
      "-i",
      `file:${input}`,
      "-map",
      "0:v:0",
      "-vf",
      [
        `fps=${FILMSTRIP_FRAMES}/${duration.toFixed(3)}`,
        `scale=-2:${FILMSTRIP_HEIGHT}`,
        `tile=${FILMSTRIP_FRAMES}x1`,
      ].join(","),
      "-frames:v",
      "1",
      "-c:v",
      "libwebp",
      "-quality",
      "75",
      "-y",
      `file:${output}`,
    ],
    { signal, timeoutMs: 10 * 60_000 },
  );
  return readFile(output);
}

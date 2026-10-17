import { spawn } from "node:child_process";
import type { WatermarkSettings } from "@hekate/shared";
import { InvalidMediaError, MediaToolError, run, safeInputArgs } from "./ffmpeg.ts";
import { markFilter } from "./watermark.ts";

/**
 * A video download with the recipient's mark burned into the picture (#136): encoded as it
 * is sent, so a long film starts at once and is never kept. The proxy is the stream's own
 * encode, marked; the original is the original at its own size, marked, at a quality meant
 * to be worked from, its sound carried as it was where QuickTime can carry it.
 */

export type BurnQuality = "proxy" | "original";

/** Audio QuickTime carries as it is; anything else becomes 24-bit PCM. */
const QUICKTIME_AUDIO = new Set([
  "aac",
  "alac",
  "mp3",
  "ac3",
  "eac3",
  "pcm_s16le",
  "pcm_s16be",
  "pcm_s24le",
  "pcm_s24be",
  "pcm_s32le",
  "pcm_s32be",
  "pcm_f32le",
  "pcm_f32be",
  "pcm_f64le",
  "pcm_f64be",
]);

/** The container each quality is sent in. */
export const burnFormat = {
  proxy: { contentType: "video/mp4", extension: "mp4" },
  original: { contentType: "video/quicktime", extension: "mov" },
} as const satisfies Record<BurnQuality, { contentType: string; extension: string }>;

/** The codec of each audio stream in a file, in order, as ffprobe names them. */
export async function audioCodecsOf(path: string, signal?: AbortSignal): Promise<string[]> {
  const { stdout } = await run(
    "ffprobe",
    [
      ...safeInputArgs("ffprobe"),
      ...["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_name"],
      ...["-of", "csv=p=0", `file:${path}`],
    ],
    { signal, timeoutMs: 60_000 },
  );
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * How long a marked video may take to make and send: ten times its length, and never less
 * than a quarter of an hour, so a stalled tool or a stalled reader cannot hold it for ever.
 */
export const burnDeadlineMs = (durationSeconds: number | undefined) =>
  durationSeconds && Number.isFinite(durationSeconds)
    ? Math.max(15 * 60_000, durationSeconds * 10_000)
    : 2 * 60 * 60_000;

/** ffmpeg's arguments for a marked video, written as fragments to standard output. */
export function burnArgs(
  input: string,
  textPath: string,
  options: {
    quality: BurnQuality;
    /** Each audio stream's codec, in order; the proxy's are always AAC. */
    audioCodecs?: readonly string[];
    style: Pick<WatermarkSettings, "position" | "opacity">;
  },
): string[] {
  const original = options.quality === "original";
  // Stream by stream: QuickTime carries some sound as it is, and the rest as 24-bit PCM.
  const audio = original
    ? (options.audioCodecs ?? []).flatMap((codec, i) => [
        `-c:a:${i}`,
        QUICKTIME_AUDIO.has(codec) ? "copy" : "pcm_s24le",
      ])
    : ["-c:a", "copy"];
  return [
    ...safeInputArgs("ffmpeg"),
    "-v",
    "error",
    "-i",
    `file:${input}`,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    // Nothing of the source's own description (places, devices, names) goes with it.
    "-map_metadata",
    "-1",
    "-vf",
    // H.264 in 4:2:0 needs even dimensions; an odd one loses its last line.
    `${markFilter(textPath, "view", options.style)},scale=trunc(iw/2)*2:trunc(ih/2)*2`,
    "-c:v",
    "libx264",
    "-preset",
    original ? "fast" : "veryfast",
    "-crf",
    original ? "16" : "20",
    "-pix_fmt",
    "yuv420p",
    ...audio,
    // Fragments, so the file can be written to a pipe and played as it arrives.
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",
    "-f",
    original ? "mov" : "mp4",
    "pipe:1",
  ];
}

/**
 * Run ffmpeg with `args` and hand on what it writes as it writes it. Reading slowly slows
 * ffmpeg down rather than filling memory; stopping early, `signal` or `timeoutMs` ends it.
 */
export async function* streamFfmpeg(
  args: string[],
  options: { signal?: AbortSignal; timeoutMs: number },
): AsyncGenerator<Buffer> {
  const { signal, timeoutMs } = options;
  if (signal?.aborted) throw new MediaToolError("ffmpeg was cancelled before it started");
  const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    // Keep the end of stderr: that is where ffmpeg explains a failure.
    stderr = (stderr + chunk.toString()).slice(-8192);
  });
  const ended = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.on("error", (error) => resolve({ code: null, error }));
    child.on("close", (code) => resolve({ code }));
  });
  const stop = () => child.kill("SIGKILL");
  signal?.addEventListener("abort", stop, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  let done = false;
  try {
    for await (const chunk of child.stdout) yield chunk as Buffer;
    const { code, error } = await ended;
    done = true;
    if (error) throw new MediaToolError(`ffmpeg could not run: ${error.message}`);
    if (timedOut) throw new MediaToolError(`ffmpeg timed out after ${timeoutMs} ms`);
    if (signal?.aborted) throw new MediaToolError("ffmpeg was cancelled");
    if (code !== 0) {
      const reason = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 500);
      throw code === null
        ? new MediaToolError(`ffmpeg was killed: ${reason}`)
        : new InvalidMediaError(`ffmpeg exited with ${code}: ${reason}`);
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    if (!done) {
      stop();
      await ended;
    }
  }
}

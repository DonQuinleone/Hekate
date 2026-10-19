import { spawn } from "node:child_process";
import { type EmbeddedMetadata, type MediaInfo, mediaInfo, timecodePattern } from "@hekate/shared";
import { readWaveChunks, tagsOf } from "./metadata.ts";

/**
 * Running ffmpeg and ffprobe on untrusted uploads.
 *
 * A crafted file can be a playlist (HLS, concat, ffconcat) that points ffmpeg at
 * other local files or at the network. Every call therefore:
 * - allows only the `file` protocol, and
 * - allows only real media demuxers (no playlists, concat, image sequences or
 *   device inputs),
 * and runs with a time limit, an abort signal and capped output.
 */

/** Demuxers allowed to open uploads. Audio first, then video, then images. */
export const ALLOWED_DEMUXERS = [
  // Audio
  "wav",
  "w64",
  "aiff",
  "caf",
  "flac",
  "mp3",
  "ogg",
  "aac",
  "ac3",
  "eac3",
  "dts",
  "truehd",
  "mlp",
  "wv",
  "ape",
  "tta",
  "dsf",
  // Containers for audio and video
  "mov,mp4,m4a,3gp,3g2,mj2",
  "matroska,webm",
  "mxf",
  "avi",
  "mpegts",
  "mpeg",
  "asf",
  "flv",
  "gxf",
  // Raw video elementary streams
  "h264",
  "hevc",
  "m4v",
  "dnxhd",
] as const;

const BASE_ARGS = ["-hide_banner", "-protocol_whitelist", "file"];
const formatWhitelist = ALLOWED_DEMUXERS.join(",");

/** A media tool could not do its work: missing, timed out, cancelled, overloaded. Worth retrying. */
export class MediaToolError extends Error {
  override name = "MediaToolError";
}

/** The tool ran and rejected the input: the file is not readable media. Retrying will not help. */
export class InvalidMediaError extends MediaToolError {
  override name = "InvalidMediaError";
}

export interface RunOptions {
  /** Kill the process after this long. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Maximum stdout kept, in bytes; more fails the run. */
  maxOutput?: number;
  /**
   * Receive standard output as it arrives instead of keeping it (`maxOutput` then does not
   * apply). The process waits while the handler runs; a handler that throws stops the run.
   */
  onStdout?: (chunk: Buffer) => void;
  /** Variables added to the process's environment for this tool alone. */
  env?: Record<string, string>;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

/** Run a media tool without a shell. Arguments are passed as a list, never interpolated. */
export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { timeoutMs = 10 * 60_000, signal, maxOutput = 4 * 1024 * 1024, env } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new MediaToolError(`${command} was cancelled before it started`));
      return;
    }
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    const stdout: Buffer[] = [];
    let stdoutSize = 0;
    let stderr = "";
    let failure: Error | undefined;

    const stop = (error: Error) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () => stop(new MediaToolError(`${command} timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    const onAbort = () => stop(new MediaToolError(`${command} was cancelled`));
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      if (options.onStdout) {
        try {
          options.onStdout(chunk);
        } catch (error) {
          stop(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      stdoutSize += chunk.length;
      if (stdoutSize > maxOutput) stop(new MediaToolError(`${command} produced too much output`));
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      // Keep the end of stderr: that is where ffmpeg explains a failure.
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    child.on("error", (error) =>
      stop(new MediaToolError(`${command} could not run: ${error.message}`)),
    );
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (failure) reject(failure);
      else if (code !== 0) {
        const reason = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 500);
        // Terminated by a signal (code null) is operational; a non-zero exit means the tool rejected the input.
        reject(
          code === null
            ? new MediaToolError(`${command} was killed: ${reason}`)
            : new InvalidMediaError(`${command} exited with ${code}: ${reason}`),
        );
      } else resolve({ stdout: Buffer.concat(stdout).toString(), stderr });
    });
  });
}

/** Arguments that restrict how an untrusted input may be opened. Put them before `-i`. */
export function safeInputArgs(tool: "ffmpeg" | "ffprobe"): string[] {
  // ffmpeg must never wait on standard input; ffprobe has no such option.
  const stdin = tool === "ffmpeg" ? ["-nostdin"] : [];
  return [...BASE_ARGS, ...stdin, "-format_whitelist", formatWhitelist];
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  channels?: number;
  channel_layout?: string;
  sample_rate?: string;
  bits_per_raw_sample?: string;
  bits_per_sample?: number;
  sample_fmt?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  pix_fmt?: string;
  disposition?: { attached_pic?: number };
  tags?: Record<string, string>;
  duration?: string;
}

interface ProbeOutput {
  format?: {
    format_name?: string;
    duration?: string;
    bit_rate?: string;
    tags?: Record<string, string>;
  };
  streams?: ProbeStream[];
}

const ratio = (value: string | undefined) => {
  if (!value) return undefined;
  const [n, d] = value.split("/").map(Number);
  if (!n || !d || !Number.isFinite(n / d)) return undefined;
  return Math.round((n / d) * 1000) / 1000;
};

const positiveInt = (value: string | number | undefined) => {
  const n = typeof value === "string" ? Number.parseInt(value, 10) : value;
  return n && Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
};

/** Bit depth from ffprobe, which reports it in different places per codec. */
function bitDepth(stream: ProbeStream): number | undefined {
  const raw = positiveInt(stream.bits_per_raw_sample);
  if (raw) return raw;
  if (stream.codec_name?.startsWith("pcm_")) return positiveInt(stream.bits_per_sample);
  return undefined;
}

/**
 * Where a video's timecode starts (#146): its own stream's, a timecode track's (QuickTime's
 * tmcd, a data stream), or the container's, whichever says first and can be read.
 */
function startTimecode(output: ProbeOutput, video: ProbeStream): string | undefined {
  const tracks = (output.streams ?? []).filter((s) => s.codec_type === "data");
  return [video.tags, ...tracks.map((t) => t.tags), output.format?.tags]
    .map((tags) => tags?.timecode?.trim())
    .find((written) => written !== undefined && timecodePattern.test(written));
}

/**
 * Turn ffprobe's JSON into Hekate's media info, with the bext and iXML chunks a wave file
 * holds where they were read. Exported for tests.
 */
export function parseProbe(
  output: ProbeOutput,
  wave: Pick<EmbeddedMetadata, "bext" | "ixml" | "adm"> = {},
): MediaInfo {
  const streams = output.streams ?? [];
  const audio = streams.find((s) => s.codec_type === "audio");
  // Cover art in audio files appears as a video stream; it is not video.
  const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const artwork = streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic);
  const duration = Number.parseFloat(output.format?.duration ?? "");
  const info: MediaInfo = {};
  if (output.format?.format_name) info.format = output.format.format_name;
  if (Number.isFinite(duration) && duration >= 0) info.duration = duration;
  const bitRate = positiveInt(output.format?.bit_rate);
  if (bitRate) info.bitRate = bitRate;
  const channels = positiveInt(audio?.channels);
  const sampleRate = positiveInt(audio?.sample_rate);
  if (audio?.codec_name && channels && sampleRate) {
    info.audio = { codec: audio.codec_name, channels, sampleRate };
    if (audio.channel_layout) info.audio.channelLayout = audio.channel_layout;
    const depth = bitDepth(audio);
    if (depth) info.audio.bitDepth = depth;
    const length = Number.parseFloat(audio.duration ?? "");
    if (Number.isFinite(length) && length >= 0) info.audio.duration = length;
  }
  if (video?.codec_name && video.width && video.height) {
    info.video = { codec: video.codec_name, width: video.width, height: video.height };
    const rate =
      video.avg_frame_rate && video.avg_frame_rate !== "0/0"
        ? video.avg_frame_rate
        : video.r_frame_rate;
    const fps = ratio(rate);
    if (fps) info.video.fps = fps;
    if (rate && fps) info.video.frameRate = rate;
    if (video.pix_fmt) info.video.pixelFormat = video.pix_fmt;
    const start = startTimecode(output, video);
    if (start) info.video.timecode = start;
  }
  if (info.audio || info.video) {
    const tags = tagsOf(output.format?.tags, audio?.tags, video?.tags);
    // ffprobe reads a wave file's origination date as its date; it is shown with the bext.
    if (wave.bext?.originationDate && tags.date === wave.bext.originationDate) delete tags.date;
    const metadata: EmbeddedMetadata = { tags };
    if (wave.bext) metadata.bext = wave.bext;
    if (wave.ixml) metadata.ixml = wave.ixml;
    // Only a wave file carries ADM here; anything else has been read and has none (#74).
    metadata.adm = wave.adm ?? null;
    if (artwork?.codec_name && artwork.width && artwork.height)
      metadata.artwork = {
        codec: artwork.codec_name,
        width: artwork.width,
        height: artwork.height,
      };
    info.metadata = metadata;
  }
  return mediaInfo.parse(info);
}

/** Measure a local file with ffprobe. */
export async function probe(path: string, options: RunOptions = {}): Promise<MediaInfo> {
  const { stdout } = await run(
    "ffprobe",
    [
      ...safeInputArgs("ffprobe"),
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      // `file:` keeps a name beginning with a dash or a colon from being read as an option or protocol.
      `file:${path}`,
    ],
    { timeoutMs: 60_000, ...options },
  );
  let parsed: ProbeOutput;
  try {
    parsed = JSON.parse(stdout) as ProbeOutput;
  } catch {
    throw new MediaToolError("ffprobe returned output that is not JSON");
  }
  // A wave file's bext, iXML and ADM are read from the file; metadata never stops a probe.
  const wave = parsed.format?.format_name?.split(",").includes("wav")
    ? await readWaveChunks(path).catch(() => ({}))
    : {};
  return parseProbe(parsed, wave);
}

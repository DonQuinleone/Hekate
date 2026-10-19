import { createCipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { losslessParts, type MediaInfo, STREAM_CHANNELS, type StreamPart } from "@hekate/shared";
import { run, safeInputArgs } from "./ffmpeg.ts";

/**
 * Playable proxies for protected streaming (docs/security.md): HLS with fragmented
 * MP4 segments. ffmpeg packages them in the job's private workspace; Hekate then
 * encrypts every segment, and the initialisation section, with AES-128 (the HLS
 * method) under the rendition's content key, with a fresh random IV each.
 */

export interface RenditionPlan {
  name: string;
  codecs: string;
  bandwidth: number;
  width?: number;
  height?: number;
  segmentSeconds: number;
  /** ffmpeg arguments between the input and the HLS output options. */
  args: string[];
}

const AUDIO_CODEC = "mp4a.40.2";

/** Source codecs carried into HLS as they are, keyed by ffprobe's codec name. */
const DOLBY_PASSTHROUGH: Record<string, { codecs: string; bandwidth: number }> = {
  eac3: { codecs: "ec-3", bandwidth: 768_000 },
  ac3: { codecs: "ac-3", bandwidth: 640_000 },
};

/** H.264 levels as [level × 10, max macroblocks per frame, max macroblocks per second] (Annex A). */
const H264_LEVELS = [
  [30, 1620, 40_500],
  [31, 3600, 108_000],
  [32, 5120, 216_000],
  [40, 8192, 245_760],
  [42, 8704, 522_240],
  [50, 22_080, 589_824],
  [51, 36_864, 983_040],
  [52, 36_864, 2_073_600],
] as const;

/**
 * The lowest H.264 level that holds a frame size and rate, as level × 10 (42 for 4.2), so
 * the playlist's CODECS describes what the encoder is told to produce.
 */
export function h264Level(width: number, height: number, fps: number): number {
  const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  const found = H264_LEVELS.find(
    ([, frame, rate]) => macroblocks <= frame && macroblocks * fps <= rate,
  );
  return found ? found[0] : 52;
}

/** Even dimensions for a target height, keeping the aspect ratio. */
function scaled(info: NonNullable<MediaInfo["video"]>, height: number) {
  const width = Math.round((info.width * height) / info.height / 2) * 2;
  return { width, height };
}

/** FLAC's own layout for each channel count, so a part's channels decode in the order given. */
const FLAC_LAYOUTS = ["mono", "stereo", "3.0", "quad", "5.0", "5.1", "6.1", "7.1"];

/** The filter that takes one part's channels from the recording, by index. */
export function partFilter(part: StreamPart): string {
  const routes = Array.from({ length: part.count }, (_, i) => `c${i}=c${part.from + i}`);
  return `pan=${FLAC_LAYOUTS[part.count - 1]}|${routes.join("|")}`;
}

export function planRenditions(kind: "audio" | "video", info: MediaInfo): RenditionPlan[] {
  const audio = info.audio;
  // AAC at the source rate when it is a common one, otherwise 48 kHz; stereo at most.
  const audioArgs = (bitrate: string) =>
    audio
      ? [
          "-c:a",
          "aac",
          "-b:a",
          bitrate,
          "-ac",
          String(Math.min(audio.channels, 2)),
          "-ar",
          audio.sampleRate === 44100 ? "44100" : "48000",
        ]
      : [];

  if (kind === "audio" || !info.video) {
    if (!audio) return [];
    const depth = audio.bitDepth ?? 16;
    const dolby = DOLBY_PASSTHROUGH[audio.codec];
    return [
      // Dolby Digital and Dolby Digital Plus pass through untouched, so surround and
      // Atmos (E-AC-3 with joint object coding) reach players that can decode them.
      ...(dolby
        ? [
            {
              name: audio.codec,
              codecs: dolby.codecs,
              bandwidth: info.bitRate ?? dolby.bandwidth,
              segmentSeconds: 6,
              args: ["-map", "0:a:0", "-vn", "-c:a", "copy"],
            },
          ]
        : []),
      {
        name: "aac-256",
        codecs: AUDIO_CODEC,
        bandwidth: 300_000,
        segmentSeconds: 6,
        args: ["-map", "0:a:0", "-vn", ...audioArgs("256k")],
      },
      // Lossless, for listening that matters: the source's rate, channels and bit depth. A
      // browser plays eight channels from one stream at most, so a wider layout travels in
      // parts of eight, in its own order, which the player hears together (#74).
      ...losslessParts(audio.channels).map((part) => ({
        name: part.name,
        codecs: "fLaC",
        bandwidth: audio.sampleRate * part.count * Math.min(depth, 32),
        segmentSeconds: 6,
        args: [
          "-map",
          "0:a:0",
          "-vn",
          ...(audio.channels > STREAM_CHANNELS ? ["-af", partFilter(part)] : []),
          "-c:a",
          "flac",
          "-sample_fmt",
          depth > 16 ? "s32" : "s16",
          "-ac",
          String(part.count),
        ],
      })),
    ];
  }

  const video = info.video;
  const ladder = [
    { height: 1080, rate: 6_000_000 },
    { height: 720, rate: 3_000_000 },
    { height: 480, rate: 1_200_000 },
  ];
  const fps = video.fps ?? 30;
  // Every rung at or below the source, and always at least the smallest.
  const rungs = ladder.filter((r) => r.height <= video.height);
  if (rungs.length === 0)
    rungs.push({
      ...(ladder.at(-1) as (typeof ladder)[number]),
      height: video.height - (video.height % 2),
    });
  return rungs.slice(0, 2).map((rung) => {
    const size = scaled(video, rung.height);
    const keyframes = 2;
    const level = h264Level(size.width, size.height, fps);
    // High profile (0x64), no constraint flags, then the level.
    const profile = `avc1.6400${level.toString(16).padStart(2, "0")}`;
    return {
      name: `${rung.height}p`,
      codecs: audio ? `${profile},${AUDIO_CODEC}` : profile,
      bandwidth: rung.rate + (audio ? 200_000 : 0),
      width: size.width,
      height: size.height,
      segmentSeconds: 4,
      args: [
        "-map",
        "0:v:0",
        ...(audio ? ["-map", "0:a:0"] : []),
        "-c:v",
        "libx264",
        "-profile:v",
        "high",
        "-level:v",
        (level / 10).toFixed(1),
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-maxrate",
        String(rung.rate),
        "-bufsize",
        String(rung.rate * 2),
        "-pix_fmt",
        "yuv420p",
        "-vf",
        `scale=${size.width}:${size.height}`,
        "-force_key_frames",
        `expr:gte(t,n_forced*${keyframes})`,
        "-sc_threshold",
        "0",
        ...audioArgs("192k"),
      ],
    };
  });
}

export interface StoredSegment {
  duration: number;
  blobId: string;
  /** Hex. */
  iv: string;
}

export interface PackagedRendition {
  plan: RenditionPlan;
  initBlobId: string;
  initIv: string;
  segments: StoredSegment[];
  targetDuration: number;
}

/** Stores encrypted bytes and returns the blob id. */
export type StoreBytes = (bytes: Buffer, contentType: string) => Promise<string>;

/** HLS AES-128: the whole segment in AES-128-CBC with PKCS#7 padding. */
export function encryptSegment(key: Buffer, iv: Buffer, plain: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

/**
 * Whether an MP4 fragment carries any media: a non-empty `mdat` box. ffmpeg can end a
 * playlist with an empty fragment, which players reject, so those are left out.
 */
export function hasMedia(fragment: Buffer): boolean {
  let offset = 0;
  while (offset + 8 <= fragment.length) {
    let size = fragment.readUInt32BE(offset);
    const type = fragment.toString("latin1", offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > fragment.length) return false;
      size = Number(fragment.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = fragment.length - offset;
    }
    if (size < header) return false;
    if (type === "mdat") return size > header;
    offset += size;
  }
  return false;
}

/** Read ffmpeg's media playlist: segment files and their durations, in order. */
export function parsePlaylist(text: string): { file: string; duration: number }[] {
  const segments: { file: string; duration: number }[] = [];
  let duration: number | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#EXTINF:")) duration = Number.parseFloat(line.slice(8));
    else if (line && !line.startsWith("#")) {
      if (duration === undefined || !Number.isFinite(duration))
        throw new Error(`No duration for ${line}`);
      // ffmpeg names files itself; anything with a path in it is not ours.
      if (!/^seg\d{5}\.m4s$/.test(line)) throw new Error(`Unexpected segment name ${line}`);
      segments.push({ file: line, duration });
      duration = undefined;
    }
  }
  return segments;
}

/**
 * Package one rendition in `dir`, then encrypt and store its initialisation section and
 * segments one at a time, so memory use stays at one segment however long the file.
 */
export async function packageRendition(
  input: string,
  dir: string,
  plan: RenditionPlan,
  contentKey: Buffer,
  store: StoreBytes,
  signal: AbortSignal,
): Promise<PackagedRendition> {
  const out = join(dir, plan.name);
  await mkdir(out, { recursive: true, mode: 0o700 });
  await run(
    "ffmpeg",
    [
      ...safeInputArgs("ffmpeg"),
      "-v",
      "error",
      "-i",
      `file:${input}`,
      ...plan.args,
      "-f",
      "hls",
      "-hls_time",
      String(plan.segmentSeconds),
      "-hls_playlist_type",
      "vod",
      "-hls_segment_type",
      "fmp4",
      "-hls_fmp4_init_filename",
      "init.mp4",
      "-hls_segment_filename",
      join(out, "seg%05d.m4s"),
      join(out, "index.m3u8"),
    ],
    { signal, timeoutMs: 60 * 60_000 },
  );
  const listed = parsePlaylist(await readFile(join(out, "index.m3u8"), "utf8"));
  if (listed.length === 0) throw new Error(`ffmpeg produced no segments for ${plan.name}`);
  const contentType = plan.height ? "video/mp4" : "audio/mp4";

  const seal = async (file: string, plain: Buffer) => {
    const iv = randomBytes(16);
    const blobId = await store(encryptSegment(contentKey, iv, plain), contentType);
    // The plaintext segment is no longer needed; free the workspace as we go.
    await rm(join(out, file), { force: true });
    return { blobId, iv: iv.toString("hex") };
  };

  const init = await seal("init.mp4", await readFile(join(out, "init.mp4")));
  const segments: StoredSegment[] = [];
  for (const segment of listed) {
    if (signal.aborted) throw new Error("Packaging cancelled");
    const plain = await readFile(join(out, segment.file));
    if (!hasMedia(plain)) continue;
    segments.push({ duration: segment.duration, ...(await seal(segment.file, plain)) });
  }
  if (segments.length === 0)
    throw new Error(`ffmpeg produced only empty segments for ${plan.name}`);
  const targetDuration = Math.ceil(Math.max(...segments.map((s) => s.duration)));
  return { plan, initBlobId: init.blobId, initIv: init.iv, segments, targetDuration };
}

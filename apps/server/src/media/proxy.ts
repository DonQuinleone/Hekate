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
  /** Arguments to encode it with instead, should these fail: software for a hardware encode. */
  fallback?: string[];
}

/**
 * What an instance encodes video into (#148, decision 142): its ladder, how many rungs one
 * file gets, a royalty-free encoding beside H.264, and a GPU to encode H.264 on.
 */
export interface VideoLadder {
  /** Each rung's height and bitrate in bit/s, highest first. */
  rungs: readonly { height: number; rate: number }[];
  /** The most rungs one file is given: the highest at or below its own height. */
  most: number;
  /** AV1 or VP9 at each rung, with Opus, for browsers that play it; or none. */
  royaltyFree: "av1" | "vp9" | null;
  /** A VAAPI render node (/dev/dri/renderD128) to encode H.264 on; software if it fails. */
  hardware: string | null;
}

export const defaultVideoLadder: VideoLadder = {
  rungs: [
    { height: 1080, rate: 6_000_000 },
    { height: 720, rate: 3_000_000 },
    { height: 480, rate: 1_200_000 },
  ],
  most: 2,
  royaltyFree: "av1",
  hardware: null,
};

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

/**
 * AV1 levels as [seq_level_idx, max picture size, max display rate in samples a second]
 * (AV1 specification, Annex A).
 */
const AV1_LEVELS = [
  [0, 147_456, 4_423_680],
  [1, 278_784, 8_363_520],
  [4, 665_856, 19_975_680],
  [5, 1_065_024, 31_950_720],
  [8, 2_359_296, 70_778_880],
  [9, 2_359_296, 141_557_760],
  [12, 8_912_896, 267_386_880],
  [13, 8_912_896, 534_773_760],
  [14, 8_912_896, 1_069_547_520],
  [16, 35_651_584, 1_069_547_520],
] as const;

/** VP9 levels as [level × 10, max picture size, max sample rate] (the VP9 bitstream levels). */
const VP9_LEVELS = [
  [10, 36_864, 829_440],
  [11, 73_728, 2_764_800],
  [20, 122_880, 4_608_000],
  [21, 245_760, 9_216_000],
  [30, 552_960, 20_736_000],
  [31, 983_040, 36_864_000],
  [40, 2_228_224, 83_558_400],
  [41, 2_228_224, 160_432_128],
  [50, 8_912_896, 311_951_360],
  [51, 8_912_896, 588_251_136],
  [52, 8_912_896, 1_176_502_272],
  [60, 35_651_584, 1_176_502_272],
] as const;

const lowest = (
  levels: readonly (readonly [number, number, number])[],
  width: number,
  height: number,
  fps: number,
) => {
  const samples = width * height;
  const found = levels.find(([, size, rate]) => samples <= size && samples * fps <= rate);
  return found ? found[0] : (levels.at(-1)?.[0] ?? 0);
};

/**
 * The CODECS of a royalty-free rendition: Main profile, 8-bit, at the lowest level that holds
 * its frame size and rate, so the playlist describes what the encoder produces.
 */
export function royaltyFreeCodecs(
  codec: "av1" | "vp9",
  width: number,
  height: number,
  fps: number,
): string {
  if (codec === "av1")
    return `av01.0.${String(lowest(AV1_LEVELS, width, height, fps)).padStart(2, "0")}M.08`;
  return `vp09.00.${lowest(VP9_LEVELS, width, height, fps)}.08`;
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

export function planRenditions(
  kind: "audio" | "video",
  info: MediaInfo,
  ladder: VideoLadder = defaultVideoLadder,
): RenditionPlan[] {
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
  const fps = video.fps ?? 30;
  // The highest rungs at or below the source, and always at least the smallest.
  const rungs = ladder.rungs.filter((r) => r.height <= video.height).slice(0, ladder.most);
  if (rungs.length === 0) {
    const smallest = ladder.rungs.at(-1) ?? { height: 480, rate: 1_200_000 };
    rungs.push({ ...smallest, height: video.height - (video.height % 2) });
  }
  // A keyframe every two seconds, so every four-second segment starts on one.
  const keyframes = 2;
  const gop = String(Math.max(1, Math.round(fps * keyframes)));
  const opusArgs = audio
    ? [
        "-c:a",
        "libopus",
        "-b:a",
        "160k",
        "-ac",
        String(Math.min(audio.channels, 2)),
        "-ar",
        "48000",
      ]
    : [];
  const streams = ["-map", "0:v:0", ...(audio ? ["-map", "0:a:0"] : [])];
  return rungs.flatMap((rung): RenditionPlan[] => {
    const size = scaled(video, rung.height);
    const level = h264Level(size.width, size.height, fps);
    // High profile (0x64), no constraint flags, then the level.
    const profile = `avc1.6400${level.toString(16).padStart(2, "0")}`;
    const software = [
      ...streams,
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
    ];
    // On the GPU, where the instance has one: the same picture, scaled and encoded there.
    const hardware = ladder.hardware && [
      "-init_hw_device",
      `vaapi=gpu:${ladder.hardware}`,
      "-filter_hw_device",
      "gpu",
      ...streams,
      "-vf",
      `format=nv12,hwupload,scale_vaapi=w=${size.width}:h=${size.height}`,
      "-c:v",
      "h264_vaapi",
      "-profile:v",
      "high",
      "-level:v",
      (level / 10).toFixed(1),
      "-rc_mode",
      "VBR",
      "-b:v",
      String(Math.round(rung.rate * 0.8)),
      "-maxrate",
      String(rung.rate),
      "-g",
      gop,
      ...audioArgs("192k"),
    ];
    const h264: RenditionPlan = {
      name: `${rung.height}p`,
      codecs: audio ? `${profile},${AUDIO_CODEC}` : profile,
      bandwidth: rung.rate + (audio ? 200_000 : 0),
      width: size.width,
      height: size.height,
      segmentSeconds: 4,
      args: hardware || software,
      ...(hardware ? { fallback: software } : {}),
    };
    const free = ladder.royaltyFree;
    if (!free) return [h264];
    // Smaller for the same picture: two thirds of H.264's rate is enough for AV1 and VP9 alike.
    const rate = Math.round((rung.rate * 2) / 3);
    const codecs = royaltyFreeCodecs(free, size.width, size.height, fps);
    const encoder =
      free === "av1"
        ? [
            "-c:v",
            "libsvtav1",
            "-preset",
            "12",
            "-crf",
            "34",
            "-svtav1-params",
            `mbr=${Math.round(rate / 1000)}`,
          ]
        : [
            "-c:v",
            "libvpx-vp9",
            "-deadline",
            "realtime",
            "-cpu-used",
            "8",
            "-row-mt",
            "1",
            "-b:v",
            String(rate),
            "-maxrate",
            String(rung.rate),
          ];
    return [
      h264,
      {
        name: `${rung.height}p-${free}`,
        codecs: audio ? `${codecs},opus` : codecs,
        bandwidth: rate + (audio ? 170_000 : 0),
        width: size.width,
        height: size.height,
        segmentSeconds: 4,
        args: [
          ...streams,
          ...encoder,
          "-g",
          gop,
          "-pix_fmt",
          "yuv420p",
          "-vf",
          `scale=${size.width}:${size.height}`,
          ...opusArgs,
        ],
      },
    ];
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
  const encode = (args: string[]) =>
    run(
      "ffmpeg",
      [
        ...safeInputArgs("ffmpeg"),
        "-v",
        "error",
        "-i",
        `file:${input}`,
        ...args,
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
  try {
    await encode(plan.args);
  } catch (error) {
    // A GPU that is missing, busy or refuses this picture: the same rendition in software.
    if (!plan.fallback || signal.aborted) throw error;
    console.warn(`Hardware encoding of ${plan.name} failed; encoding in software:`, error);
    await rm(out, { recursive: true, force: true });
    await mkdir(out, { recursive: true, mode: 0o700 });
    await encode(plan.fallback);
  }
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

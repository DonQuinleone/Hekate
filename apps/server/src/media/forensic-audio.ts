import { closeSync, createReadStream, openSync, writeSync } from "node:fs";
import { open } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import type { MediaInfo } from "@hekate/shared";
import { MediaToolError, run, safeInputArgs } from "./ffmpeg.ts";
import {
  type Candidate,
  DEFAULT_STRENGTH,
  type Detection,
  detectMarks,
  MARK_RATE,
  MarkEmbedder,
  markCode,
  markPattern,
} from "./forensic.ts";

/**
 * Marking a recording's download, and reading a suspected leak, with ffmpeg on either side of
 * the signal processing in `forensic.ts` (#32, decision 239).
 *
 * Marking takes two passes. The first decodes the recording at the analysis rate and makes
 * a mark for each channel from that channel's own sound, all with the same signs
 * (`writeMark`, on a thread of its own), written to the private workspace as a small
 * floating-point WAV file. The second decodes the recording again at its own rate, adds each
 * channel's mark (resampled by ffmpeg) to it, and encodes the result (`mixArgs`). The mark
 * scales each channel's spectrum, and scaling is linear, so any mix of the channels (a
 * stereo or mono fold-down, one channel alone) carries the same mark. Nothing else of the
 * recording changes: where the mark is silent, the samples are the original's.
 */

/** Audio kept in its own format when marked; everything else becomes FLAC. */
const PCM = new Set([
  "pcm_s16le",
  "pcm_s24le",
  "pcm_s32le",
  "pcm_f32le",
  "pcm_f64le",
  "pcm_s16be",
  "pcm_s24be",
  "pcm_s32be",
]);

/** What a marked download of a recording is made as, and how it is described. */
export interface MarkedAudioFormat {
  codecArgs: string[];
  /** The source's own tags go with an original, as they did unmarked; never with a proxy. */
  keepsTags: boolean;
  muxer: string;
  extension: string;
  contentType: string;
  /** For the download dialog: what the file will be. */
  detail: string;
}

const kHz = (rate: number) => `${Number((rate / 1000).toFixed(1))} kHz`;

/**
 * The format a marked recording is sent in. The original keeps its own where it is PCM in
 * WAV or AIFF, or FLAC; anything else (lossy or not) becomes FLAC, so the decoded sound and
 * its mark lose nothing more. The proxy is AAC at 256 kb/s, as the stream's is.
 */
export function markedAudioFormat(
  info: MediaInfo | null,
  kind: "proxy" | "original",
): MarkedAudioFormat {
  const audio = info?.audio;
  if (kind === "proxy") {
    const channels = Math.min(audio?.channels ?? 2, 2);
    return {
      codecArgs: [
        ...["-c:a", "aac", "-b:a", "256k", "-ac", String(channels)],
        ...["-ar", audio?.sampleRate === 44100 ? "44100" : "48000"],
        ...["-movflags", "+faststart"],
      ],
      keepsTags: false,
      muxer: "mp4",
      extension: "m4a",
      contentType: "audio/mp4",
      detail: "AAC 256 kb/s, with an inaudible mark",
    };
  }
  const codec = audio?.codec ?? "";
  const container = info?.format ?? "";
  const rate = audio ? `, ${kHz(audio.sampleRate)}` : "";
  const depth = audio?.bitDepth;
  if (PCM.has(codec) && (container === "wav" || container === "w64")) {
    return {
      codecArgs: ["-c:a", codec, "-rf64", "auto"],
      keepsTags: true,
      muxer: "wav",
      extension: "wav",
      contentType: "audio/wav",
      detail: `WAV${depth ? `, ${depth}-bit` : ""}${rate}, as uploaded but for an inaudible mark`,
    };
  }
  if (PCM.has(codec) && container === "aiff") {
    return {
      codecArgs: ["-c:a", codec.replace(/le$/, "be")],
      keepsTags: true,
      muxer: "aiff",
      extension: "aiff",
      contentType: "audio/aiff",
      detail: `AIFF${depth ? `, ${depth}-bit` : ""}${rate}, as uploaded but for an inaudible mark`,
    };
  }
  // Sixteen bits where the source had no more; 24 otherwise, and for lossy sources.
  const sixteen = depth !== undefined && depth <= 16;
  const flac = [
    ...["-c:a", "flac", "-sample_fmt", sixteen ? "s16" : "s32"],
    ...(sixteen ? [] : ["-bits_per_raw_sample", "24"]),
  ];
  return {
    codecArgs: flac,
    keepsTags: true,
    muxer: "flac",
    extension: "flac",
    contentType: "audio/flac",
    detail:
      codec === "flac"
        ? `FLAC, ${sixteen ? 16 : 24}-bit${rate}, as uploaded but for an inaudible mark`
        : `FLAC, ${sixteen ? 16 : 24}-bit${rate}, decoded from ${codecName(codec)} and marked inaudibly`,
  };
}

/** A codec as people name it. */
const codecName = (codec: string) =>
  ({ mp3: "MP3", aac: "AAC", opus: "Opus", vorbis: "Vorbis", alac: "ALAC", ac3: "AC-3" })[codec] ??
  (codec ? codec.toUpperCase() : "the original");

/** Where a WAV file's samples are: its data chunk's payload, and the file's whole size. */
export async function waveData(
  path: string,
): Promise<{ offset: number; size: number; fileSize: number } | null> {
  const handle = await open(path, "r");
  try {
    const { size: fileSize } = await handle.stat();
    const read = async (position: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead);
    };
    const head = await read(0, 12);
    if (
      head.length < 12 ||
      !["RIFF", "RF64", "BW64"].includes(head.subarray(0, 4).toString("latin1")) ||
      head.subarray(8, 12).toString("latin1") !== "WAVE"
    )
      return null;
    // RF64 and BW64 keep the data chunk's real size in ds64, as it may not fit in 32 bits.
    let large: number | undefined;
    let position = 12;
    for (let n = 0; n < 1000 && position + 8 <= fileSize; n += 1) {
      const header = await read(position, 8);
      if (header.length < 8) return null;
      const id = header.subarray(0, 4).toString("latin1");
      let length = header.readUInt32LE(4);
      if (id === "ds64") {
        const ds64 = await read(position + 8, 16);
        if (ds64.length === 16) large = Number(ds64.readBigUInt64LE(8));
      }
      if (id === "data") {
        if (length === 0xffffffff && large !== undefined) length = large;
        return position + 8 + length <= fileSize
          ? { offset: position + 8, size: length, fileSize }
          : null;
      }
      position += 8 + length + (length % 2);
    }
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * A marked WAV original: the original file, chunk for chunk (its Broadcast Wave, iXML and ADM
 * descriptions among them), with the marked samples in place of its own. Null where the two
 * do not hold samples of the same size, when the marked file as ffmpeg wrote it is sent.
 */
export async function splicedWave(
  original: string,
  marked: string,
): Promise<AsyncGenerator<Buffer> | null> {
  const [from, into] = await Promise.all([waveData(original), waveData(marked)]);
  if (!from || !into || from.size !== into.size || from.size === 0) return null;
  const parts: [string, number, number][] = [
    [original, 0, from.offset],
    [marked, into.offset, into.offset + into.size],
    [original, from.offset + from.size, from.fileSize],
  ];
  async function* pieces() {
    for (const [path, start, end] of parts)
      if (end > start)
        for await (const chunk of createReadStream(path, { start, end: end - 1 }))
          yield chunk as Buffer;
  }
  return pieces();
}

/** ffmpeg's arguments for the first pass: every channel at the analysis rate. */
export function analysisArgs(input: string): string[] {
  return [
    ...safeInputArgs("ffmpeg"),
    ...["-v", "error", "-i", `file:${input}`, "-map", "0:a:0", "-vn"],
    ...["-ar", String(MARK_RATE), "-f", "f32le", "-acodec", "pcm_f32le", "pipe:1"],
  ];
}

/**
 * ffmpeg's arguments for the second pass: the recording at its own rate with each channel's
 * mark added to it, in `format`, written to `output`. The mark is padded with silence, so the
 * recording keeps its exact length.
 */
export function mixArgs(
  input: string,
  markPath: string,
  options: { sampleRate: number; channels: number; layout?: string; format: MarkedAudioFormat },
  output: string,
): string[] {
  const { sampleRate, channels, format } = options;
  const layout = options.layout ?? defaultLayout(channels);
  const routes = Array.from({ length: channels }, (_, i) => `c${i}=c${i}+c${channels + i}`);
  const graph = [
    `[0:a:0]aformat=sample_fmts=dbl:channel_layouts=${layout}[sound]`,
    `[1:a]aresample=${sampleRate},aformat=sample_fmts=dbl:channel_layouts=${defaultLayout(channels)},apad[mark]`,
    `[sound][mark]amerge=inputs=2,pan=${layout}|${routes.join("|")}[out]`,
  ].join(";");
  return [
    ...safeInputArgs("ffmpeg"),
    ...["-v", "error", "-i", `file:${input}`],
    // The mark is ours, a WAV file; opened as narrowly as the recording.
    ...["-protocol_whitelist", "file", "-format_whitelist", "wav", "-i", `file:${markPath}`],
    ...["-filter_complex", graph, "-map", "[out]"],
    // An original's tags go with it, as they did unmarked; a proxy's description is its own.
    ...["-map_metadata", format.keepsTags ? "0" : "-1"],
    ...format.codecArgs,
    ...["-f", format.muxer, "-y", `file:${output}`],
  ];
}

/**
 * The layout to give ffmpeg for a recording: the one its probe named, where ffmpeg can take
 * it back as written (a name such as "5.1(side)"); otherwise the usual one for its channels.
 */
export function ffmpegLayout(named: string | undefined, channels: number): string {
  return named && /^[\w.()+-]+$/.test(named) && !/^\d+$/.test(named)
    ? named
    : defaultLayout(channels);
}

/** ffmpeg's own layout for a count of channels where the file names none. */
function defaultLayout(channels: number): string {
  return (
    ["mono", "stereo", "2.1", "quad", "5.0", "5.1", "6.1", "7.1"][channels - 1] ?? `${channels}c`
  );
}

/** A WAV header for `frames` of 32-bit float samples at the analysis rate. */
export function floatWavHeader(frames: number, channels: number): Buffer {
  const bytes = frames * channels * 4;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + bytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(MARK_RATE, 24);
  header.writeUInt32LE(MARK_RATE * channels * 4, 28);
  header.writeUInt16LE(channels * 4, 32);
  header.writeUInt16LE(32, 34);
  header.write("data", 36);
  header.writeUInt32LE(bytes, 40);
  return header;
}

/**
 * The first pass: decodes every channel at the analysis rate and writes each one's mark to
 * `output`, as it goes, in constant memory. Runs where it is called; `markInThread` runs it
 * away from the API's thread.
 */
export async function writeMark(
  input: string,
  output: string,
  options: {
    key: Buffer;
    markId: string;
    channels: number;
    strength?: number;
    signal?: AbortSignal;
    timeoutMs: number;
  },
): Promise<{ samples: number }> {
  const width = options.channels;
  const pattern = markPattern(options.key);
  const code = markCode(options.key, options.markId);
  const embedders = Array.from(
    { length: width },
    () => new MarkEmbedder(pattern, code, options.strength ?? DEFAULT_STRENGTH),
  );
  const fd = openSync(output, "w", 0o600);
  try {
    writeSync(fd, floatWavHeader(0, width));
    let frames = 0;
    let rest = Buffer.alloc(0);
    // Each embedder settles the same samples at the same time, so their marks interleave.
    const write = (marks: Float32Array[]) => {
      const n = (marks[0] as Float32Array).length;
      if (n === 0) return;
      const out = new Float32Array(n * width);
      for (let c = 0; c < width; c++) {
        const mark = marks[c] as Float32Array;
        for (let i = 0; i < n; i++) out[i * width + c] = mark[i] as number;
      }
      writeSync(fd, new Uint8Array(out.buffer));
      frames += n;
    };
    await run("ffmpeg", analysisArgs(input), {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      onStdout: (chunk) => {
        const bytes = rest.length ? Buffer.concat([rest, chunk]) : chunk;
        const count = Math.floor(bytes.length / (4 * width));
        rest = Buffer.from(bytes.subarray(count * 4 * width));
        const sound = Array.from({ length: width }, () => new Float32Array(count));
        for (let i = 0; i < count; i++)
          for (let c = 0; c < width; c++)
            (sound[c] as Float32Array)[i] = bytes.readFloatLE((i * width + c) * 4);
        write(embedders.map((e, c) => e.push(sound[c] as Float32Array)));
      },
    });
    write(embedders.map((e) => e.end()));
    writeSync(fd, floatWavHeader(frames, width), 0, 44, 0);
    return { samples: frames };
  } finally {
    closeSync(fd);
  }
}

/** The sound of a suspected leak at the analysis rate, its channels' mean, up to `seconds`. */
export async function decodeForDetection(
  input: string,
  options: { seconds: number; signal?: AbortSignal; timeoutMs: number },
): Promise<Float32Array> {
  const chunks: Buffer[] = [];
  await run(
    "ffmpeg",
    [
      ...safeInputArgs("ffmpeg"),
      ...["-v", "error", "-i", `file:${input}`, "-map", "0:a:0", "-vn"],
      ...["-t", String(options.seconds), "-ac", "1", "-ar", String(MARK_RATE)],
      ...["-f", "f32le", "-acodec", "pcm_f32le", "pipe:1"],
    ],
    { signal: options.signal, timeoutMs: options.timeoutMs, onStdout: (c) => chunks.push(c) },
  );
  const all = Buffer.concat(chunks);
  const sound = new Float32Array(Math.floor(all.byteLength / 4));
  for (let i = 0; i < sound.length; i++) sound[i] = all.readFloatLE(i * 4);
  return sound;
}

/** The marks to look for under one version of the workspace's key. */
export interface MarkGroup {
  key: Buffer;
  ids: string[];
}

/** Decodes a suspected leak and looks for every mark given. */
export async function traceFile(
  input: string,
  groups: readonly MarkGroup[],
  options: { seconds: number; signal?: AbortSignal; timeoutMs: number },
): Promise<Detection> {
  const sound = await decodeForDetection(input, options);
  return detectMarks(
    sound,
    groups.map(({ key, ids }) => ({
      pattern: markPattern(key),
      candidates: ids.map((id): Candidate => ({ id, code: markCode(key, id) })),
    })),
  );
}

type ThreadTask =
  | {
      task: "mark";
      input: string;
      output: string;
      key: Uint8Array;
      markId: string;
      channels: number;
      timeoutMs: number;
    }
  | {
      task: "trace";
      input: string;
      groups: { key: Uint8Array; ids: string[] }[];
      seconds: number;
      timeoutMs: number;
    };

/** Run a task on the forensic thread; cancelling the signal stops its ffmpeg. */
function inThread<T>(work: ThreadTask, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./forensic-thread.ts", import.meta.url), {
      workerData: work,
    });
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      outcome();
    };
    const onAbort = () => worker.postMessage("abort");
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    worker.on("message", (message: { ok: true; result: T } | { ok: false; message: string }) => {
      finish(() =>
        message.ok ? resolve(message.result) : reject(new MediaToolError(message.message)),
      );
      void worker.terminate();
    });
    worker.on("error", (error) => finish(() => reject(error)));
    worker.on("exit", (code) =>
      finish(() => reject(new MediaToolError(`The forensic thread stopped (${code})`))),
    );
  });
}

/** `writeMark` on a thread of its own, so the API's thread never waits on it. */
export const markInThread = (
  options: {
    input: string;
    output: string;
    key: Buffer;
    markId: string;
    channels: number;
    timeoutMs: number;
  },
  signal: AbortSignal,
) =>
  inThread<{ samples: number }>(
    { task: "mark", ...options, key: new Uint8Array(options.key) },
    signal,
  );

/** `traceFile` on a thread of its own. */
export const traceInThread = (
  input: string,
  groups: readonly MarkGroup[],
  options: { seconds: number; timeoutMs: number },
  signal: AbortSignal,
) =>
  inThread<Detection>(
    {
      task: "trace",
      input,
      groups: groups.map((g) => ({ key: new Uint8Array(g.key), ids: g.ids })),
      ...options,
    },
    signal,
  );

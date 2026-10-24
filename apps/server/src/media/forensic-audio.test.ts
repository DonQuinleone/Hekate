import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaInfo } from "@hekate/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probe, run } from "./ffmpeg.ts";
import { FALSE_MATCH_LIMIT, forensicKey } from "./forensic.ts";
import {
  analysisArgs,
  markedAudioFormat,
  markInThread,
  mixArgs,
  splicedWave,
  traceFile,
  traceInThread,
  waveData,
  writeMark,
} from "./forensic-audio.ts";
import { sampleMusic } from "./sample-music.ts";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const encoders = hasFfmpeg
  ? spawnSync("ffmpeg", ["-hide_banner", "-encoders"]).stdout.toString()
  : "";
const has = (encoder: string) => encoders.includes(` ${encoder} `);

const key = forensicKey(Buffer.alloc(32, 3));
const ids = Array.from(
  { length: 200 },
  (_, i) => `0192a7c4-0000-7000-8000-${String(i).padStart(12, "0")}`,
);
const recipient = ids[57] as string;
const groups = [{ key, ids }];
const ample = { seconds: 600, timeoutMs: 120_000 };

const wav = (codec: string, rate = 44_100, channels = 2): MediaInfo => ({
  format: "wav",
  duration: 30,
  audio: { codec, channels, sampleRate: rate, bitDepth: codec === "pcm_s16le" ? 16 : 24 },
});

describe("forensic marks: formats", () => {
  it("keeps PCM in WAV or AIFF and FLAC as they are, and makes anything else FLAC", () => {
    expect(markedAudioFormat(wav("pcm_s24le"), "original")).toMatchObject({
      muxer: "wav",
      codecArgs: ["-c:a", "pcm_s24le", "-rf64", "auto"],
    });
    const aiff: MediaInfo = {
      format: "aiff",
      audio: { codec: "pcm_s16be", channels: 2, sampleRate: 48_000, bitDepth: 16 },
    };
    expect(markedAudioFormat(aiff, "original")).toMatchObject({ muxer: "aiff", extension: "aiff" });
    const flac: MediaInfo = {
      format: "flac",
      audio: { codec: "flac", channels: 2, sampleRate: 96_000, bitDepth: 16 },
    };
    expect(markedAudioFormat(flac, "original").codecArgs).toContain("s16");
    const mp3: MediaInfo = {
      format: "mp3",
      audio: { codec: "mp3", channels: 2, sampleRate: 44_100 },
    };
    const fromMp3 = markedAudioFormat(mp3, "original");
    expect(fromMp3).toMatchObject({ muxer: "flac", contentType: "audio/flac" });
    expect(fromMp3.detail).toMatch(/decoded from MP3/);
    expect(fromMp3.codecArgs).toContain("24");
    expect(markedAudioFormat(mp3, "proxy")).toMatchObject({ muxer: "mp4", extension: "m4a" });
    expect(markedAudioFormat(null, "proxy").codecArgs).toContain("256k");
  });

  it("opens the recording as any upload is opened, and the mark only as a WAV file", () => {
    const args = mixArgs(
      "in",
      "mark.wav",
      {
        sampleRate: 48_000,
        channels: 6,
        layout: "5.1",
        format: markedAudioFormat(null, "original"),
      },
      "out.flac",
    );
    expect(args.filter((a) => a === "-protocol_whitelist")).toHaveLength(2);
    expect(args[args.lastIndexOf("-format_whitelist") + 1]).toBe("wav");
    // Each channel carries its own mark.
    const graph = args[args.indexOf("-filter_complex") + 1] as string;
    expect(graph).toContain("pan=5.1|c0=c0+c6|c1=c1+c7|c2=c2+c8|c3=c3+c9|c4=c4+c10|c5=c5+c11");
    expect(args).toContain("-map_metadata");
    expect(analysisArgs("in")).toContain(String(16_000));
  });
});

describe.runIf(hasFfmpeg || process.env.CI)("forensic marks: through ffmpeg", () => {
  const dir = mkdtempSync(join(tmpdir(), "hekate-forensic-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const path = (name: string) => join(dir, name);
  const ffmpeg = (args: string[]) =>
    run("ffmpeg", ["-hide_banner", "-v", "error", "-y", ...args], { timeoutMs: 120_000 });

  /** A recording's samples as 32-bit integers, to compare exactly. */
  const samples = async (file: string, channel?: number) => {
    const chunks: Buffer[] = [];
    await run(
      "ffmpeg",
      [
        ...["-v", "error", "-i", file],
        ...(channel === undefined ? [] : ["-af", `pan=mono|c0=c${channel}`]),
        ...["-f", "s32le", "-acodec", "pcm_s32le", "pipe:1"],
      ],
      { timeoutMs: 60_000, onStdout: (c) => chunks.push(c) },
    );
    const all = Buffer.concat(chunks);
    return new Int32Array(all.buffer, all.byteOffset, all.byteLength / 4);
  };

  const mark = async (
    input: string,
    info: MediaInfo,
    kind: "proxy" | "original",
    output: string,
    options: { strength?: number; channels?: number; layout?: string } = {},
  ) => {
    const channels = options.channels ?? info.audio?.channels ?? 2;
    await writeMark(input, path("mark.wav"), {
      key,
      markId: recipient,
      channels,
      strength: options.strength,
      timeoutMs: 120_000,
    });
    await run(
      "ffmpeg",
      mixArgs(
        input,
        path("mark.wav"),
        {
          sampleRate: info.audio?.sampleRate ?? 44_100,
          channels,
          layout: options.layout,
          format: markedAudioFormat(info, kind),
        },
        output,
      ),
      { timeoutMs: 120_000 },
    );
  };

  beforeAll(async () => {
    // Thirty seconds of a 24-bit stereo master at 44.1 kHz, its channels a little different.
    const left = sampleMusic(30, 22_050, { seed: 11 });
    const right = sampleMusic(30, 22_050, { seed: 12 });
    const both = new Float32Array(left.length * 2);
    for (let i = 0; i < left.length; i++) {
      both[2 * i] = (left[i] as number) * 0.8 + (right[i] as number) * 0.2;
      both[2 * i + 1] = (right[i] as number) * 0.8 + (left[i] as number) * 0.2;
    }
    writeFileSync(path("source.f32"), Buffer.from(both.buffer));
    await ffmpeg([
      ...["-f", "f32le", "-ar", "22050", "-ac", "2", "-i", path("source.f32")],
      ...["-ar", "44100", "-c:a", "pcm_s24le", path("master.wav")],
    ]);
    await mark(path("master.wav"), wav("pcm_s24le"), "original", path("marked.wav"));
  }, 120_000);

  it("changes nothing but the mark: the same length, and the same samples with none", async () => {
    await mark(path("master.wav"), wav("pcm_s24le"), "original", path("silent.wav"), {
      strength: 0,
    });
    const [a, b, marked] = await Promise.all([
      samples(path("master.wav")),
      samples(path("silent.wav")),
      samples(path("marked.wav")),
    ]);
    expect(b.length).toBe(a.length);
    expect(b.every((v, i) => v === a[i])).toBe(true);
    expect(marked.length).toBe(a.length);
    expect(marked.some((v, i) => v !== a[i])).toBe(true);
    const info = await probe(path("marked.wav"));
    expect(info.audio).toMatchObject({ codec: "pcm_s24le", channels: 2, sampleRate: 44_100 });
  });

  it("keeps a WAV original's own chunks, byte for byte, around its marked samples", async () => {
    // A Broadcast Wave description before the samples and an ADM one after, as masters have.
    const master = readFileSync(path("master.wav"));
    const at = await waveData(path("master.wav"));
    if (!at) throw new Error("No data chunk");
    const chunk = (id: string, body: Buffer) => {
      const head = Buffer.alloc(8);
      head.write(id, 0, "latin1");
      head.writeUInt32LE(body.length, 4);
      return Buffer.concat([head, body, Buffer.alloc(body.length % 2)]);
    };
    const fmtEnd = master.indexOf("data", 12, "latin1");
    const body = Buffer.concat([
      master.subarray(12, fmtEnd),
      chunk("bext", Buffer.from("Joplin Rags, take 4, Endless Hall Records")),
      master.subarray(at.offset - 8, at.offset + at.size),
      chunk("axml", Buffer.from("<ebuCoreMain>an audio programme</ebuCoreMain>")),
    ]);
    const riff = Buffer.alloc(12);
    riff.write("RIFF", 0, "latin1");
    riff.writeUInt32LE(4 + body.length, 4);
    riff.write("WAVE", 8, "latin1");
    writeFileSync(path("bwf.wav"), Buffer.concat([riff, body]));
    await mark(path("bwf.wav"), wav("pcm_s24le"), "original", path("bwf-marked.wav"));
    const pieces = await splicedWave(path("bwf.wav"), path("bwf-marked.wav"));
    if (!pieces) throw new Error("Not spliced");
    const parts: Buffer[] = [];
    for await (const piece of pieces) parts.push(piece);
    const spliced = Buffer.concat(parts);
    const original = readFileSync(path("bwf.wav"));
    const inside = await waveData(path("bwf.wav"));
    if (!inside) throw new Error("No data chunk");
    expect(spliced.length).toBe(original.length);
    expect(spliced.subarray(0, inside.offset).equals(original.subarray(0, inside.offset))).toBe(
      true,
    );
    const end = inside.offset + inside.size;
    expect(spliced.subarray(end).equals(original.subarray(end))).toBe(true);
    expect(spliced.subarray(inside.offset, end).equals(original.subarray(inside.offset, end))).toBe(
      false,
    );
    writeFileSync(path("bwf-spliced.wav"), spliced);
    expect((await traceFile(path("bwf-spliced.wav"), groups, ample)).match?.id).toBe(recipient);
    // Something that is not a WAV file has no samples to put back.
    expect(await waveData(path("source.f32"))).toBeNull();
  }, 60_000);

  it("is found in the marked file, and in a 20-second cut of it", async () => {
    const found = await traceFile(path("marked.wav"), groups, ample);
    expect(found.match?.id).toBe(recipient);
    expect(found.match?.chance).toBeLessThan(FALSE_MATCH_LIMIT);
    await ffmpeg(["-ss", "6.3", "-t", "20", "-i", path("marked.wav"), path("cut.wav")]);
    expect((await traceFile(path("cut.wav"), groups, ample)).match?.id).toBe(recipient);
    const plain = await traceFile(path("master.wav"), groups, ample);
    expect(plain.match).toBeNull();
  });

  const reencodes: { name: string; args: string[]; ext: string; encoder: string }[] = [
    { name: "AAC at 128 kb/s", args: ["-c:a", "aac", "-b:a", "128k"], ext: "m4a", encoder: "aac" },
    { name: "AAC at 64 kb/s", args: ["-c:a", "aac", "-b:a", "64k"], ext: "m4a", encoder: "aac" },
    {
      name: "MP3 at 128 kb/s",
      args: ["-c:a", "libmp3lame", "-b:a", "128k"],
      ext: "mp3",
      encoder: "libmp3lame",
    },
    {
      name: "Opus at 48 kb/s",
      args: ["-c:a", "libopus", "-b:a", "48k"],
      ext: "ogg",
      encoder: "libopus",
    },
    {
      name: "resampled to 48 kHz, mono, 16-bit",
      args: ["-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le"],
      ext: "wav",
      encoder: "pcm_s16le",
    },
    {
      name: "9 dB quieter, equalised and band-limited to a telephone's 300 Hz to 3.4 kHz",
      args: [
        "-af",
        "volume=-9dB,equalizer=f=1000:t=q:w=1:g=6,highpass=f=300,lowpass=f=3400",
        "-ar",
        "8000",
        "-c:a",
        "pcm_s16le",
      ],
      ext: "wav",
      encoder: "pcm_s16le",
    },
  ];
  for (const { name, args, ext, encoder } of reencodes)
    it.runIf(has(encoder))(`survives being encoded again: ${name}`, async () => {
      const out = path(`again-${encoder}-${args.join("").replace(/\W/g, "")}.${ext}`);
      await ffmpeg(["-i", path("marked.wav"), ...args, out]);
      const found = await traceFile(out, groups, ample);
      expect(found.match?.id).toBe(recipient);
    });

  it("is lost when the speed changes by one per cent", async () => {
    await ffmpeg([
      "-i",
      path("marked.wav"),
      "-af",
      "asetrate=44541,aresample=44100",
      path("faster.wav"),
    ]);
    expect((await traceFile(path("faster.wav"), groups, ample)).match).toBeNull();
  });

  it("marks a proxy as AAC, and a lossy original as FLAC, both found", async () => {
    await mark(path("master.wav"), wav("pcm_s24le"), "proxy", path("proxy.m4a"));
    expect((await probe(path("proxy.m4a"))).audio?.codec).toBe("aac");
    expect((await traceFile(path("proxy.m4a"), groups, ample)).match?.id).toBe(recipient);
    await ffmpeg(["-i", path("master.wav"), "-c:a", "aac", "-b:a", "192k", path("lossy.m4a")]);
    const lossy: MediaInfo = {
      format: "mov,mp4,m4a,3gp,3g2,mj2",
      audio: { codec: "aac", channels: 2, sampleRate: 44_100 },
    };
    await mark(path("lossy.m4a"), lossy, "original", path("lossy-marked.flac"));
    const info = await probe(path("lossy-marked.flac"));
    expect(info.audio).toMatchObject({ codec: "flac", bitDepth: 24 });
    expect((await traceFile(path("lossy-marked.flac"), groups, ample)).match?.id).toBe(recipient);
  });

  it("marks each channel of a 5.1 recording by its own sound, so any fold-down carries it", async () => {
    // Side channels, not back ones: the mark must reach each channel as it is, never remixed.
    await ffmpeg([
      ...["-i", path("master.wav"), "-af"],
      "pan=5.1(side)|FL=c0|FR=c1|FC=0.5*c0+0.5*c1|LFE=0*c0|SL=0*c0|SR=0.3*c0",
      ...["-c:a", "pcm_s24le", path("surround.wav")],
    ]);
    const info = await probe(path("surround.wav"));
    expect(info.audio?.channelLayout).toBe("5.1(side)");
    await mark(path("surround.wav"), info, "original", path("surround-marked.wav"), {
      layout: "5.1(side)",
    });
    // Silent channels stay silent, the LFE and the left side.
    expect((await samples(path("surround-marked.wav"), 3)).every((v) => v === 0)).toBe(true);
    expect((await samples(path("surround-marked.wav"), 4)).every((v) => v === 0)).toBe(true);
    expect((await traceFile(path("surround-marked.wav"), groups, ample)).match?.id).toBe(recipient);
    await ffmpeg([
      ...["-i", path("surround-marked.wav"), "-ac", "2"],
      ...["-c:a", "aac", "-b:a", "128k", path("folded.m4a")],
    ]);
    expect((await traceFile(path("folded.m4a"), groups, ample)).match?.id).toBe(recipient);
    await ffmpeg(["-i", path("surround-marked.wav"), "-af", "pan=mono|c0=c5", path("side.wav")]);
    expect((await traceFile(path("side.wav"), groups, ample)).match?.id).toBe(recipient);
  }, 60_000);

  it("does its work on a thread of its own", async () => {
    const signal = new AbortController().signal;
    const { samples: made } = await markInThread(
      {
        input: path("master.wav"),
        output: path("thread-mark.wav"),
        key,
        markId: recipient,
        channels: 2,
        timeoutMs: 120_000,
      },
      signal,
    );
    expect(made).toBeGreaterThan(29 * 16_000);
    const found = await traceInThread(path("marked.wav"), groups, ample, signal);
    expect(found.match?.id).toBe(recipient);
  });
});

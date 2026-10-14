import { createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { probe, run } from "./ffmpeg.ts";
import { hasMedia, packageRendition, parsePlaylist, planRenditions } from "./proxy.ts";

const box = (type: string, payload: Buffer) => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, payload]);
};

describe("proxies", () => {
  it("tells fragments with media from empty ones", () => {
    const moof = box("moof", Buffer.alloc(16));
    expect(
      hasMedia(Buffer.concat([box("styp", Buffer.alloc(4)), moof, box("mdat", Buffer.alloc(100))])),
    ).toBe(true);
    expect(
      hasMedia(Buffer.concat([box("styp", Buffer.alloc(4)), moof, box("mdat", Buffer.alloc(0))])),
    ).toBe(false);
    expect(hasMedia(box("styp", Buffer.alloc(16)))).toBe(false);
    expect(hasMedia(Buffer.from([0, 0, 0, 4, 0x6d]))).toBe(false);
  });

  it("reads ffmpeg's playlists and refuses names it did not write", () => {
    expect(
      parsePlaylist(
        "#EXTM3U\n#EXTINF:6.048,\nseg00000.m4s\n#EXTINF:0.096,\nseg00001.m4s\n#EXT-X-ENDLIST\n",
      ),
    ).toEqual([
      { file: "seg00000.m4s", duration: 6.048 },
      { file: "seg00001.m4s", duration: 0.096 },
    ]);
    expect(() => parsePlaylist("#EXTINF:6,\n../../etc/passwd\n")).toThrow(/Unexpected segment/);
  });

  it("plans AAC and lossless for audio, and a ladder for video", () => {
    const audio = planRenditions("audio", {
      audio: { codec: "pcm_s24le", channels: 2, sampleRate: 96000, bitDepth: 24 },
    });
    expect(audio.map((r) => [r.name, r.codecs, r.bandwidth])).toEqual([
      ["aac-256", "mp4a.40.2", 300_000],
      ["flac", "fLaC", 96000 * 2 * 24],
    ]);
    expect(audio[0]?.args).toContain("48000");
    const video = planRenditions("video", {
      video: { codec: "prores", width: 3840, height: 2160 },
      audio: { codec: "pcm_s24le", channels: 6, sampleRate: 48000 },
    });
    expect(video.map((r) => [r.name, r.width, r.height])).toEqual([
      ["1080p", 1920, 1080],
      ["720p", 1280, 720],
    ]);
    const small = planRenditions("video", { video: { codec: "h264", width: 640, height: 360 } });
    expect(small.map((r) => [r.name, r.height, r.codecs])).toEqual([["360p", 360, "avc1.64001e"]]);
    expect(planRenditions("audio", {})).toEqual([]);
  });

  it("passes Dolby Digital and Dolby Digital Plus through untouched", () => {
    const atmos = planRenditions("audio", {
      bitRate: 768_000,
      audio: { codec: "eac3", channels: 6, channelLayout: "5.1(side)", sampleRate: 48000 },
    });
    expect(atmos.map((r) => [r.name, r.codecs, r.bandwidth])).toEqual([
      ["eac3", "ec-3", 768_000],
      ["aac-256", "mp4a.40.2", 300_000],
      ["flac", "fLaC", 48000 * 6 * 16],
    ]);
    expect(atmos[0]?.args).toEqual(["-map", "0:a:0", "-vn", "-c:a", "copy"]);
    const ac3 = planRenditions("audio", {
      audio: { codec: "ac3", channels: 6, sampleRate: 48000 },
    });
    expect(ac3[0]).toMatchObject({ name: "ac3", codecs: "ac-3", bandwidth: 640_000 });
  });
});

describe("surround packaging", () => {
  const root = mkdtempSync(join(tmpdir(), "hekate-proxy-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** Package, then decrypt and reassemble the rendition as a player would, and measure it. */
  const roundTrip = async (source: string, name: string) => {
    const info = await probe(source);
    const plan = planRenditions("audio", info).find((r) => r.name === name);
    if (!plan) throw new Error(`No ${name} rendition planned`);
    const key = randomBytes(16);
    const stored = new Map<string, Buffer>();
    const packaged = await packageRendition(
      source,
      join(root, `work-${name}`),
      plan,
      key,
      async (bytes) => {
        const id = String(stored.size);
        stored.set(id, bytes);
        return id;
      },
      new AbortController().signal,
    );
    const open = (id: string, iv: string) => {
      const decipher = createDecipheriv("aes-128-cbc", key, Buffer.from(iv, "hex"));
      return Buffer.concat([decipher.update(stored.get(id) as Buffer), decipher.final()]);
    };
    const out = join(root, `${name}.mp4`);
    writeFileSync(
      out,
      Buffer.concat([
        open(packaged.initBlobId, packaged.initIv),
        ...packaged.segments.map((s) => open(s.blobId, s.iv)),
      ]),
    );
    return probe(out);
  };

  const surround = async (codec: string, file: string) => {
    const path = join(root, file);
    await run("ffmpeg", [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=duration=2:sample_rate=48000",
      "-af",
      "pan=5.1(side)|FL=c0|FR=c0|FC=c0|LFE=c0|SL=c0|SR=c0",
      "-c:a",
      codec,
      path,
    ]);
    return path;
  };

  it("keeps all six channels of a 5.1 mix in the lossless rendition", async () => {
    const source = await surround("pcm_s24le", "mix-51.wav");
    const delivered = await roundTrip(source, "flac");
    expect(delivered.audio).toMatchObject({ codec: "flac", channels: 6, sampleRate: 48000 });
  });

  it("delivers E-AC-3 surround as it came", async () => {
    const source = await surround("eac3", "mix-51.ec3");
    const delivered = await roundTrip(source, "eac3");
    expect(delivered.audio).toMatchObject({ codec: "eac3", channels: 6 });
  });
});

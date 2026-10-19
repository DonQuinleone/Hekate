import { createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { probe, run } from "./ffmpeg.ts";
import {
  h264Level,
  hasMedia,
  packageRendition,
  parsePlaylist,
  partFilter,
  peakBitrate,
  planRenditions,
  type RenditionPlan,
  royaltyFreeCodecs,
} from "./proxy.ts";

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
      ["1080p-av1", 1920, 1080],
      ["720p", 1280, 720],
      ["720p-av1", 1280, 720],
    ]);
    const small = planRenditions("video", { video: { codec: "h264", width: 640, height: 360 } });
    expect(small.map((r) => [r.name, r.height, r.codecs])).toEqual([
      ["360p", 360, "avc1.64001e"],
      ["360p-av1", 360, "av01.0.01M.08"],
    ]);
    expect(planRenditions("audio", {})).toEqual([]);
  });

  it("carries a layout wider than eight channels in lossless parts of eight (#74)", () => {
    const wide = planRenditions("audio", {
      audio: { codec: "pcm_s24le", channels: 12, sampleRate: 48000, bitDepth: 24 },
    });
    expect(wide.map((r) => [r.name, r.bandwidth])).toEqual([
      ["aac-256", 300_000],
      ["flac", 48000 * 8 * 24],
      ["flac-2", 48000 * 4 * 24],
    ]);
    expect(wide[2]?.args).toContain("pan=quad|c0=c8|c1=c9|c2=c10|c3=c11");
    expect(partFilter({ name: "flac", from: 0, count: 8 })).toBe(
      "pan=7.1|c0=c0|c1=c1|c2=c2|c3=c3|c4=c4|c5=c5|c6=c6|c7=c7",
    );
    // Up to eight channels, one stream as it always was: no channels picked out.
    const eight = planRenditions("audio", {
      audio: { codec: "pcm_s24le", channels: 8, sampleRate: 48000, bitDepth: 24 },
    });
    expect(eight.find((r) => r.name === "flac")?.args.join(" ")).not.toContain("pan=");
  });

  it("declares the H.264 level the frame size and rate need", () => {
    expect(h264Level(1920, 1080, 25)).toBe(40);
    expect(h264Level(1920, 1080, 60)).toBe(42);
    expect(h264Level(1280, 720, 30)).toBe(31);
    expect(h264Level(1280, 720, 60)).toBe(32);
    expect(h264Level(854, 480, 30)).toBe(31);
    expect(h264Level(720, 480, 30)).toBe(30);
    expect(h264Level(854, 480, 60)).toBe(31);
    const fast = planRenditions("video", {
      video: { codec: "prores", width: 1920, height: 1080, fps: 59.94 },
    });
    expect(fast.map((r) => r.codecs)).toEqual([
      "avc1.64002a",
      "av01.0.09M.08",
      "avc1.640020",
      "av01.0.08M.08",
    ]);
    expect(fast[0]?.args).toContain("4.2");
  });

  it("encodes the instance's ladder, royalty-free beside H.264, on the GPU where it has one (#148)", () => {
    const source = {
      video: { codec: "prores", width: 3840, height: 2160, fps: 25 },
      audio: { codec: "pcm_s24le", channels: 2, sampleRate: 48000 },
    };
    const ladder = {
      rungs: [
        { height: 2160, rate: 16_000_000 },
        { height: 1080, rate: 6_000_000 },
        { height: 720, rate: 3_000_000 },
      ],
      most: 3,
      royaltyFree: "vp9" as const,
      hardware: "/dev/dri/renderD128",
    };
    const plans = planRenditions("video", source, ladder);
    expect(plans.map((r) => [r.name, r.codecs, r.bandwidth])).toEqual([
      ["2160p", "avc1.640033,mp4a.40.2", 16_200_000],
      ["2160p-vp9", "vp09.00.50.08,opus", 10_836_667],
      ["1080p", "avc1.640028,mp4a.40.2", 6_200_000],
      ["1080p-vp9", "vp09.00.40.08,opus", 4_170_000],
      ["720p", "avc1.64001f,mp4a.40.2", 3_200_000],
      ["720p-vp9", "vp09.00.31.08,opus", 2_170_000],
    ]);
    // H.264 on the GPU, with the same rendition in software should the GPU refuse it.
    const top = plans[0];
    expect(top?.args).toEqual(
      expect.arrayContaining(["h264_vaapi", "vaapi=gpu:/dev/dri/renderD128"]),
    );
    expect(top?.fallback).toEqual(expect.arrayContaining(["libx264"]));
    // The royalty-free one carries Opus, and is never sent to the GPU.
    expect(plans[1]?.args).toEqual(expect.arrayContaining(["libvpx-vp9", "libopus"]));
    // A rate-control buffer, without which libvpx ignores the ceiling.
    expect(plans[1]?.args).toEqual(expect.arrayContaining(["-bufsize", "32000000"]));
    expect(plans[1]?.fallback).toBeUndefined();
    // Fewer rungs, no royalty-free and no GPU: H.264 in software, as before.
    const plain = planRenditions("video", source, {
      ...ladder,
      most: 1,
      royaltyFree: null,
      hardware: null,
    });
    expect(plain.map((r) => r.name)).toEqual(["2160p"]);
    expect(plain[0]?.args).toContain("libx264");
    expect(plain[0]?.fallback).toBeUndefined();
  });

  it("advertises the peak segment bit rate as RFC 8216 defines it (#148)", () => {
    const second = (bytes: number) => ({ duration: 1, bytes });
    // Target 4 s: runs of 2 to 6 s. The busy pair at 3 and 4 alone lasts too short to count.
    const segments = [1, 1, 1, 10, 10, 1, 1, 1].map((kb) => second(kb * 1000));
    expect(peakBitrate(segments, 4)).toBe(((10 + 10) * 1000 * 8) / 2);
    // Busy throughout: the rate itself.
    expect(
      peakBitrate(
        [4, 4, 4, 4].map((kb) => second(kb * 1000)),
        1,
      ),
    ).toBe(32_000);
    // Too short for any run: the average.
    expect(peakBitrate([{ duration: 0.5, bytes: 1000 }], 4)).toBe(16_000);
    expect(peakBitrate([], 4)).toBe(0);
  });

  it("declares the AV1 and VP9 level the frame size and rate need", () => {
    expect(royaltyFreeCodecs("av1", 1920, 1080, 25)).toBe("av01.0.08M.08");
    expect(royaltyFreeCodecs("av1", 1920, 1080, 60)).toBe("av01.0.09M.08");
    expect(royaltyFreeCodecs("av1", 1280, 720, 30)).toBe("av01.0.05M.08");
    expect(royaltyFreeCodecs("av1", 3840, 2160, 30)).toBe("av01.0.12M.08");
    expect(royaltyFreeCodecs("vp9", 1920, 1080, 30)).toBe("vp09.00.40.08");
    expect(royaltyFreeCodecs("vp9", 1280, 720, 30)).toBe("vp09.00.31.08");
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
  const roundTrip = async (source: string, name: string, planned?: RenditionPlan[]) => {
    const info = await probe(source);
    const plan = (planned ?? planRenditions("audio", info)).find((r) => r.name === name);
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

  it("packages AV1 with Opus, and H.264 in software where the GPU is missing (#148)", async () => {
    const source = join(root, "cut.mp4");
    await run("ffmpeg", [
      ...["-hide_banner", "-nostdin", "-v", "error"],
      ...["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=2"],
      ...["-f", "lavfi", "-i", "sine=duration=2:sample_rate=48000"],
      ...["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source],
    ]);
    const plans = planRenditions("video", await probe(source), {
      rungs: [{ height: 360, rate: 800_000 }],
      most: 1,
      royaltyFree: "av1",
      // No such device: the GPU encode fails, and the rendition is made in software instead.
      hardware: "/dev/dri/renderD999",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h264 = await roundTrip(source, "360p", plans);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(h264.video).toMatchObject({ codec: "h264", width: 640, height: 360 });
    expect(h264.audio).toMatchObject({ codec: "aac" });
    const av1 = await roundTrip(source, "360p-av1", plans);
    expect(av1.video).toMatchObject({ codec: "av1", width: 640, height: 360 });
    expect(av1.audio).toMatchObject({ codec: "opus", sampleRate: 48000 });
    expect(av1.duration).toBeCloseTo(2, 0);
  }, 120_000);

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

  it("carries a 7.1.4 mix in two lossless parts, the heights in the second (#74)", async () => {
    // Sound only in the first height channel (TFL, the ninth): it must arrive first in part two.
    const path = join(root, "mix-714.wav");
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
      "pan=7.1.4|TFL=c0",
      "-c:a",
      "pcm_s24le",
      path,
    ]);
    const bed = await roundTrip(path, "flac");
    const heights = await roundTrip(path, "flac-2");
    expect(bed.audio).toMatchObject({ codec: "flac", channels: 8 });
    expect(heights.audio).toMatchObject({ codec: "flac", channels: 4 });
    const levels = async (file: string) => {
      const { stderr } = await run("ffmpeg", [
        "-hide_banner",
        "-nostdin",
        "-i",
        file,
        "-af",
        "astats=measure_overall=none:measure_perchannel=Peak_level",
        "-f",
        "null",
        "-",
      ]);
      return [...stderr.matchAll(/Peak level dB: (\S+)/g)].map((m) =>
        m[1] === "-inf" ? Number.NEGATIVE_INFINITY : Number(m[1]),
      );
    };
    const [tfl, ...rest] = await levels(join(root, "flac-2.mp4"));
    expect(tfl).toBeGreaterThan(-40);
    for (const silent of rest) expect(silent).toBe(Number.NEGATIVE_INFINITY);
    expect(
      (await levels(join(root, "flac.mp4"))).every((l) => l === Number.NEGATIVE_INFINITY),
    ).toBe(true);
  });

  it("delivers E-AC-3 surround as it came", async () => {
    const source = await surround("eac3", "mix-51.ec3");
    const delivered = await roundTrip(source, "eac3");
    expect(delivered.audio).toMatchObject({ codec: "eac3", channels: 6 });
  });
});

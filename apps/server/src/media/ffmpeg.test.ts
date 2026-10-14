import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MediaToolError, parseProbe, probe, run } from "./ffmpeg.ts";
import { withWorkspace } from "./workspace.ts";

const hasFfmpeg = spawnSync("ffprobe", ["-version"]).status === 0;

/** Make a test file with ffmpeg's built-in generators. */
const generate = (args: string[]) =>
  run("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-y", ...args], { timeoutMs: 60_000 });

describe("probe output", () => {
  it("reads audio, video and frame rates, ignoring cover art", () => {
    const info = parseProbe({
      format: {
        format_name: "mov,mp4,m4a,3gp,3g2,mj2",
        duration: "12.500000",
        bit_rate: "1411200",
      },
      streams: [
        {
          codec_type: "video",
          codec_name: "mjpeg",
          width: 600,
          height: 600,
          disposition: { attached_pic: 1 },
        },
        {
          codec_type: "video",
          codec_name: "prores",
          width: 1920,
          height: 1080,
          avg_frame_rate: "24000/1001",
          pix_fmt: "yuv422p10le",
        },
        {
          codec_type: "audio",
          codec_name: "pcm_s24le",
          channels: 2,
          channel_layout: "stereo",
          sample_rate: "48000",
          bits_per_sample: 24,
        },
      ],
    });
    expect(info).toEqual({
      format: "mov,mp4,m4a,3gp,3g2,mj2",
      duration: 12.5,
      bitRate: 1411200,
      audio: {
        codec: "pcm_s24le",
        channels: 2,
        channelLayout: "stereo",
        sampleRate: 48000,
        bitDepth: 24,
      },
      video: {
        codec: "prores",
        width: 1920,
        height: 1080,
        fps: 23.976,
        frameRate: "24000/1001",
        pixelFormat: "yuv422p10le",
      },
    });
  });

  it("tolerates missing and nonsensical values", () => {
    expect(
      parseProbe({
        format: { duration: "N/A", bit_rate: "0" },
        streams: [{ codec_type: "audio", codec_name: "mp3", channels: 0, sample_rate: "44100" }],
      }),
    ).toEqual({});
  });
});

// CI installs ffmpeg; elsewhere these run when it is available.
describe.runIf(hasFfmpeg || process.env.CI)("media tools", () => {
  it("probes generated audio and video", async () => {
    await withWorkspace(undefined, async (dir) => {
      const wav = join(dir, "tone.wav");
      await generate([
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=96000:duration=2",
        "-ac",
        "2",
        "-c:a",
        "pcm_s24le",
        wav,
      ]);
      expect(await probe(wav)).toMatchObject({
        format: "wav",
        audio: { codec: "pcm_s24le", channels: 2, sampleRate: 96000, bitDepth: 24 },
      });
      expect((await probe(wav)).duration).toBeCloseTo(2, 1);

      const flac = join(dir, "tone.flac");
      await generate([
        "-f",
        "lavfi",
        "-i",
        "sine=duration=1:sample_rate=44100",
        "-c:a",
        "flac",
        "-sample_fmt",
        "s16",
        flac,
      ]);
      expect(await probe(flac)).toMatchObject({
        format: "flac",
        audio: { codec: "flac", channels: 1, sampleRate: 44100, bitDepth: 16 },
      });

      const mp4 = join(dir, "bars.mp4");
      await generate([
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=25:duration=1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        mp4,
      ]);
      expect(await probe(mp4)).toMatchObject({
        video: {
          codec: "h264",
          width: 320,
          height: 180,
          fps: 25,
          frameRate: "25/1",
          pixelFormat: "yuv420p",
        },
      });
    });
  });

  it("refuses playlists and concat files that reach for other files", async () => {
    await withWorkspace(undefined, async (dir) => {
      const concat = join(dir, "upload.wav");
      await writeFile(concat, "ffconcat version 1.0\nfile '/etc/passwd'\n");
      await expect(probe(concat)).rejects.toBeInstanceOf(MediaToolError);

      const playlist = join(dir, "upload.m4a");
      await writeFile(
        playlist,
        "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n",
      );
      await expect(probe(playlist)).rejects.toBeInstanceOf(MediaToolError);

      const remote = join(dir, "remote.m3u8");
      await writeFile(remote, "#EXTM3U\n#EXTINF:1,\nhttp://127.0.0.1:9/segment.ts\n");
      await expect(probe(remote)).rejects.toBeInstanceOf(MediaToolError);
    });
  });

  it("treats a file name as a path, never an option", async () => {
    await withWorkspace(undefined, async (dir) => {
      const odd = join(dir, "-i x.wav");
      await generate(["-f", "lavfi", "-i", "sine=duration=0.2", `file:${odd}`]);
      expect((await probe(odd)).audio?.codec).toBe("pcm_s16le");
    });
  });

  it("stops a run that takes too long or is cancelled", async () => {
    const slow = ["-hide_banner", "-nostdin", "-f", "lavfi", "-i", "sine", "-f", "null", "-"];
    await expect(run("ffmpeg", slow, { timeoutMs: 300 })).rejects.toThrow(/timed out/);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await expect(run("ffmpeg", slow, { signal: controller.signal })).rejects.toThrow(/cancelled/);
  });

  it("removes the workspace afterwards, even when the job fails", async () => {
    let seen = "";
    await expect(
      withWorkspace(undefined, async (dir) => {
        seen = dir;
        await writeFile(join(dir, "decrypted.wav"), "secret");
        throw new Error("job failed");
      }),
    ).rejects.toThrow("job failed");
    expect(existsSync(seen)).toBe(false);
    expect(await readdir(join(seen, ".."))).not.toContain(seen.split("/").pop());
  });
});

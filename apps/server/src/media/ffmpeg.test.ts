import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InvalidMediaError, MediaToolError, parseProbe, probe, run } from "./ffmpeg.ts";
import { streamInWorkspace, sweepWorkspaces, withWorkspace } from "./workspace.ts";

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
      // The cover art is not video, but it is the file's artwork.
      metadata: { tags: {}, artwork: { codec: "mjpeg", width: 600, height: 600 } },
    });
  });

  it("reads the common tags by whatever name the container gives them (#41)", () => {
    const info = parseProbe(
      {
        format: {
          format_name: "wav",
          tags: {
            title: " Maple Leaf Rag ",
            TSRC: "GBEHR2600001",
            album_artist: "Endless Hall Records",
            date: "2026-10-14",
            comment: "Maple Leaf Rag, V2 dry",
          },
        },
        streams: [
          {
            codec_type: "audio",
            codec_name: "pcm_s24le",
            channels: 2,
            sample_rate: "96000",
            duration: "58.500000",
          },
        ],
      },
      { bext: { originator: "Endless Hall Records", originationDate: "2026-10-14" } },
    );
    // The sound's own length, which a video's may not share with its picture.
    expect(info.audio?.duration).toBe(58.5);
    expect(info.metadata).toEqual({
      // A wave file's date is its origination date, shown with the bext.
      tags: { title: "Maple Leaf Rag", isrc: "GBEHR2600001", albumArtist: "Endless Hall Records" },
      bext: { originator: "Endless Hall Records", originationDate: "2026-10-14" },
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

      // Broadcast Wave: the bext read from the file itself, and the tags beside it (#41).
      const bwf = join(dir, "take.wav");
      await generate([
        "-f",
        "lavfi",
        "-i",
        "sine=duration=1:sample_rate=48000",
        "-c:a",
        "pcm_s24le",
        "-write_bext",
        "1",
        "-metadata",
        "description=Maple Leaf Rag, V2 dry",
        "-metadata",
        "originator=Endless Hall Records",
        "-metadata",
        "origination_date=2026-10-14",
        "-metadata",
        "origination_time=09:58:00",
        "-metadata",
        "time_reference=1728000000",
        "-metadata",
        "title=Maple Leaf Rag",
        "-metadata",
        "ISRC=GBEHR2600001",
        bwf,
      ]);
      expect((await probe(bwf)).metadata).toMatchObject({
        bext: {
          description: "Maple Leaf Rag, V2 dry",
          originator: "Endless Hall Records",
          originationDate: "2026-10-14",
          originationTime: "09:58:00",
          timeReference: 1728000000,
        },
        tags: { title: "Maple Leaf Rag", isrc: "GBEHR2600001" },
      });

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

  it("tells unreadable media from a tool that could not run", async () => {
    await withWorkspace(undefined, async (dir) => {
      const junk = join(dir, "junk.wav");
      await writeFile(junk, "definitely not audio");
      await expect(probe(junk)).rejects.toBeInstanceOf(InvalidMediaError);
    });
    // Missing tools, timeouts and cancellation are operational: retryable, not invalid media.
    const missing = run("ffprobe-that-does-not-exist", []);
    await expect(missing).rejects.toBeInstanceOf(MediaToolError);
    await expect(missing).rejects.not.toBeInstanceOf(InvalidMediaError);
    const slow = run(
      "ffmpeg",
      ["-hide_banner", "-nostdin", "-f", "lavfi", "-i", "sine", "-f", "null", "-"],
      {
        timeoutMs: 200,
      },
    );
    await expect(slow).rejects.not.toBeInstanceOf(InvalidMediaError);
  });

  it("sweeps workspaces left by a process that died, and only those", async () => {
    const root = await mkdtemp(join(tmpdir(), "hekate-sweep-"));
    // A pid far above any real one stands in for a process that has gone.
    await mkdir(join(root, "job-999999999-abc"), { recursive: true });
    await writeFile(join(root, "job-999999999-abc", "decrypted.wav"), "secret");
    await mkdir(join(root, `job-${process.pid}-live`));
    await mkdir(join(root, "something-else"));
    expect(await sweepWorkspaces(root)).toBe(1);
    expect((await readdir(root)).sort()).toEqual([`job-${process.pid}-live`, "something-else"]);
    await rm(root, { recursive: true, force: true });
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

  it("keeps a streamed workspace in the configured place until the reader stops", async () => {
    const root = await mkdtemp(join(tmpdir(), "hekate-stream-"));
    let seen = "";
    const pieces = streamInWorkspace(root, async function* (dir) {
      seen = dir;
      await writeFile(join(dir, "decrypted.pdf"), "secret");
      yield 1;
      yield 2;
    });
    expect((await pieces.next()).value).toBe(1);
    expect(seen.startsWith(`${root}/job-${process.pid}-`)).toBe(true);
    expect(existsSync(join(seen, "decrypted.pdf"))).toBe(true);
    // A browser that goes stops the download early: the workspace goes with it.
    await pieces.return(undefined);
    expect(existsSync(seen)).toBe(false);
    await rm(root, { recursive: true, force: true });
  });
});

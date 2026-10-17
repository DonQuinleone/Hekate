import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultWatermark } from "@hekate/shared";
import { afterAll, describe, expect, it } from "vitest";
import { audioCodecsOf, burnArgs, burnDeadlineMs, streamFfmpeg } from "./burn.ts";
import { InvalidMediaError, probe, run } from "./ffmpeg.ts";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe("burning a mark into video", () => {
  const dir = mkdtempSync(join(tmpdir(), "hekate-burn-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const argsFor = (quality: "proxy" | "original", ...audioCodecs: string[]) =>
    burnArgs("in", "mark.txt", { quality, audioCodecs, style: defaultWatermark });
  const ample = { timeoutMs: 120_000 };
  const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it("sends a proxy as MP4 and an original as QuickTime, its sound kept where it can be", () => {
    expect(after(argsFor("proxy"), "-f")).toBe("mp4");
    expect(after(argsFor("proxy"), "-c:a")).toBe("copy");
    expect(after(argsFor("original", "pcm_s24le"), "-f")).toBe("mov");
    expect(after(argsFor("original", "pcm_s24le"), "-c:a:0")).toBe("copy");
    expect(after(argsFor("original", "opus"), "-c:a:0")).toBe("pcm_s24le");
    // Each stream on its own: AAC first does not carry an Opus second as it is.
    const mixed = argsFor("original", "aac", "opus", "pcm_s16le");
    expect([after(mixed, "-c:a:0"), after(mixed, "-c:a:1"), after(mixed, "-c:a:2")]).toEqual([
      "copy",
      "pcm_s24le",
      "copy",
    ]);
    expect(argsFor("original")).not.toContain("-c:a");
    // Better than the stream, as something worked from should be.
    expect(Number(after(argsFor("original"), "-crf"))).toBeLessThan(
      Number(after(argsFor("proxy"), "-crf")),
    );
    // Opened as any upload is: files only, real media demuxers only.
    const args = argsFor("original");
    expect(after(args, "-protocol_whitelist")).toBe("file");
    expect(after(args, "-format_whitelist")).not.toContain("hls");
    expect(after(args, "-vf")).toContain("textfile='mark.txt':expansion=none");
  });

  it("gives a long film longer, and every encode a deadline", () => {
    expect(burnDeadlineMs(60)).toBe(15 * 60_000);
    expect(burnDeadlineMs(2 * 60 * 60)).toBe(20 * 60 * 60_000);
    expect(burnDeadlineMs(undefined)).toBe(2 * 60 * 60_000);
  });

  it.runIf(hasFfmpeg || process.env.CI)(
    "encodes a marked video as it is read, and stops when the reader does",
    async () => {
      const source = join(dir, "source.mkv");
      await run("ffmpeg", [
        ...["-hide_banner", "-nostdin", "-v", "error"],
        ...["-f", "lavfi", "-i", "testsrc=size=321x241:rate=25:duration=2"],
        ...["-f", "lavfi", "-i", "sine=frequency=440:duration=2"],
        ...["-f", "lavfi", "-i", "sine=frequency=220:duration=2"],
        ...["-map", "0", "-map", "1", "-map", "2"],
        ...["-c:v", "ffv1", "-c:a:0", "aac", "-c:a:1", "libopus", source],
      ]);
      const codecs = await audioCodecsOf(source);
      expect(codecs).toEqual(["aac", "opus"]);
      const text = join(dir, "mark.txt");
      writeFileSync(text, "Ines Arlow · ines@example.test\nEndless Hall Records · 17 October 2026");
      const chunks: Buffer[] = [];
      for await (const chunk of streamFfmpeg(
        burnArgs(source, text, {
          quality: "original",
          audioCodecs: codecs,
          style: defaultWatermark,
        }),
        ample,
      ))
        chunks.push(chunk);
      const out = join(dir, "marked.mov");
      writeFileSync(out, Buffer.concat(chunks));
      const info = await probe(out);
      // Odd sizes lose a line, as H.264 in 4:2:0 needs.
      expect(info.video).toMatchObject({ codec: "h264", width: 320, height: 240 });
      // The first stream as it was; the second, which QuickTime cannot carry, as PCM.
      expect(info.audio).toMatchObject({ codec: "aac" });
      expect(await audioCodecsOf(out)).toEqual(["aac", "pcm_s24le"]);
      expect(info.duration).toBeGreaterThan(1.9);

      // A reader that stops after the first piece ends ffmpeg and returns at once.
      const started = Date.now();
      for await (const _ of streamFfmpeg(
        burnArgs(source, text, { quality: "original", style: defaultWatermark }),
        ample,
      ))
        break;
      expect(Date.now() - started).toBeLessThan(10_000);

      // Past its deadline, ffmpeg is stopped and the download fails rather than hangs.
      const late = streamFfmpeg(
        burnArgs(source, text, { quality: "original", style: defaultWatermark }),
        { timeoutMs: 1 },
      );
      await expect(
        (async () => {
          for await (const _ of late);
        })(),
      ).rejects.toThrow(/timed out/);
    },
  );

  it.runIf(hasFfmpeg || process.env.CI)("refuses what is not a video", async () => {
    const fake = join(dir, "fake.mp4");
    writeFileSync(fake, "#EXTM3U\n#EXT-X-ENDLIST\n");
    const text = join(dir, "mark2.txt");
    writeFileSync(text, "Mira Solberg");
    const chunks = streamFfmpeg(
      burnArgs(fake, text, { quality: "proxy", style: defaultWatermark }),
      ample,
    );
    await expect(chunks.next()).rejects.toThrow(InvalidMediaError);
  });
});

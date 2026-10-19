import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QaFinding } from "@hekate/shared";
import { afterAll, describe, expect, it } from "vitest";
import { run } from "./ffmpeg.ts";
import { analysePicture, limitedRange, PictureChecks, pixelDepth } from "./picture.ts";

const root = mkdtempSync(join(tmpdir(), "hekate-picture-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const size = "320x240";
const moving = (d: number) => `testsrc2=s=${size}:r=25:d=${d}`;
const plain = (y: number, d: number) =>
  `color=black:s=${size}:r=25:d=${d},format=yuv420p,geq=lum=${y}:cb=128:cr=128`;

/** A clip of the parts given, one after another, at 25 frames a second. */
const clip = async (name: string, parts: string[], extra: string[] = []) => {
  const path = join(root, name);
  const graph = `${parts.map((p, i) => `${p}[p${i}]`).join(";")};${parts
    .map((_, i) => `[p${i}]`)
    .join("")}concat=n=${parts.length},format=yuv420p`;
  await run("ffmpeg", [
    ...["-hide_banner", "-nostdin", "-v", "error", "-f", "lavfi", "-i", graph],
    ...extra,
    ...["-c:v", "libx264", "-crf", "16", path],
  ]);
  return path;
};

const video = { codec: "h264", width: 320, height: 240, fps: 25, pixelFormat: "yuv420p" };
const of = (findings: QaFinding[], check: QaFinding["check"]) =>
  findings.filter((f) => f.check === check);

describe("the picture checks (#42)", () => {
  it("finds black, frozen and flashing passages, and says where", async () => {
    const path = await clip("parts.mp4", [
      plain(16, 1.5),
      moving(2.5),
      // One frame, held for three seconds.
      `${moving(0.04)},loop=74:1:0,setpts=N/25/TB`,
      moving(1),
      plain(16, 1.2),
      moving(1),
      // Black and white, two frames each: more than six flashes a second.
      `color=black:s=${size}:r=25:d=2,format=yuv420p,geq=lum='if(mod(floor(N/2),2),235,16)':cb=128:cr=128`,
      moving(1.5),
    ]);
    const findings = await analysePicture(path, video);

    const black = of(findings, "black-frames");
    expect(black.map((f) => [f.severity, f.summary, f.start])).toEqual([
      ["info", "Black for 1.5 s at the start", 0],
      ["warn", "Black for 1.2 s", expect.closeTo(8, 1)],
    ]);
    const frozen = of(findings, "frozen-frames");
    expect(frozen).toHaveLength(1);
    expect(frozen[0]).toMatchObject({ severity: "warn", start: expect.closeTo(4, 1) });
    expect(frozen[0]?.end).toBeCloseTo(7, 0);
    const flashing = of(findings, "flashing");
    expect(flashing).toHaveLength(1);
    expect(flashing[0]?.severity).toBe("warn");
    expect(flashing[0]?.start).toBeGreaterThanOrEqual(10.2);
    expect(flashing[0]?.end).toBeLessThanOrEqual(12.3);

    // Every check that ran says so, a pass included.
    expect(of(findings, "dropped-frames")).toMatchObject([{ severity: "pass" }]);
    expect(of(findings, "interlacing")).toMatchObject([{ severity: "pass" }]);
    expect(of(findings, "letterbox")).toMatchObject([{ severity: "pass" }]);
    expect(of(findings, "broadcast-levels")).toMatchObject([{ severity: "pass" }]);
  }, 60_000);

  it("finds letterboxing, levels outside broadcast range, and missing frames", async () => {
    const path = await clip(
      "letterbox.mp4",
      [
        `testsrc2=s=320x180:r=25:d=2,pad=320:240:0:30`,
        `color=black:s=320x180:r=25:d=1,format=yuv420p,geq=lum=252:cb=128:cr=128,pad=320:240:0:30`,
        `testsrc2=s=320x180:r=25:d=2,pad=320:240:0:30`,
      ],
      // Five frames taken out, the others keeping their times.
      ["-vf", "select='not(between(n,20,24))'", "-fps_mode", "passthrough"],
    );
    const findings = await analysePicture(path, video);
    expect(of(findings, "letterbox")).toMatchObject([
      {
        severity: "info",
        summary: "Letterboxed: the picture is 320×180 inside 320×240 (1.78:1)",
      },
    ]);
    const levels = of(findings, "broadcast-levels");
    expect(levels).toHaveLength(1);
    expect(levels[0]).toMatchObject({ severity: "warn", start: 2 });
    expect(levels[0]?.details.lumaMaxInFile).toBeGreaterThan(241);
    expect(of(findings, "dropped-frames")).toMatchObject([
      { severity: "warn", summary: "5 frames missing", start: 0.8 },
    ]);
  }, 60_000);

  it("tells an interlaced picture by its one field order", async () => {
    const path = join(root, "interlaced.mp4");
    await run("ffmpeg", [
      ...["-hide_banner", "-nostdin", "-v", "error"],
      ...["-f", "lavfi", "-i", "mandelbrot=s=720x576:r=50,trim=duration=3"],
      ...["-vf", "interlace=scan=tff", "-c:v", "libx264", "-flags", "+ildct+ilme", path],
    ]);
    const findings = await analysePicture(path, { ...video, width: 720, height: 576 });
    expect(of(findings, "interlacing")).toMatchObject([
      { severity: "info", summary: "Interlaced, top field first" },
    ]);
  }, 60_000);

  it("takes a picture that never moves as a still image, not a fault", async () => {
    const path = await clip("still.mp4", [`${moving(0.04)},loop=149:1:0,setpts=N/25/TB`]);
    const findings = await analysePicture(path, video);
    expect(of(findings, "frozen-frames")).toMatchObject([
      { severity: "info", summary: "A still picture throughout", start: null },
    ]);
  }, 60_000);

  it("fails a picture that is black throughout, and does not measure its bars", async () => {
    const path = await clip("black.mp4", [plain(16, 3)]);
    const findings = await analysePicture(path, video);
    expect(of(findings, "black-frames")).toMatchObject([
      { severity: "fail", summary: "The picture is black throughout" },
    ]);
    expect(of(findings, "frozen-frames")).toMatchObject([{ severity: "pass" }]);
    expect(of(findings, "letterbox")).toEqual([]);
  }, 60_000);

  it("fails a black picture however short it is", async () => {
    const path = await clip("bumper.mp4", [plain(16, 0.5)]);
    const findings = await analysePicture(path, video);
    expect(of(findings, "black-frames")).toMatchObject([
      { severity: "fail", summary: "The picture is black throughout" },
    ]);
  }, 60_000);

  it("judges levels by the range the stream says it has", async () => {
    // Bright as full range allows, which limited range would refuse.
    const path = await clip("full.mp4", [plain(250, 2)]);
    const unsafe = (found: QaFinding[]) =>
      of(found, "broadcast-levels").filter((f) => f.severity === "warn");
    expect(unsafe(await analysePicture(path, video))).not.toEqual([]);
    expect(unsafe(await analysePicture(path, { ...video, range: "full" }))).toEqual([]);
  }, 60_000);

  it("does not count a variable frame rate's held frames as missing", async () => {
    const path = join(root, "variable.mkv");
    // Every third frame held a third of a frame longer, and one held for half a second.
    await run("ffmpeg", [
      ...["-hide_banner", "-nostdin", "-v", "error", "-f", "lavfi"],
      ...["-i", `${moving(3)},settb=1/1000,setpts='(N/25+0.013*floor(N/3)+if(gt(N,40),0.5,0))/TB'`],
      ...[
        "-fps_mode",
        "passthrough",
        "-enc_time_base",
        "1/1000",
        "-c:v",
        "libx264",
        "-crf",
        "16",
        path,
      ],
    ]);
    const findings = await analysePicture(path, video);
    expect(of(findings, "dropped-frames")).toMatchObject([
      {
        severity: "info",
        summary: "Variable frame rate: a held frame cannot be told from a missing one",
      },
    ]);
  }, 60_000);

  it("reads frame times from where the stream starts", () => {
    const checks = new PictureChecks({ ...video, fps: undefined });
    const frame = (n: number, t: number, keys: string[] = []) =>
      [`frame:${n}    pts:${t * 90000}  pts_time:${t}`, ...keys.map((k) => `lavfi.${k}`)].join(
        "\n",
      );
    const text = [
      frame(0, 10, ["black_start=10"]),
      frame(1, 10.04),
      frame(2, 10.08, ["black_end=11.5"]),
      frame(3, 13),
    ].join("\n");
    // Split anywhere, as a pipe would.
    checks.push(text.slice(0, 37));
    checks.push(text.slice(37));
    const findings = checks.finish();
    expect(of(findings, "black-frames")).toMatchObject([
      { severity: "info", summary: "Black for 1.5 s at the start", start: 0, end: 1.5 },
    ]);
    // No frame rate, so no count of missing frames.
    expect(of(findings, "dropped-frames")).toEqual([]);
  });

  it("knows a format's depth and range", () => {
    expect(pixelDepth("yuv420p")).toBe(8);
    expect(pixelDepth("yuv422p10le")).toBe(10);
    expect(pixelDepth("p010le")).toBe(10);
    expect(pixelDepth(undefined)).toBe(8);
    expect(limitedRange("yuv420p")).toBe(true);
    expect(limitedRange("yuvj420p")).toBe(false);
    expect(limitedRange("rgb24")).toBe(false);
    expect(limitedRange("gbrp10le")).toBe(false);
  });
});

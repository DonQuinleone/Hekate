import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QaFinding } from "@hekate/shared";
import { afterAll, describe, expect, it } from "vitest";
import { run } from "./ffmpeg.ts";
import { analysePicture } from "./picture.ts";
import { TimecodeChecks } from "./timecode.ts";

const root = mkdtempSync(join(tmpdir(), "hekate-timecode-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** An MPEG-2 programme stream, its timecode written on every group of pictures. */
const mpeg2 = async (name: string, start: string, seconds: number) => {
  const path = join(root, name);
  await run("ffmpeg", [
    ...["-hide_banner", "-nostdin", "-v", "error", "-f", "lavfi"],
    ...["-i", `testsrc2=s=320x240:r=25:d=${seconds}`],
    ...["-c:v", "mpeg2video", "-q:v", "4", "-timecode", start, path],
  ]);
  return path;
};

const video = { codec: "mpeg2video", width: 320, height: 240, fps: 25, pixelFormat: "yuv420p" };
const timecodeOf = (findings: QaFinding[]) => findings.filter((f) => f.check === "timecode");

/** The lines showinfo writes for frames at 25 fps, each with the timecode given, if any. */
const log = (frames: (string | null)[], fps = 25) =>
  frames
    .map((tc, n) =>
      [
        `[Parsed_showinfo_1 @ 0x1] n:${String(n).padStart(4)} pts:${String(n * 3600).padStart(7)} pts_time:${(n / fps).toFixed(4)} duration:3600`,
        ...(tc ? [`[Parsed_showinfo_1 @ 0x1]   side data - GOP timecode: ${tc}`] : []),
      ].join("\n"),
    )
    .join("\n")
    .concat("\n");

describe("timecode continuity (#42)", () => {
  it("passes a timecode carried on the picture that runs on without a break", async () => {
    const path = await mpeg2("whole.mpg", "10:00:00:00", 3);
    const found = timecodeOf(await analysePicture(path, { ...video, timecode: "10:00:00:00" }));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: "pass", summary: "Continuous from 10:00:00:00" });
    expect(found[0]?.details.carried).toBeGreaterThan(1);
  }, 60_000);

  it("finds where the count restarts, as two recordings joined do", async () => {
    const a = await mpeg2("a.mpg", "10:00:00:00", 2);
    const b = await mpeg2("b.mpg", "11:00:00:00", 2);
    const joined = join(root, "joined.mpg");
    // A programme stream can be joined end to end, each part keeping its own timecode.
    writeFileSync(joined, Buffer.concat([readFileSync(a), readFileSync(b)]));
    const found = timecodeOf(await analysePicture(joined, { ...video, timecode: "10:00:00:00" }));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      severity: "fail",
      // The group's timecode comes a frame early (see TimecodeChecks).
      summary: "Timecode jumps from 10:00:01:24 to 11:00:00:00",
      start: expect.closeTo(2, 1),
    });
  }, 60_000);

  it("reads a timecode written in parts, and counts through midnight", () => {
    const checks = new TimecodeChecks({ ...video, timecode: "23:59:59:23" });
    // ffmpeg's log arrives in pieces that need not end with a line.
    const text = log(["23:59:59:23", null, "00:00:00:00", null, "00:00:00:02"]);
    checks.push(text.slice(0, 50));
    checks.push(text.slice(50));
    expect(checks.finish()).toMatchObject([
      { severity: "pass", summary: "Continuous from 23:59:59:23" },
    ]);
  });

  it("counts dropped frames at 29.97, and finds a break among them", () => {
    const fps = 30000 / 1001;
    const rate = { ...video, fps, timecode: "00:00:59;29" };
    const smooth = new TimecodeChecks(rate);
    // The count skips 00:01:00;00 and ;01 at the minute.
    smooth.push(log(["00:00:59;29", "00:01:00;02", "00:01:00;03"], fps));
    expect(smooth.finish()).toMatchObject([{ severity: "pass" }]);
    const broken = new TimecodeChecks(rate);
    broken.push(log(["00:00:59;29", "00:01:00;02", "00:01:00;05"], fps));
    expect(broken.finish()).toMatchObject([
      { severity: "fail", summary: "Timecode jumps from 00:01:00;03 to 00:01:00;05" },
    ]);
  });

  it("warns where the file's own records disagree", () => {
    const disagree = new TimecodeChecks({
      ...video,
      timecode: "10:00:00:00",
      timecodes: ["10:00:00:00", "09:59:50:00"],
    });
    disagree.push(log(["01:00:00:00", "01:00:00:01"]));
    expect(disagree.finish().map((f) => [f.severity, f.summary])).toEqual([
      ["warn", "The file writes 2 different start timecodes: 10:00:00:00, 09:59:50:00"],
      ["warn", "The picture's own timecode starts at 01:00:00:00; the file says 10:00:00:00"],
      ["pass", "Continuous from 10:00:00:00"],
    ]);
    const dropAt25 = new TimecodeChecks({ ...video, timecode: "10:00:00;00" });
    expect(dropAt25.finish().map((f) => f.summary)).toEqual([
      "Drop-frame timecode at 25 fps, where no frames are dropped",
      "Continuous from 10:00:00;00",
    ]);
  });

  it("notes a picture with no timecode, or no frame rate to count one with", () => {
    const none = new TimecodeChecks(video);
    none.push(log([null, null]));
    expect(none.finish()).toMatchObject([
      { severity: "info", summary: "No timecode: counted from 00:00:00:00" },
    ]);
    const { fps: _, ...noRate } = video;
    expect(new TimecodeChecks(noRate).finish()).toMatchObject([
      {
        severity: "info",
        summary: "The frame rate is not known, so the timecode cannot be counted",
      },
    ]);
  });
});

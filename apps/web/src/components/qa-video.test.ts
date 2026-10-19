import type { QaFinding } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { filmstripFrame } from "./filmstrip";
import { deliveryChecklist, framesToLookAt, streamLines } from "./qa-video";

const finding = (
  check: QaFinding["check"],
  severity: QaFinding["severity"],
  start: number | null = null,
): QaFinding => ({
  check,
  severity,
  summary: check,
  channel: null,
  start,
  end: start,
  details: {},
});

describe("a video's QA (#42)", () => {
  it("lists each delivery check once, at its worst, and nothing measured", () => {
    const list = deliveryChecklist([
      finding("black-frames", "warn", 3),
      finding("picture-format", "pass"),
      finding("dead-channel", "fail"),
      finding("dead-channel", "pass"),
      finding("loudness", "warn"),
    ]);
    expect(list.map((f) => [f.check, f.severity])).toEqual([
      ["picture-format", "pass"],
      ["dead-channel", "fail"],
      ["loudness", "warn"],
    ]);
  });

  it("picks the frames worth a look: problems with a time, one per moment, in order", () => {
    const frames = framesToLookAt([
      finding("flashing", "warn", 10),
      finding("black-frames", "info", 0),
      finding("frozen-frames", "warn", 4),
      finding("letterbox", "info"),
      finding("dropped-frames", "pass", 2),
      finding("broadcast-levels", "warn", 4.01),
    ]);
    expect(frames.map((f) => f.check)).toEqual(["black-frames", "frozen-frames", "flashing"]);
    const many = Array.from({ length: 12 }, (_, i) => finding("black-frames", "warn", i));
    expect(framesToLookAt(many)).toHaveLength(8);
  });

  it("says each stream as a delivery sheet does", () => {
    expect(
      streamLines(
        {
          format: "mov,mp4,m4a,3gp,3g2,mj2",
          video: {
            codec: "prores",
            profile: "HQ",
            width: 1920,
            height: 1080,
            fps: 25,
            scan: "progressive",
            primaries: "bt709",
            range: "limited",
            timecode: "10:00:00:00",
          },
          audio: { codec: "pcm_s24le", channels: 2, sampleRate: 48_000, bitDepth: 24 },
        },
        { byteSize: 2_000_000, contentType: "video/quicktime" },
      ),
    ).toEqual([
      ["Video", "ProRes HQ · 1920 × 1080 · 25 fps · progressive · Rec. 709 · limited range"],
      ["Audio", "pcm_s24le · 48 kHz · 24-bit · stereo"],
      ["Timecode", "10:00:00:00 · 25 fps non-drop"],
      ["Container", "QuickTime · 2.0 MB"],
    ]);
    expect(
      streamLines(
        { format: "matroska,webm", video: { codec: "h264", width: 640, height: 360 } },
        { byteSize: 10, contentType: "application/octet-stream" },
      ),
    ).toEqual([
      ["Video", "H.264 · 640 × 360"],
      ["Audio", "None"],
      ["Container", "MATROSKA · 10 B"],
    ]);
  });

  it("finds a moment's frame on the filmstrip", () => {
    expect(filmstripFrame(0, 60, 30)).toBe(0);
    expect(filmstripFrame(30, 60, 30)).toBe(15);
    expect(filmstripFrame(60, 60, 30)).toBe(29);
    expect(filmstripFrame(5, 0, 30)).toBe(0);
  });
});

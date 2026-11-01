import { describe, expect, it } from "vitest";
import { anchor, parseBars } from "./anchor.ts";
import {
  audioCodecName,
  containerName,
  formatAnchor,
  formatClock,
  formatSpan,
  formatTimecode,
  mediaFormat,
} from "./format.ts";
import { allowsAnchor } from "./profile.ts";

describe("anchor schema", () => {
  it("accepts each anchor kind and nothing else", () => {
    expect(anchor.parse({ kind: "time", start: 271.25, end: 271.25 }).kind).toBe("time");
    expect(
      anchor.parse({ kind: "region", page: 7, x: 0.1, y: 0.1, width: 0.2, height: 0.1 }).kind,
    ).toBe("region");
    // An upbeat is bar 0.
    expect(anchor.safeParse({ kind: "bar", from: { bar: 0 } }).success).toBe(true);
    expect(anchor.safeParse({ kind: "bar", from: { bar: -1 } }).success).toBe(false);
    expect(anchor.parse({ kind: "bar", from: { bar: 112 } })).toEqual({
      kind: "bar",
      from: { bar: 112, beat: 1 },
    });
    expect(anchor.safeParse({ kind: "section", sectionId: "mvt-1" }).success).toBe(false);
  });

  it("rejects inverted ranges and regions outside the frame", () => {
    expect(anchor.safeParse({ kind: "time", start: 10, end: 5 }).success).toBe(false);
    expect(anchor.safeParse({ kind: "bar", from: { bar: 124 }, to: { bar: 118 } }).success).toBe(
      false,
    );
    expect(
      anchor.safeParse({ kind: "region", x: 0.9, y: 0, width: 0.2, height: 0.1 }).success,
    ).toBe(false);
  });
});

describe("formatting", () => {
  it("writes media positions one way, to the millisecond (#645)", () => {
    expect(formatClock(12)).toBe("0:12.000");
    expect(formatClock(271.25)).toBe("4:31.250");
    expect(formatClock(3871.25)).toBe("1:04:31.250");
    expect(formatClock(-1)).toBe("0:00.000");
    expect(formatSpan(12, 15.5)).toBe("0:12.000–0:15.500");
    expect(formatSpan(12, 12)).toBe("0:12.000");
    expect(formatTimecode(72.32, 25)).toBe("00:01:12:08");
  });

  it("writes anchors in sentence case, ranges with an en dash, a page once (#702)", () => {
    expect(formatAnchor({ kind: "bar", from: { bar: 112, beat: 1 } })).toBe("Bar 112");
    expect(formatAnchor({ kind: "bar", from: { bar: 112, beat: 3 } })).toBe("Bar 112.3");
    expect(formatAnchor({ kind: "bar", from: { bar: 118, beat: 1 }, to: { bar: 124 } })).toBe(
      "Bars 118–124",
    );
    expect(formatAnchor({ kind: "bar", page: 3, from: { bar: 5, beat: 1 } })).toBe("p. 3 · bar 5");
    expect(formatAnchor({ kind: "time", start: 72.32, end: 72.32, frame: 1808 }, { fps: 25 })).toBe(
      "00:01:12:08 · frame 1808",
    );
    expect(formatAnchor({ kind: "time", start: 14.3, end: 15.1 })).toBe("0:14.300–0:15.100");
    // A region is where it is: the kind adds nothing.
    expect(formatAnchor({ kind: "region", page: 7, x: 0.1, y: 0.2, width: 0.3, height: 0.1 })).toBe(
      "p. 7",
    );
    expect(formatAnchor({ kind: "region", page: 7, x: 0, y: 0, width: 1, height: 1 })).toBe("p. 7");
    expect(formatAnchor({ kind: "region", x: 0.1, y: 0.1, width: 0.5, height: 0.5 })).toBe(
      "Region",
    );
    expect(formatAnchor({ kind: "region", at: 12, x: 0, y: 0, width: 1, height: 1 })).toBe(
      "0:12.000",
    );
  });
});

describe("profiles", () => {
  it("limits bar anchors to music projects", () => {
    expect(allowsAnchor("music", "bar")).toBe(true);
    expect(allowsAnchor("video", "bar")).toBe(false);
  });
});

import { atLeast } from "./organisation.ts";

describe("organisation roles", () => {
  it("ranks owner over admin over member", () => {
    expect(atLeast("owner", "admin")).toBe(true);
    expect(atLeast("admin", "admin")).toBe(true);
    expect(atLeast("member", "admin")).toBe(false);
  });
});

describe("parseBars", () => {
  it("reads a bar or a range as people type them", () => {
    expect(parseBars("25")).toEqual({ from: { bar: 25, beat: 1 } });
    expect(parseBars(" 0 ")).toEqual({ from: { bar: 0, beat: 1 } });
    expect(parseBars("9-12")).toEqual({ from: { bar: 9, beat: 1 }, to: { bar: 12 } });
    expect(parseBars("9–12")).toEqual({ from: { bar: 9, beat: 1 }, to: { bar: 12 } });
    expect(parseBars("bars 9 to 12")).toEqual({ from: { bar: 9, beat: 1 }, to: { bar: 12 } });
    expect(parseBars("12-12")).toEqual({ from: { bar: 12, beat: 1 } });
  });
  it("refuses what is not a bar", () => {
    for (const text of ["", "x", "12-9", "-3", "2.5", "9-", "1234567"]) {
      expect(parseBars(text)).toBeNull();
    }
  });
  it("keeps where in the recording a bar was named", () => {
    expect(anchor.parse({ kind: "bar", from: { bar: 25 }, at: 21.4 })).toMatchObject({ at: 21.4 });
    expect(anchor.safeParse({ kind: "bar", from: { bar: 25 }, at: -1 }).success).toBe(false);
  });
});

describe("a file's format in words (#635)", () => {
  it("names codecs as people say them, never by ffmpeg's id", () => {
    expect(audioCodecName("pcm_s16le")).toBe("PCM 16-bit");
    expect(audioCodecName("pcm_f32le")).toBe("PCM 32-bit float");
    expect(audioCodecName("eac3")).toBe("Dolby Digital Plus");
    expect(audioCodecName("wavpack")).toBe("WAVPACK");
  });

  it("names a container by its type, never a MIME type", () => {
    expect(containerName("wav", "audio/wav")).toBe("WAV");
    expect(containerName("mov,mp4,m4a,3gp,3g2,mj2", "video/quicktime")).toBe("QuickTime");
    expect(containerName("matroska,webm", "application/octet-stream")).toBe("MATROSKA");
  });

  it("says a recording's and a video's format in one line", () => {
    expect(
      mediaFormat({
        audio: { codec: "pcm_s16le", channels: 2, sampleRate: 44_100, bitDepth: 16 },
        duration: 40,
      }),
    ).toBe("PCM 16-bit · 44.1 kHz · stereo");
    expect(
      mediaFormat({
        video: { codec: "h264", width: 1280, height: 720, fps: 25 },
        audio: { codec: "aac", channels: 2, sampleRate: 48_000 },
      }),
    ).toBe("1280 × 720 · 25 fps · AAC · 48 kHz · stereo");
    expect(mediaFormat(null)).toBeNull();
  });
});

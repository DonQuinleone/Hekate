import { describe, expect, it } from "vitest";
import { cleanContentType, fileKindOf, fileName } from "./files.ts";
import { formatBytes, formatChannels, formatDuration } from "./format.ts";

describe("files", () => {
  it("knows a file's kind from its name first, then its type", () => {
    expect(fileKindOf("Take 4.wav", "application/octet-stream")).toBe("audio");
    expect(fileKindOf("Reel 2 v3.MOV", "")).toBe("video");
    expect(fileKindOf("Full score.pdf", "application/octet-stream")).toBe("document");
    expect(fileKindOf("Score.musicxml", "")).toBe("document");
    expect(fileKindOf("cover", "image/png")).toBe("image");
    expect(fileKindOf("recording", "audio/x-wav")).toBe("audio");
    expect(fileKindOf("notes", "text/plain")).toBe("document");
    expect(fileKindOf("archive.zip", "application/zip")).toBe("other");
  });

  it("reduces content types to a safe type/subtype", () => {
    expect(cleanContentType("audio/wav; codecs=1")).toBe("audio/wav");
    expect(cleanContentType("Video/QuickTime")).toBe("video/quicktime");
    expect(cleanContentType("text/html\r\nX-Injected: 1")).toBe("application/octet-stream");
    expect(cleanContentType(undefined)).toBe("application/octet-stream");
  });

  it("keeps only a file's own name", () => {
    expect(fileName.parse("C:\\Sessions\\Day 2\\Take 4.wav")).toBe("Take 4.wav");
    expect(fileName.parse("../../etc/passwd")).toBe("passwd");
    expect(fileName.parse("Mix\u0000\u0007 final.wav")).toBe("Mix final.wav");
    expect(fileName.safeParse("   ").success).toBe(false);
  });
});

describe("formatting for lists", () => {
  it("formats sizes like an operating system", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1500)).toBe("1.5 KB");
    expect(formatBytes(412_300_000)).toBe("412 MB");
    expect(formatBytes(1_340_000_000)).toBe("1.3 GB");
  });

  it("formats durations to the second", () => {
    expect(formatDuration(0.4)).toBe("0:00");
    expect(formatDuration(271.2)).toBe("4:31");
    expect(formatDuration(3723)).toBe("1:02:03");
  });

  it("names channel layouts as engineers say them", () => {
    expect(formatChannels(1)).toBe("mono");
    expect(formatChannels(2, "stereo")).toBe("stereo");
    expect(formatChannels(6, "5.1(side)")).toBe("5.1");
    expect(formatChannels(8, "7.1")).toBe("7.1");
    expect(formatChannels(12, "7.1.4")).toBe("7.1.4");
    expect(formatChannels(6, "6 channels")).toBe("6 ch");
    expect(formatChannels(4)).toBe("4 ch");
  });
});

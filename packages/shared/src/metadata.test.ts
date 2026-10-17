import { describe, expect, it } from "vitest";
import { metadataRows, timecodeOf } from "./metadata.ts";

describe("embedded metadata as people read it (#41)", () => {
  it("writes a time reference as timecode, with frames where the rate is known", () => {
    const tenHours = 10 * 3600 * 48_000;
    expect(timecodeOf(tenHours, 48_000)).toBe("10:00:00");
    expect(timecodeOf(tenHours + 24_000, 48_000, "25/1")).toBe("10:00:00:12");
    expect(timecodeOf(tenHours + 47_999, 48_000, "30000/1001")).toBe("10:00:00:29");
    // A rate that makes no sense is left out.
    expect(timecodeOf(tenHours, 48_000, "0/0")).toBe("10:00:00");
  });

  it("lists the bext, iXML and tags a file has, and always its ISRC and artwork", () => {
    expect(
      metadataRows(
        {
          bext: {
            description: "Maple Leaf Rag, V2 dry",
            originator: "Endless Hall Records",
            originationDate: "2026-10-14",
            originationTime: "09:58:00",
            timeReference: 10 * 3600 * 96_000,
            codingHistory: "A=PCM,F=96000,W=24,M=stereo\r\nA=PCM,F=48000,W=24,M=stereo\r\n",
          },
          ixml: { bytes: 1200, scene: "12", take: "3", timecodeRate: "25/1" },
          tags: { title: "Maple Leaf Rag", artist: "Endless Hall Records" },
          artwork: { codec: "mjpeg", width: 1500, height: 1500 },
        },
        96_000,
      ),
    ).toEqual([
      ["Description", "Maple Leaf Rag, V2 dry"],
      ["Originator", "Endless Hall Records"],
      ["Origination", "2026-10-14 09:58"],
      ["Time reference", "10:00:00:00"],
      ["Coding history", "A=PCM,F=96000,W=24,M=stereo · A=PCM,F=48000,W=24,M=stereo"],
      ["iXML", "1.2 KB embedded"],
      ["Scene", "12"],
      ["Take", "3"],
      ["Title", "Maple Leaf Rag"],
      ["Artist", "Endless Hall Records"],
      ["ISRC", "none"],
      ["Artwork", "JPEG 1500 × 1500"],
    ]);
    expect(metadataRows({ tags: { isrc: "GBEHR2600001" } }, undefined)).toEqual([
      ["ISRC", "GBEHR2600001"],
      ["Artwork", "none"],
    ]);
  });
});

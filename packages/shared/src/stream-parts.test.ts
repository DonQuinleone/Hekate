import { describe, expect, it } from "vitest";
import { isFollowingPart, losslessPartIndex, losslessParts } from "./stream-parts.ts";

describe("a recording's lossless streams (#74)", () => {
  it("carries up to eight channels in one stream", () => {
    expect(losslessParts(2)).toEqual([{ name: "flac", from: 0, count: 2 }]);
    expect(losslessParts(8)).toEqual([{ name: "flac", from: 0, count: 8 }]);
  });

  it("carries a wider layout in parts of eight, in its own order", () => {
    expect(losslessParts(12)).toEqual([
      { name: "flac", from: 0, count: 8 },
      { name: "flac-2", from: 8, count: 4 },
    ]);
    expect(losslessParts(16).map((p) => [p.name, p.from, p.count])).toEqual([
      ["flac", 0, 8],
      ["flac-2", 8, 8],
    ]);
    expect(losslessParts(17).at(-1)).toEqual({ name: "flac-3", from: 16, count: 1 });
  });

  it("knows each part by its name, and nothing else as one", () => {
    expect(losslessPartIndex("flac")).toBe(0);
    expect(losslessPartIndex("flac-2")).toBe(1);
    expect(losslessPartIndex("flac-3")).toBe(2);
    expect(losslessPartIndex("flac-1")).toBeNull();
    expect(losslessPartIndex("aac-256")).toBeNull();
    expect(isFollowingPart("flac-2")).toBe(true);
    expect(isFollowingPart("flac")).toBe(false);
    expect(isFollowingPart("eac3")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import type { Playback, Rendition } from "~/lib/queries";
import { partPlaylist } from "./stream-part";

describe("a wide layout's later channels (#74)", () => {
  it("play from their own playlist, beside the master they are left out of", () => {
    const part: Rendition = {
      id: "r2",
      name: "flac-2",
      codecs: "fLaC",
      bandwidth: 4_608_000,
      width: null,
      height: null,
    };
    const playback: Playback = {
      url: "/api/play/abc.def/master.m3u8",
      expiresAt: "2026-10-19T18:00:00Z",
      renditions: [part],
    };
    expect(partPlaylist(playback, part)).toBe("/api/play/abc.def/r/r2/index.m3u8");
  });
});

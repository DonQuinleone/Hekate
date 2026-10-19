import { describe, expect, it } from "vitest";
import type { Playback, Rendition } from "~/lib/queries";
import { nativeSource, renditionPlaylist, wholeRendition } from "./stream-part";

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
    expect(renditionPlaylist(playback, part)).toBe("/api/play/abc.def/r/r2/index.m3u8");
  });

  const rendition = (id: string, name: string): Rendition => ({
    id,
    name,
    codecs: name.startsWith("flac") ? "fLaC" : "mp4a.40.2",
    bandwidth: 1,
    width: null,
    height: null,
  });
  const aac = rendition("r0", "aac-256");
  const flac = rendition("r1", "flac");
  const flac2 = rendition("r2", "flac-2");
  const at = (renditions: Rendition[]): Playback => ({
    url: "/api/play/abc.def/master.m3u8",
    expiresAt: "2026-10-19T18:00:00Z",
    renditions,
  });

  it("play whole as the AAC where only one element plays them", () => {
    expect(wholeRendition([aac, flac, flac2])).toBe(aac);
    expect(nativeSource(at([aac, flac, flac2]))).toBe("/api/play/abc.def/r/r0/index.m3u8");
  });

  it("leave a layout of eight channels or fewer on its lossless stream and the master", () => {
    expect(wholeRendition([aac, flac])).toBe(flac);
    expect(nativeSource(at([aac, flac]))).toBe("/api/play/abc.def/master.m3u8");
  });
});

import { describe, expect, it } from "vitest";
import type { Rendition } from "~/lib/queries";
import { audioBuffer, preferredRendition, renditionLabel } from "./player";

const rendition = (name: string, extra: Partial<Rendition> = {}): Rendition => ({
  id: name,
  name,
  codecs: "",
  bandwidth: 0,
  width: null,
  height: null,
  ...extra,
});

describe("player", () => {
  it("names renditions in a reviewer's words", () => {
    const surround = {
      audio: {
        codec: "pcm_s24le",
        channels: 6,
        channelLayout: "5.1(side)",
        sampleRate: 96000,
        bitDepth: 24,
      },
    };
    expect(renditionLabel(rendition("flac"), surround)).toBe("Lossless · 96 kHz · 24-bit · 5.1");
    expect(renditionLabel(rendition("aac-256"), surround)).toBe("AAC · stereo");
    expect(
      renditionLabel(rendition("eac3"), {
        audio: { codec: "eac3", channels: 8, channelLayout: "7.1", sampleRate: 48000 },
      }),
    ).toBe("Dolby Digital Plus · 7.1");
    expect(renditionLabel(rendition("720p", { height: 720 }), null)).toBe("720p");
  });

  it("starts audio on the original Dolby stream, then lossless", () => {
    expect(preferredRendition([rendition("aac-256"), rendition("flac")])?.name).toBe("flac");
    expect(
      preferredRendition([rendition("aac-256"), rendition("flac"), rendition("eac3")])?.name,
    ).toBe("eac3");
    expect(preferredRendition([rendition("aac-256")])?.name).toBe("aac-256");
    expect(preferredRendition([rendition("1080p")])).toBeUndefined();
  });

  it("reads ahead less on heavy audio, to stay inside the browser's buffer", () => {
    // 96 kHz, 24-bit, 5.1 lossless.
    expect(audioBuffer([rendition("flac", { bandwidth: 13_824_000 })]).maxBufferLength).toBe(6);
    // 48 kHz, 24-bit stereo lossless.
    expect(audioBuffer([rendition("flac", { bandwidth: 2_304_000 })]).maxBufferLength).toBe(20);
    expect(audioBuffer([rendition("aac-256", { bandwidth: 300_000 })]).maxBufferLength).toBe(30);
  });
});

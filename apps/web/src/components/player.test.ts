import { describe, expect, it } from "vitest";
import type { Rendition } from "~/lib/queries";
import { audioBuffer, playerViewOf, preferredRendition, renditionLabel } from "./player";

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
    // 96 kHz, 24-bit, 5.1 lossless: the least read-ahead, a byte cap, nothing kept behind.
    expect(audioBuffer([rendition("flac", { bandwidth: 13_824_000 })])).toEqual({
      maxBufferSize: 6_000_000,
      maxBufferLength: 6,
      maxMaxBufferLength: 6,
      backBufferLength: 0,
    });
    // 48 kHz, 24-bit stereo lossless.
    expect(audioBuffer([rendition("flac", { bandwidth: 2_304_000 })]).maxBufferLength).toBe(20);
    expect(audioBuffer([rendition("aac-256", { bandwidth: 300_000 })])).toMatchObject({
      maxBufferLength: 30,
      backBufferLength: 10,
    });
  });
});

describe("the player's view", () => {
  it("reads what a browser kept before the spectrogram had a place of its own (#135)", () => {
    expect(playerViewOf({ split: true, spectrogram: true, placement: "behind" }, false)).toEqual({
      split: true,
      wave: { colour: "ink", opacity: 0.5, height: 0.32 },
      spectrogram: "behind",
    });
    expect(playerViewOf({ spectrogram: true }, false).spectrogram).toBe("below");
    expect(playerViewOf({ spectrogram: false, placement: "instead" }, false).spectrogram).toBe(
      "off",
    );
  });

  it("keeps a look within its range and falls back where it cannot read one", () => {
    const view = playerViewOf(
      { spectrogram: "instead", wave: { colour: "warm", opacity: 4, height: 0.01 } },
      false,
    );
    expect(view).toEqual({
      split: false,
      wave: { colour: "warm", opacity: 1, height: 0.15 },
      spectrogram: "instead",
    });
    expect(
      playerViewOf({ spectrogram: "sideways", wave: { colour: "plaid" } }, false),
    ).toMatchObject({ spectrogram: "off", wave: { colour: "ink" } });
    // Nothing kept yet: the member's own choice of split channels.
    expect(playerViewOf(null, true).split).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import {
  channelLabels,
  fileLayout,
  layoutChannels,
  layoutFromLabels,
  layoutLabel,
  layoutsWithLfe,
  lfeChannels,
} from "./layouts.ts";
import type { MediaInfo } from "./media.ts";

const audio = (channels: number, channelLayout?: string): MediaInfo => ({
  audio: { codec: "pcm_s24le", channels, sampleRate: 48_000, bitDepth: 24, channelLayout },
});

describe("channel layouts (#74)", () => {
  it("reads ffmpeg's layouts, named or spelt out, and only where they fit the channels", () => {
    expect(channelLabels("5.1(side)", 6)).toEqual(["FL", "FR", "FC", "LFE", "SL", "SR"]);
    expect(channelLabels("FL+FR+FC+LFE", 4)).toEqual(["FL", "FR", "FC", "LFE"]);
    expect(channelLabels("5.1", 2)).toBeNull();
    expect(channelLabels("6 channels", 6)).toBeNull();
    expect(channelLabels(undefined, 2)).toBeNull();
  });

  it("names a layout by its main, LFE and height channels", () => {
    expect(layoutFromLabels(["FC"])).toBe("1.0");
    expect(
      layoutFromLabels([
        "FL",
        "FR",
        "FC",
        "LFE",
        "BL",
        "BR",
        "SL",
        "SR",
        "TFL",
        "TFR",
        "TBL",
        "TBR",
      ]),
    ).toBe("7.1.4");
    expect(layoutFromLabels(["FL", "FR", "FC", "BL", "BR", "BC"])).toBe("6.0");
    expect(layoutChannels("7.1.4")).toBe(12);
    expect(layoutLabel("2.0")).toBe("Stereo");
    expect(layoutLabel("5.1")).toBe("5.1");
  });

  it("takes an ADM master's bed before what ffmpeg reports, and finds the LFE in either", () => {
    expect(fileLayout(audio(6, "5.1(side)"))).toBe("5.1");
    expect(fileLayout(audio(6))).toBeNull();
    expect(lfeChannels(audio(3, "2.1"))).toEqual([2]);
    expect(lfeChannels(audio(12, "7.1.4"))).toEqual([3]);
    expect(lfeChannels(audio(2, "stereo"))).toEqual([]);
    const adm: MediaInfo = {
      ...audio(14, "14 channels"),
      metadata: {
        tags: {},
        adm: { bytes: 900, bed: 10, layout: "7.1.2", objects: 4, lfe: [3], dolby: true },
      },
    };
    expect(fileLayout(adm)).toBe("7.1.2");
    expect(lfeChannels(adm)).toEqual([3]);
    expect(layoutsWithLfe).toContain("5.1(side)");
    expect(layoutsWithLfe).not.toContain("stereo");
  });
});

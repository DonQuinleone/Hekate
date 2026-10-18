import { describe, expect, it } from "vitest";
import {
  canBinaural,
  channelGains,
  downmixGains,
  isPlain,
  mixLabel,
  mixUnavailable,
  panPosition,
  plainMix,
  speakerDirection,
  speakerNames,
} from "./channel-mix";

const fiveOne = ["FL", "FR", "FC", "LFE", "SL", "SR"];
const sevenOne = ["FL", "FR", "FC", "LFE", "BL", "BR", "SL", "SR"];

describe("hearing a recording's channels (#74)", () => {
  it("names each speaker as engineers do", () => {
    expect(speakerNames(fiveOne, 6)).toEqual(["L", "R", "C", "LFE", "Ls", "Rs"]);
    expect(speakerNames(["FL", "FR", "FC", "LFE", "BL", "BR"], 6)).toEqual([
      "L",
      "R",
      "C",
      "LFE",
      "Ls",
      "Rs",
    ]);
    expect(speakerNames(sevenOne, 8)).toEqual(["L", "R", "C", "LFE", "Lrs", "Rrs", "Lss", "Rss"]);
    // A file that does not say how it is laid out: a pair is left and right, wider is numbered.
    expect(speakerNames(null, 2)).toEqual(["L", "R"]);
    expect(speakerNames(null, 3)).toEqual(["1", "2", "3"]);
  });

  it("folds surround down to stereo as BS.775 does, the LFE left out, never above full scale", () => {
    const gains = downmixGains(fiveOne);
    const half = Math.SQRT1_2;
    // L + C + Ls on the left: 1 + 0.707 + 0.707, scaled to sum to one.
    const sum = 1 + 2 * half;
    expect(gains[0]?.left).toBeCloseTo(1 / sum);
    expect(gains[0]?.right).toBe(0);
    expect(gains[2]?.left).toBeCloseTo(half / sum);
    expect(gains[2]?.right).toBeCloseTo(half / sum);
    expect(gains[3]).toEqual({ left: 0, right: 0 });
    expect(gains[5]?.right).toBeCloseTo(half / sum);
    for (const side of ["left", "right"] as const)
      expect(gains.reduce((total, g) => total + g[side], 0)).toBeCloseTo(1);
    // A stereo pair passes as it is.
    expect(downmixGains(["FL", "FR"])).toEqual([
      { left: 1, right: 0 },
      { left: 0, right: 1 },
    ]);
  });

  it("silences all but a soloed channel, and each muted one", () => {
    expect(channelGains(4, plainMix)).toEqual([1, 1, 1, 1]);
    expect(channelGains(4, { ...plainMix, solo: 2 })).toEqual([0, 0, 1, 0]);
    expect(channelGains(4, { ...plainMix, muted: [0, 3] })).toEqual([0, 1, 1, 0]);
  });

  it("says what is heard, and only when it is not the recording as it plays", () => {
    const names = speakerNames(fiveOne, 6);
    expect(isPlain(plainMix)).toBe(true);
    expect(mixLabel(plainMix, names)).toBeNull();
    expect(mixLabel({ ...plainMix, solo: 2 }, names)).toBe("Solo C");
    expect(mixLabel({ ...plainMix, muted: [3], downmix: true }, names)).toBe(
      "LFE muted, stereo downmix",
    );
  });

  it("hears a wide file apart only in the lossless stream, and only up to eight channels", () => {
    expect(mixUnavailable(2, "aac-256")).toBeUndefined();
    expect(mixUnavailable(6, "flac")).toBeUndefined();
    expect(mixUnavailable(6, "aac-256")).toMatch(/stereo downmix: choose Lossless/);
    expect(mixUnavailable(6, "eac3")).toMatch(/Dolby stream/);
    expect(mixUnavailable(12, "flac")).toMatch(/12 channels; a browser plays up to 8/);
  });

  it("places each speaker around the listener for a binaural render, the LFE nowhere", () => {
    expect(speakerDirection("FL", fiveOne)).toEqual({ azimuth: 30, elevation: 0 });
    // 5.1's surrounds at 110°; 7.1's sides at 90° and rears at 135°.
    expect(speakerDirection("SR", fiveOne)).toEqual({ azimuth: -110, elevation: 0 });
    expect(speakerDirection("SL", sevenOne)).toEqual({ azimuth: 90, elevation: 0 });
    expect(speakerDirection("BL", sevenOne)).toEqual({ azimuth: 135, elevation: 0 });
    expect(speakerDirection("TFL", [...sevenOne, "TFL"])).toEqual({ azimuth: 45, elevation: 30 });
    expect(speakerDirection("LFE", fiveOne)).toBeNull();
    expect(speakerDirection("WL", [...sevenOne, "WL", "WR"])).toEqual({
      azimuth: 60,
      elevation: 0,
    });
    // Offered only where every channel is an LFE or has a place.
    expect(canBinaural(fiveOne)).toBe(true);
    expect(canBinaural([...sevenOne, "LFE2"])).toBe(true);
    expect(canBinaural(["FL", "FR", "FC", "XQ"])).toBe(false);
    expect(canBinaural(null)).toBe(false);
    // Web Audio faces −z with x to the right: the centre ahead, the left to the left, the top up.
    expect(panPosition({ azimuth: 0, elevation: 0 })).toEqual({ x: 0, y: 0, z: -1 });
    expect(panPosition({ azimuth: 90, elevation: 0 })).toEqual({ x: -1, y: 0, z: 0 });
    expect(panPosition({ azimuth: 0, elevation: 90 })).toMatchObject({ y: 1 });
  });

  it("says when it is heard binaurally", () => {
    expect(mixLabel({ ...plainMix, binaural: true }, speakerNames(fiveOne, 6))).toBe("Binaural");
    expect(isPlain({ ...plainMix, binaural: true })).toBe(false);
  });
});

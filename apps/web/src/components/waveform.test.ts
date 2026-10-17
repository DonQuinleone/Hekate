import { defaultWaveLook } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { toChannelArrays, waveStyle } from "./waveform";

describe("waveform", () => {
  it("splits interleaved peaks into one min/max series per channel", () => {
    const [left, right] = toChannelArrays({
      channels: 2,
      sampleRate: 48000,
      samplesPerPeak: 256,
      count: 2,
      data: Int8Array.from([-127, 127, -64, 0, 0, 127, -127, 64]),
    });
    expect(Array.from(left ?? [])).toEqual([-1, 1, 0, 1]);
    expect(Array.from(right ?? []).map((v) => Math.round(v * 100) / 100)).toEqual([
      -0.5, 0, -1, 0.5,
    ]);
  });
});

describe("the waveform's look (#135)", () => {
  it("draws the default as it always was: the rest dim, the played part brighter, full scale", () => {
    expect(waveStyle(defaultWaveLook, "#f4f4f5", false)).toEqual({
      waveColor: "rgba(244, 244, 245, 0.15)",
      progressColor: "rgba(244, 244, 245, 0.5)",
      barHeight: 1,
    });
  });

  it("follows brightness and height, a little brighter over a spectrogram", () => {
    const style = waveStyle({ colour: "cool", opacity: 1, height: 0.64 }, "#7cc1e9", true);
    expect(style.progressColor).toBe("rgba(124, 193, 233, 1)");
    expect(style.waveColor).toBe("rgba(124, 193, 233, 0.56)");
    expect(style.barHeight).toBe(2);
  });
});

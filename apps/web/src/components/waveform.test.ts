import { describe, expect, it } from "vitest";
import { toChannelArrays } from "./waveform";

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

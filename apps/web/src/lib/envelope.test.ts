import { describe, expect, it } from "vitest";
import { envelopeColumns, envelopeOutline } from "./envelope";

describe("the waveform over the spectrogram (#495)", () => {
  it("keeps the widest swing of the peaks that fall in each column", () => {
    // Four peaks into two columns: each column takes the lowest min and highest max of its two.
    const peaks = Float32Array.from([-0.2, 0.3, -0.9, 0.1, -0.1, 0.8, -0.4, 0.2]);
    expect(Array.from(envelopeColumns(peaks, 2))).toEqual(
      [-0.9, 0.3, -0.4, 0.8].map((v) => Math.fround(v)),
    );
  });

  it("repeats a peak across the columns it spans, and draws nothing from nothing", () => {
    const peaks = Float32Array.from([-0.5, 0.5, -1, 1]);
    expect(Array.from(envelopeColumns(peaks, 4))).toEqual([-0.5, 0.5, -0.5, 0.5, -1, 1, -1, 1]);
    expect(Array.from(envelopeColumns(new Float32Array(0), 3))).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("outlines the envelope within its lane: the top edge out, the bottom edge back", () => {
    const envelope = Float32Array.from([-0.5, 0.5, -2, 2]);
    const outline = envelopeOutline(envelope, 50, 40, 50);
    expect(outline).toEqual([
      { x: 0, y: 30 },
      // Over full scale is held to the lane's edge.
      { x: 1, y: 0 },
      { x: 1, y: 100 },
      { x: 0, y: 70 },
    ]);
    // Silence is still a hairline through the middle.
    expect(envelopeOutline(Float32Array.from([0, 0]), 50, 40, 50)).toEqual([
      { x: 0, y: 49.5 },
      { x: 0, y: 50.5 },
    ]);
  });
});

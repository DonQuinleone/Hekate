import { decodeLoudness, encodeLoudness, type LoudnessSeries, SILENCE } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { pairNames, phaseAt } from "./phase";

/** Two frames of a three-channel recording, every pair kept. */
const series = (hasPairs: boolean): LoudnessSeries =>
  decodeLoudness(
    encodeLoudness({
      channels: 3,
      sampleRate: 48_000,
      samplesPerFrame: 4_800,
      count: 2,
      hasPhase: true,
      momentary: Float32Array.from([SILENCE, SILENCE]),
      shortTerm: Float32Array.from([SILENCE, SILENCE]),
      peak: new Float32Array(6).fill(SILENCE),
      rms: new Float32Array(6).fill(SILENCE),
      phase: Float32Array.from([0.9, 0.8]),
      hasMidSide: false,
      mid: new Float32Array(0),
      side: new Float32Array(0),
      hasField: false,
      field: new Float32Array(0),
      hasPairs,
      pairs: hasPairs ? Float32Array.from([0.9, 0.5, -0.2, 0.8, 0.4, -0.3]) : new Float32Array(0),
    }),
  );

describe("phase between any two channels", () => {
  it("names each pair by its speakers", () => {
    expect(pairNames(3, ["L", "R", "C"])).toEqual(["L–R", "L–C", "R–C"]);
    expect(pairNames(3, [])).toEqual(["1–2", "1–3", "2–3"]);
  });

  it("reads the chosen pair at a frame, or the front pair where pairs were not kept", () => {
    expect(phaseAt(series(true), 1, 2)).toBeCloseTo(-0.3, 4);
    expect(phaseAt(series(true), 0, 1)).toBeCloseTo(0.5, 4);
    expect(phaseAt(series(false), 1, 2)).toBeCloseTo(0.8, 4);
    expect(phaseAt(series(true), null, 2)).toBe(0);
  });
});

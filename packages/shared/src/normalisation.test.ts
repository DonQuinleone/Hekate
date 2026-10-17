import { describe, expect, it } from "vitest";
import {
  effectiveNormalisation,
  normalisationLabel,
  normalisedGain,
  trackNormalisationInput,
} from "./normalisation.ts";

describe("normalised playback", () => {
  it("turns a loud recording down to the target", () => {
    // 6 dB over the target is about half the amplitude.
    expect(normalisedGain(-10, -16)).toBeCloseTo(0.501, 3);
    expect(normalisedGain(-16, -16)).toBe(1);
  });

  it("never turns a quiet recording up, and leaves an unmeasured one as it is", () => {
    expect(normalisedGain(-23, -16)).toBe(1);
    expect(normalisedGain(Number.NaN, -16)).toBe(1);
  });

  it("says the recording reached the target only when it was turned down to it", () => {
    expect(normalisationLabel({ target: -14, gain: 0.5 })).toBe("Normalised to −14 LUFS");
    expect(normalisationLabel({ target: -14, gain: 1 })).toBe("As it is: at or under −14 LUFS");
  });
});

describe("a track's own normalised playback", () => {
  it("plays as its track chose, else as its project does", () => {
    expect(effectiveNormalisation("forced", "off")).toBe("forced");
    expect(effectiveNormalisation("off", "forced")).toBe("off");
    expect(effectiveNormalisation(null, "optional")).toBe("optional");
    expect(trackNormalisationInput.safeParse({ normalisation: null }).success).toBe(true);
    expect(trackNormalisationInput.safeParse({ normalisation: "loud" }).success).toBe(false);
  });
});

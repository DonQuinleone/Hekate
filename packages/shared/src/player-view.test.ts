import { describe, expect, it } from "vitest";
import { defaultPreferences, preferencesInput, preferencesOf } from "./account.ts";
import { defaultPlayerViewSettings, savePreset, viewPresetsSchema } from "./player-view.ts";
import { analysisKey, analysisOfKey, defaultAnalysis, isDefaultAnalysis } from "./spectrogram.ts";

const view = defaultPlayerViewSettings;

describe("the player's view, kept with the account (#135)", () => {
  it("is none until it is first changed, and an unreadable one is dropped", () => {
    expect(defaultPreferences.playerView).toBeNull();
    expect(preferencesOf({ playerView: view }).playerView).toEqual(view);
    expect(
      preferencesOf({ playerView: { ...view, spectrogram: "sideways" } }).playerView,
    ).toBeNull();
  });

  it("takes a view within its ranges and refuses one outside them", () => {
    expect(preferencesInput.safeParse({ playerView: view }).success).toBe(true);
    expect(preferencesInput.safeParse({ playerView: null }).success).toBe(true);
    const tooFaint = { ...view, wave: { ...view.wave, opacity: 0.05 } };
    expect(preferencesInput.safeParse({ playerView: tooFaint }).success).toBe(false);
    const upsideDown = { ...view, spectrum: { ...view.spectrum, floor: 0, ceiling: -60 } };
    expect(preferencesInput.safeParse({ playerView: upsideDown }).success).toBe(false);
  });

  it("keeps presets under names of their own, a dozen at most", () => {
    const saved = savePreset([], { name: " Edit ", view });
    expect(saved).toEqual([{ name: "Edit", view }]);
    const behind = { ...view, spectrogram: "behind" as const };
    // The same name, however written, replaces it.
    expect(savePreset(saved, { name: "edit", view: behind })).toEqual([
      { name: "edit", view: behind },
    ]);
    expect(viewPresetsSchema.safeParse([...saved, { name: "EDIT", view }]).success).toBe(false);
    const dozen = Array.from({ length: 12 }, (_, i) => ({ name: `View ${i}`, view }));
    expect(viewPresetsSchema.safeParse(dozen).success).toBe(true);
    expect(viewPresetsSchema.safeParse([...dozen, { name: "One more", view }]).success).toBe(false);
  });
});

describe("the spectrogram's analysis settings (#34)", () => {
  it("names each set of settings by a key, and reads only keys it made", () => {
    const blackman = { window: "blackman-harris", fftSize: "16384", overlap: "87.5" } as const;
    expect(analysisKey(blackman)).toBe("blackman-harris/16384/87.5");
    expect(analysisOfKey("blackman-harris/16384/87.5")).toEqual(blackman);
    expect(analysisOfKey(analysisKey(defaultAnalysis))).toEqual(defaultAnalysis);
    expect(isDefaultAnalysis(defaultAnalysis)).toBe(true);
    expect(isDefaultAnalysis(blackman)).toBe(false);
    for (const key of ["hann/auto", "hann/512/75", "hann/auto/75/x", "triangle/auto/75", ""])
      expect(analysisOfKey(key)).toBeNull();
  });

  it("reads a view kept before there was a choice as analysed by default", () => {
    const { analysis: _, ...older } = view.spectrum;
    const kept = preferencesOf({ playerView: { ...view, spectrum: older } }).playerView;
    expect(kept?.spectrum.analysis).toEqual(defaultAnalysis);
    expect(
      preferencesOf({
        playerView: { ...view, spectrum: { ...view.spectrum, analysis: { window: "box" } } },
      }).playerView,
    ).toBeNull();
  });
});

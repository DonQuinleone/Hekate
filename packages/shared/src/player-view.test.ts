import { describe, expect, it } from "vitest";
import { defaultPreferences, preferencesInput, preferencesOf } from "./account.ts";
import { defaultPlayerViewSettings, savePreset, viewPresetsSchema } from "./player-view.ts";

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

import { defaultSpectrumView } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { legacyViewOf } from "./player-view";

describe("the player's view, as a browser kept it before the account did (#135)", () => {
  it("reads a spectrogram switch with its placement, and the spectrogram's settings apart", () => {
    expect(
      legacyViewOf(
        { split: true, spectrogram: true, placement: "behind" },
        { colourMap: "inferno", scale: "mel" },
      ),
    ).toEqual({
      wave: { colour: "ink", opacity: 1, height: 0.32 },
      spectrogram: "behind",
      spectrum: { ...defaultSpectrumView, colourMap: "inferno", scale: "mel" },
      loudness: true,
    });
    expect(legacyViewOf({ spectrogram: true }, null).spectrogram).toBe("below");
    expect(legacyViewOf({ spectrogram: false, placement: "instead" }, null).spectrogram).toBe(
      "off",
    );
  });

  it("keeps a look within its range and falls back where it cannot read one", () => {
    expect(
      legacyViewOf(
        { spectrogram: "instead", wave: { colour: "warm", opacity: 4, height: 0.01 } },
        null,
      ),
    ).toMatchObject({ wave: { colour: "warm", opacity: 1, height: 0.15 }, spectrogram: "instead" });
    // A brightness kept below the floor (#495) comes back at it.
    expect(legacyViewOf({ wave: { colour: "ink", opacity: 0.2, height: 0.5 } }, null).wave).toEqual(
      { colour: "ink", opacity: 0.4, height: 0.5 },
    );
    expect(
      legacyViewOf({ spectrogram: "sideways", wave: { colour: "plaid" } }, null),
    ).toMatchObject({
      spectrogram: "off",
      wave: { colour: "ink" },
    });
    expect(legacyViewOf(null, null).spectrum).toEqual(defaultSpectrumView);
  });

  it("keeps the spectrogram's ranges within what the account keeps", () => {
    const { spectrum } = legacyViewOf(null, { floor: -500, ceiling: 90, low: -5, high: 1e9 });
    expect(spectrum).toMatchObject({ floor: -200, ceiling: 20, low: 0, high: 192_000 });
  });
});

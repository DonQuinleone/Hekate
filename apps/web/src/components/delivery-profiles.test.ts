import { deliveryProfiles } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { layoutChoiceOf, profileSummary } from "./delivery-profiles";

describe("what a profile asks of the channels (#74)", () => {
  it("keeps a profile made before layouts asking for a count, never a layout", () => {
    expect(layoutChoiceOf({ channels: 6 })).toMatchObject({
      label: "6 channels",
      channels: 6,
      layout: null,
      atmos: false,
    });
    expect(layoutChoiceOf({ channels: 6, layout: "5.1" })).toMatchObject({ value: "5.1" });
    expect(layoutChoiceOf({ channels: null, atmos: true })).toMatchObject({ value: "atmos" });
    expect(layoutChoiceOf({ channels: null })).toMatchObject({ label: "Any layout" });
  });

  it("says it in the profile's summary", () => {
    expect(profileSummary(deliveryProfiles.streaming)).toMatch(/· Stereo$/);
    expect(profileSummary(deliveryProfiles.surround)).toMatch(/· 5\.1$/);
    expect(profileSummary(deliveryProfiles.atmos)).toMatch(/· Dolby Atmos \(ADM BWF\)$/);
    expect(profileSummary({ ...deliveryProfiles.surround, layout: null })).toMatch(/· 6 channels$/);
  });
});

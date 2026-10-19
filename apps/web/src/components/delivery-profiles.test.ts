import { deliveryProfiles } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import {
  deliveryHint,
  layoutChoiceOf,
  pictureFields,
  pictureFrom,
  pictureSummary,
  profileSummary,
} from "./delivery-profiles";

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

describe("what a profile asks of a picture (#42)", () => {
  it("says it after the sound, where the profile asks anything", () => {
    expect(pictureSummary(deliveryProfiles.broadcast)).toBe(
      "1920 × 1080, 25 fps, Rec. 709, limited range",
    );
    expect(pictureSummary(deliveryProfiles.streaming)).toBe("Progressive, limited range");
    expect(pictureSummary(deliveryProfiles.cd)).toBeNull();
    expect(deliveryHint(deliveryProfiles.broadcast)).toMatch(
      /· Stereo · Picture: 1920 × 1080, 25 fps/,
    );
    expect(deliveryHint(deliveryProfiles.cd)).toBe(profileSummary(deliveryProfiles.cd));
  });

  it("turns the editor's choices into a profile's picture and back", () => {
    const video = deliveryProfiles.broadcast.video;
    const fields = pictureFields(video);
    expect(fields).toEqual({
      codec: "",
      resolution: "1920x1080",
      frameRate: "25",
      scan: "",
      primaries: "bt709",
      range: "limited",
    });
    expect(pictureFrom(fields)).toEqual(video);
    // Any for everything asks nothing of the picture.
    expect(pictureFrom(pictureFields(null))).toBeNull();
  });
});

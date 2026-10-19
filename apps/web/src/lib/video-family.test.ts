import { describe, expect, it } from "vitest";
import { chooseFamily, familyOf } from "./video-family";

describe("which encoding of a video plays (#148)", () => {
  it("knows each rendition's family by its codecs", () => {
    expect(familyOf({ codecs: "avc1.640028,mp4a.40.2" })).toBe("h264");
    expect(familyOf({ codecs: "av01.0.08M.08,opus" })).toBe("free");
    expect(familyOf({ codecs: "vp09.00.40.08,opus" })).toBe("free");
  });

  it("plays the royalty-free one where the browser decodes it well, or cannot play H.264", () => {
    const both = { hasH264: true, hasFree: true, h264Playable: true };
    expect(chooseFamily({ ...both, freeEfficient: true })).toBe("free");
    expect(chooseFamily({ ...both, freeEfficient: false })).toBe("h264");
    expect(chooseFamily({ ...both, h264Playable: false, freeEfficient: false })).toBe("free");
  });

  it("plays whichever family a video has, when it has one", () => {
    const one = { h264Playable: true, freeEfficient: true };
    expect(chooseFamily({ ...one, hasH264: true, hasFree: false })).toBe("h264");
    expect(chooseFamily({ ...one, hasH264: false, hasFree: true })).toBe("free");
  });
});

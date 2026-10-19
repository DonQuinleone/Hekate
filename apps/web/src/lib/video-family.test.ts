import { afterEach, describe, expect, it, vi } from "vitest";
import { chooseFamily, familyOf, videoFamilyFor } from "./video-family";

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

  describe("asking the browser", () => {
    afterEach(() => vi.unstubAllGlobals());
    const renditions = [
      { id: "a", name: "1080p", codecs: "avc1.64002a,mp4a.40.2", bandwidth: 6_200_000 },
      { id: "b", name: "1080p-av1", codecs: "av01.0.09M.08,opus", bandwidth: 4_170_000 },
    ].map((r) => ({ ...r, width: 1920, height: 1080 }));
    // A decoder smooth up to 30 frames a second, and no further.
    const browser = () => {
      const decodingInfo = vi.fn(async (config: { video: { framerate: number } }) => {
        const smooth = config.video.framerate <= 30;
        return { supported: true, smooth, powerEfficient: smooth };
      });
      vi.stubGlobal("MediaSource", { isTypeSupported: () => true });
      vi.stubGlobal("navigator", { mediaCapabilities: { decodingInfo } });
      return decodingInfo;
    };

    it("asks at the video's own frame rate", async () => {
      const decodingInfo = browser();
      expect(await videoFamilyFor(renditions, 60)).toBe("h264");
      expect(decodingInfo).toHaveBeenCalledWith(
        expect.objectContaining({ video: expect.objectContaining({ framerate: 60 }) }),
      );
      expect(await videoFamilyFor(renditions, 25)).toBe("free");
    });

    it("assumes 30 where the frame rate is unknown", async () => {
      browser();
      expect(await videoFamilyFor(renditions, null)).toBe("free");
    });
  });
});

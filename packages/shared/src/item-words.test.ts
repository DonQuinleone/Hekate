import { describe, expect, it } from "vitest";
import {
  aspectName,
  capital,
  codecName,
  itemWords,
  renditionTraits,
  updateVariationInput,
  versionLabel,
} from "./item-words.ts";

describe("a project's words for its items (#16)", () => {
  it("calls a video project's tracks deliverables, with cuts and renditions", () => {
    expect(itemWords("video")).toMatchObject({
      track: "deliverable",
      versions: "cuts",
      variation: "rendition",
    });
    expect(itemWords("music")).toMatchObject({ tracks: "tracks", version: "version" });
    expect(itemWords("general").variation).toBe("variation");
    expect(itemWords(undefined).track).toBe("track");
    expect(capital(itemWords("video").variations)).toBe("Renditions");
  });

  it("names a version as its project does", () => {
    expect(versionLabel(3, "video")).toBe("Cut 3");
    expect(versionLabel(3, "music")).toBe("V3");
  });
});

describe("a rendition's traits (#16)", () => {
  it("names the usual shapes, near enough, and gives others as a ratio", () => {
    expect(aspectName(1920, 1080)).toBe("16:9");
    expect(aspectName(1920, 1088)).toBe("16:9");
    expect(aspectName(1080, 1920)).toBe("9:16");
    expect(aspectName(1440, 1080)).toBe("4:3");
    expect(aspectName(1080, 1350)).toBe("4:5");
    expect(aspectName(4096, 1716)).toBe("2.39:1");
    expect(aspectName(1998, 1080)).toBe("1.85:1");
    expect(aspectName(4096, 2160)).toBe("DCI 1.90:1");
    expect(aspectName(1000, 300)).toBe("3.33:1");
    expect(aspectName(300, 1000)).toBe("1:3.33");
    expect(aspectName(0, 1080)).toBe("");
  });

  it("names codecs as people do", () => {
    expect(codecName("h264")).toBe("H.264");
    expect(codecName("prores")).toBe("ProRes");
    expect(codecName("something-new")).toBe("something-new");
  });

  it("says what was measured and what was said, and nothing unsaid", () => {
    const video = { video: { codec: "prores", width: 1920, height: 1080 } };
    expect(renditionTraits(video, { subtitled: true, graded: false })).toEqual([
      "16:9",
      "ProRes",
      "subtitled",
      "ungraded",
    ]);
    expect(renditionTraits(video, { subtitled: false, graded: true })).toEqual([
      "16:9",
      "ProRes",
      "clean",
      "graded",
    ]);
    expect(renditionTraits(video, { subtitled: null })).toEqual(["16:9", "ProRes"]);
    expect(renditionTraits(null, {})).toEqual([]);
  });

  it("changes a name or a treatment, and refuses an empty change", () => {
    expect(updateVariationInput.safeParse({ subtitled: true }).success).toBe(true);
    expect(updateVariationInput.safeParse({ graded: null }).success).toBe(true);
    expect(updateVariationInput.safeParse({ name: "9:16 clean" }).success).toBe(true);
    expect(updateVariationInput.safeParse({}).success).toBe(false);
    expect(updateVariationInput.safeParse({ name: "" }).success).toBe(false);
  });
});

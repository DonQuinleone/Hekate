import { describe, expect, it } from "vitest";
import { assetSecurityLayout, watermarkHome, watermarkSummary } from "./asset-security.ts";

const order = (layout: ReturnType<typeof assetSecurityLayout>) => layout.map((s) => s.section);
const opened = (layout: ReturnType<typeof assetSecurityLayout>) =>
  layout.filter((s) => s.open).map((s) => s.section);

describe("assetSecurityLayout", () => {
  it("puts audio first in a music project, then documents, then video", () => {
    expect(order(assetSecurityLayout("music", []))).toEqual(["audio", "documents", "video"]);
  });

  it("puts video first in a video project, then audio, then documents", () => {
    expect(order(assetSecurityLayout("video", []))).toEqual(["video", "audio", "documents"]);
  });

  it("puts documents first in a general project", () => {
    expect(order(assetSecurityLayout("general", []))).toEqual(["documents", "audio", "video"]);
  });

  it("never leaves a section out", () => {
    for (const profile of ["music", "video", "general"] as const) {
      expect([...order(assetSecurityLayout(profile))].sort()).toEqual([
        "audio",
        "documents",
        "video",
      ]);
    }
  });

  it("folds video in a music project with no video, and opens what it holds", () => {
    expect(opened(assetSecurityLayout("music", ["audio", "document"]))).toEqual([
      "audio",
      "documents",
    ]);
    expect(opened(assetSecurityLayout("music", ["audio"]))).toEqual(["audio"]);
    // A picture counts as much as a score.
    expect(opened(assetSecurityLayout("music", ["image"]))).toEqual(["audio", "documents"]);
  });

  it("opens video in a music project that holds one", () => {
    expect(opened(assetSecurityLayout("music", ["audio", "video"]))).toEqual(["audio", "video"]);
  });

  it("opens video in a video project before any video arrives, and folds documents", () => {
    expect(opened(assetSecurityLayout("video", []))).toEqual(["video", "audio"]);
    expect(opened(assetSecurityLayout("video", ["video", "document"]))).toEqual([
      "video",
      "audio",
      "documents",
    ]);
  });

  it("keeps audio open whatever the project holds", () => {
    expect(opened(assetSecurityLayout("video", ["video"]))).toContain("audio");
    expect(opened(assetSecurityLayout("general", null))).toEqual(["documents", "audio"]);
  });
});

describe("watermarkHome", () => {
  it("is the first open section that shows pictures", () => {
    expect(watermarkHome(assetSecurityLayout("music", ["document"]))).toBe("documents");
    expect(watermarkHome(assetSecurityLayout("video", ["document"]))).toBe("video");
    expect(
      watermarkHome([
        { section: "audio", open: true },
        { section: "documents", open: false },
        { section: "video", open: true },
      ]),
    ).toBe("video");
  });

  it("is nowhere while both are folded", () => {
    expect(watermarkHome(assetSecurityLayout("music", ["audio"]))).toBeNull();
  });
});

describe("watermarkSummary", () => {
  it("says whom, where and how strongly, or that there is none", () => {
    expect(watermarkSummary({ scope: "guests", position: "tiled", opacity: 30 })).toBe(
      "Guests only · Tiled · 30%",
    );
    expect(watermarkSummary({ scope: "off", position: "corner", opacity: 30 })).toBe(
      "No visible watermark",
    );
  });
});

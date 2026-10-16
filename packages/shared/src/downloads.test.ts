import { describe, expect, it } from "vitest";
import { allowsDownload, downloadLevelOf, widestDownload } from "./downloads.ts";

describe("downloads", () => {
  it("lets the original level take the proxy too, and none take nothing", () => {
    expect(allowsDownload("original", "proxy")).toBe(true);
    expect(allowsDownload("original", "original")).toBe(true);
    expect(allowsDownload("proxy", "original")).toBe(false);
    expect(allowsDownload("none", "proxy")).toBe(false);
  });

  it("reads a role's level from its permissions, and the widest of several grants", () => {
    expect(downloadLevelOf(["view", "download_proxy"])).toBe("proxy");
    expect(downloadLevelOf(["download_proxy", "download_original"])).toBe("original");
    expect(downloadLevelOf(["view"])).toBe("none");
    expect(widestDownload([undefined, "proxy", "none"])).toBe("proxy");
    expect(widestDownload([])).toBe("none");
  });
});

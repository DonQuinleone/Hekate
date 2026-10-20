import { describe, expect, it } from "vitest";
import { compareVersions, newerReleases, releasesOfFeed } from "./releases.ts";

const entry = (tag: string, over: Record<string, unknown> = {}) => ({
  tag_name: tag,
  name: null,
  published_at: "2026-11-02T10:00:00Z",
  prerelease: false,
  draft: false,
  body: "Fixes.",
  html_url: `https://github.com/DonQuinleone/Hekate/releases/tag/${tag}`,
  ...over,
});

describe("releases", () => {
  it("orders versions as semantic versioning does", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("0.3.0", "0.3.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("0.3.0-rc.2", "0.3.0-rc.10")).toBeLessThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("reads the feed, leaving out drafts and tags that are not versions", () => {
    const releases = releasesOfFeed([
      entry("v0.3.0"),
      entry("v0.4.0", { draft: true }),
      entry("nightly"),
      entry("v0.3.1-rc.1", { prerelease: true, name: "Candidate" }),
      "not a release",
    ]);
    expect(releases.map((r) => [r.version, r.name, r.prerelease])).toEqual([
      ["0.3.0", "Release 0.3.0", false],
      ["0.3.1-rc.1", "Candidate", true],
    ]);
    expect(releasesOfFeed({ message: "rate limited" })).toEqual([]);
  });

  it("offers the releases newer than the running one, candidates on beta only", () => {
    const releases = releasesOfFeed([
      entry("v0.1.0"),
      entry("v0.2.0"),
      entry("v0.3.0-rc.1", { prerelease: true }),
      entry("v0.2.1"),
    ]);
    expect(newerReleases("0.2.0", releases, "stable").map((r) => r.version)).toEqual(["0.2.1"]);
    expect(newerReleases("0.2.0", releases, "beta").map((r) => r.version)).toEqual([
      "0.3.0-rc.1",
      "0.2.1",
    ]);
    expect(newerReleases("0.3.0", releases, "beta")).toEqual([]);
  });
});

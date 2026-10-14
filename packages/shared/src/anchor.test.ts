import { describe, expect, it } from "vitest";
import { anchor } from "./anchor.ts";
import { formatAnchor, formatClock, formatTimecode } from "./format.ts";
import { allowsAnchor } from "./profile.ts";

describe("anchor schema", () => {
  it("accepts each anchor kind and nothing else", () => {
    expect(anchor.parse({ kind: "time", start: 271.25, end: 271.25 }).kind).toBe("time");
    expect(
      anchor.parse({ kind: "region", page: 7, x: 0.1, y: 0.1, width: 0.2, height: 0.1 }).kind,
    ).toBe("region");
    expect(anchor.parse({ kind: "bar", from: { bar: 112 } })).toEqual({
      kind: "bar",
      from: { bar: 112, beat: 1 },
    });
    expect(anchor.safeParse({ kind: "section", sectionId: "mvt-1" }).success).toBe(false);
  });

  it("rejects inverted ranges and regions outside the frame", () => {
    expect(anchor.safeParse({ kind: "time", start: 10, end: 5 }).success).toBe(false);
    expect(anchor.safeParse({ kind: "bar", from: { bar: 124 }, to: { bar: 118 } }).success).toBe(
      false,
    );
    expect(
      anchor.safeParse({ kind: "region", x: 0.9, y: 0, width: 0.2, height: 0.1 }).success,
    ).toBe(false);
  });
});

describe("formatting", () => {
  it("writes clock times and timecode", () => {
    expect(formatClock(271.25)).toBe("04:31.250");
    expect(formatClock(3871.25)).toBe("1:04:31.250");
    expect(formatTimecode(72.32, 25)).toBe("00:01:12:08");
  });

  it("writes anchors the way the brand system does", () => {
    expect(formatAnchor({ kind: "bar", from: { bar: 112, beat: 1 } })).toBe("BAR 112.1");
    expect(formatAnchor({ kind: "bar", from: { bar: 118, beat: 1 }, to: { bar: 124 } })).toBe(
      "BARS 118–124",
    );
    expect(formatAnchor({ kind: "time", start: 72.32, end: 72.32, frame: 1808 }, { fps: 25 })).toBe(
      "00:01:12:08 · F 1808",
    );
    expect(formatAnchor({ kind: "region", page: 7, x: 0.1, y: 0.2, width: 0.3, height: 0.1 })).toBe(
      "P. 7 · REGION",
    );
    expect(formatAnchor({ kind: "region", page: 7, x: 0, y: 0, width: 1, height: 1 })).toBe("P. 7");
    expect(formatAnchor({ kind: "region", x: 0.1, y: 0.1, width: 0.5, height: 0.5 })).toBe(
      "REGION",
    );
    // A whole video frame is still a region, not a time.
    expect(formatAnchor({ kind: "region", at: 12, x: 0, y: 0, width: 1, height: 1 })).toBe(
      "00:12.000 · REGION",
    );
  });
});

describe("profiles", () => {
  it("limits bar anchors to music projects", () => {
    expect(allowsAnchor("music", "bar")).toBe(true);
    expect(allowsAnchor("video", "bar")).toBe(false);
  });
});

import { atLeast } from "./organisation.ts";

describe("organisation roles", () => {
  it("ranks owner over admin over member", () => {
    expect(atLeast("owner", "admin")).toBe(true);
    expect(atLeast("admin", "admin")).toBe(true);
    expect(atLeast("member", "admin")).toBe(false);
  });
});

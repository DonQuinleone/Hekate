import { describe, expect, it } from "vitest";
import { endOfDay, shareLine } from "./shares";

describe("a share's people (#138)", () => {
  const ago = () => "2 hours ago";
  it("says whether each opened it, and how much to those who run it", () => {
    expect(shareLine({ viewedAt: null, usage: null }, ago)).toBe("Not opened");
    expect(shareLine({ viewedAt: "2026-10-17T10:00:00Z", usage: null }, ago)).toBe(
      "Opened 2 hours ago",
    );
    expect(
      shareLine({ viewedAt: "2026-10-17T10:00:00Z", usage: { plays: 1, downloads: 0 } }, ago),
    ).toBe("Opened 2 hours ago · 1 play");
    expect(shareLine({ viewedAt: null, usage: { plays: 3, downloads: 2 } }, ago)).toBe(
      "Not opened · 3 plays · 2 downloads",
    );
  });

  it("closes at the end of the chosen day", () => {
    const end = new Date(endOfDay("2026-10-31"));
    expect([end.getFullYear(), end.getMonth(), end.getDate(), end.getHours()]).toEqual([
      2026, 9, 31, 23,
    ]);
  });
});

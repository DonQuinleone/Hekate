import { describe, expect, it } from "vitest";
import { endOfDay, shareLine, shareNote } from "./shares";

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

  it("tells the person it is shared with how often, until when, and what to keep", () => {
    const date = () => "31 October 2026";
    const at = "2026-10-31T22:59:59Z";
    expect(shareNote({ expiresAt: at, maxPlays: null, download: "none" }, date)).toBe(
      "Listen as often as you like until 31 October 2026.",
    );
    // A limit leads, never beside "as often as you like".
    expect(shareNote({ expiresAt: at, maxPlays: 1, download: "proxy" }, date)).toBe(
      "Up to 1 play of each file until 31 October 2026. You may download the proxy; each copy is marked for you.",
    );
    expect(shareNote({ expiresAt: null, maxPlays: 3, download: "none" }, date)).toBe(
      "Up to 3 plays of each file until it is withdrawn.",
    );
  });
});

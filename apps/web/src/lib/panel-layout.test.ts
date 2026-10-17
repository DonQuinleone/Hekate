import { describe, expect, it } from "vitest";
import { commentsWidth, defaultPanelLayout, readPanelLayout } from "./panel-layout";

describe("where a file's comments sit (#15)", () => {
  it("reads what a browser kept, and falls back on anything else", () => {
    expect(readPanelLayout({ comments: "below", width: 420 })).toEqual({
      comments: "below",
      width: 420,
    });
    expect(readPanelLayout(null)).toEqual(defaultPanelLayout);
    expect(readPanelLayout("right")).toEqual(defaultPanelLayout);
    expect(readPanelLayout({ comments: "left", width: "wide" })).toEqual(defaultPanelLayout);
  });

  it("keeps the column between its narrowest and widest", () => {
    expect(commentsWidth(120)).toBe(300);
    expect(commentsWidth(900)).toBe(640);
    expect(commentsWidth(401.6)).toBe(402);
    expect(readPanelLayout({ comments: "hidden", width: 10_000 })).toEqual({
      comments: "hidden",
      width: 640,
    });
  });
});

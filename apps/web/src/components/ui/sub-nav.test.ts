import { describe, expect, it } from "vitest";
import { edgesOf, scrollFor } from "./sub-nav";

describe("a strip of sections on a phone (#542)", () => {
  it("fades the edge that has more beyond it", () => {
    expect(edgesOf(0, 390, 390)).toEqual({ start: false, end: false });
    expect(edgesOf(0, 390, 700)).toEqual({ start: false, end: true });
    expect(edgesOf(150, 390, 700)).toEqual({ start: true, end: true });
    expect(edgesOf(310, 390, 700)).toEqual({ start: true, end: false });
  });

  it("brings the current item whole into view, as near the middle as the strip allows", () => {
    // An item at 600 to 680 in a 390-wide strip of 900: centred.
    expect(scrollFor({ left: 600, width: 80 }, 390, 900)).toBe(445);
    // Near the start or the end, the strip stops at its edge.
    expect(scrollFor({ left: 10, width: 80 }, 390, 900)).toBe(0);
    expect(scrollFor({ left: 840, width: 60 }, 390, 900)).toBe(510);
  });
});

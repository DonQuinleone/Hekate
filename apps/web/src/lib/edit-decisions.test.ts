import type { EditDecisions, EdlUse } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { barsUsedOf, decisionsSummary, editLine, rateName } from "./edit-decisions";

const use = (over: Partial<EdlUse>, clipName: string | null = "Take 12.wav"): EdlUse => ({
  event: {
    number: 1,
    reel: "TAKE12",
    track: "AA",
    transition: "C",
    sourceIn: 0,
    sourceOut: 10,
    recordIn: 12,
    recordOut: 25.5,
    clipName,
  },
  takeId: "a",
  from: 10,
  to: 23.5,
  bars: [6, 12],
  ...over,
});

const decisions = (uses: EdlUse[]): EditDecisions => ({
  version: { id: "v", number: 3 },
  fileName: "V3.edl",
  title: null,
  fps: 25,
  fpsGuessed: true,
  dropFrame: false,
  uses,
});

describe("edit decisions (#56)", () => {
  it("says whose list it is, and what of it is no take", () => {
    expect(decisionsSummary(decisions([use({})]))).toBe("From V3's list · 1 edit");
    expect(decisionsSummary(decisions([use({}), use({ takeId: null })]))).toBe(
      "From V3's list · 2 edits, 1 from no take of this track",
    );
    expect(rateName(29.97, true)).toBe("29.97 fps drop frame");
  });

  it("writes each edit as a line: where, which take, where in it, which bars", () => {
    const number = (id: string) => (id === "a" ? 12 : undefined);
    expect(editLine(use({}), number)).toEqual({
      when: "0:12–0:25.5",
      take: "T12",
      source: "Take 12.wav",
      place: "0:10–0:23.5 of the take",
      bars: "bars 6 to 12",
    });
    expect(editLine(use({ from: null, to: null, bars: null }, null), number)).toMatchObject({
      source: "TAKE12",
      place: "Its place in the take is not known",
      bars: null,
    });
    expect(editLine(use({ takeId: null }), number)).toMatchObject({
      take: null,
      place: "Not a take of this track",
    });
  });

  it("gives each take the bars the version uses of it", () => {
    const d = decisions([
      use({}),
      use({ bars: [20, 22] }),
      use({ takeId: "b" }),
      use({ bars: null }),
    ]);
    expect(barsUsedOf(d, "a")).toEqual([
      [6, 12],
      [20, 22],
    ]);
    expect(barsUsedOf(null, "a")).toEqual([]);
  });
});

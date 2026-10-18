import type { EditDecisions, EdlUse } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import {
  barsUsedOf,
  decisionsSummary,
  editLine,
  editSegments,
  rateName,
  segmentAt,
  takesUsed,
  usedAtBar,
} from "./edit-decisions";

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

  it("says which take the version uses at a bar, and which it uses at all", () => {
    const d = decisions([use({}), use({ takeId: "b", bars: null }), use({ takeId: null })]);
    expect(usedAtBar(d, "a", 6)).toBe("V3");
    expect(usedAtBar(d, "a", 12)).toBe("V3");
    expect(usedAtBar(d, "a", 13)).toBeNull();
    // Used, but where in its bars is not known: not said of any bar.
    expect(usedAtBar(d, "b", 6)).toBeNull();
    expect(usedAtBar(null, "a", 6)).toBeNull();
    expect([...takesUsed(d)]).toEqual(["a", "b"]);
  });
});

describe("the edit lane", () => {
  const numberOf = (id: string) => ({ a: 12, b: 3 })[id];
  const at = (
    recordIn: number,
    recordOut: number,
    over: Partial<EdlUse> = {},
    clip?: string | null,
  ) => {
    const u = use(over, clip);
    return { ...u, event: { ...u.event, recordIn, recordOut } };
  };

  it("lays the edits along the version in order, named by their takes", () => {
    const segments = editSegments(
      decisions([at(10, 20, { takeId: "b", bars: [9, 16] }), at(0, 10)]),
      numberOf,
    );
    expect(segments).toEqual([
      { start: 0, end: 10, label: "T12", take: true, bars: "bars 6 to 12" },
      { start: 10, end: 20, label: "T3", take: true, bars: "bars 9 to 16" },
    ]);
  });

  it("makes one stretch of an edit on two tracks, and cuts at a dissolve", () => {
    const segments = editSegments(
      decisions([at(0, 10), at(0, 10), at(8, 20, { takeId: "b" })]),
      numberOf,
    );
    expect(segments.map((s) => [s.start, s.end, s.label])).toEqual([
      [0, 10, "T12"],
      [10, 20, "T3"],
    ]);
  });

  it("names a source that is no take of this track as the list does", () => {
    const [segment] = editSegments(
      decisions([at(0, 4, { takeId: null, bars: null }, "Pick-up, bar 17.wav")]),
      numberOf,
    );
    expect(segment).toEqual({
      start: 0,
      end: 4,
      label: "Pick-up, bar 17.wav",
      take: false,
      bars: null,
    });
    expect(editSegments(null, numberOf)).toEqual([]);
  });

  it("finds the stretch playing", () => {
    const segments = editSegments(decisions([at(0, 10), at(10, 20, { takeId: "b" })]), numberOf);
    expect(segmentAt(segments, 10)?.label).toBe("T3");
    expect(segmentAt(segments, 25)).toBeNull();
  });
});

import type { EditDecisions, EdlUse } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import {
  coverageLabel,
  falseStartsLabel,
  takeLoop,
  takesByTrack,
  threadMatches,
  timecodeSpan,
  usedInLabel,
} from "./take-page";

const use = (takeId: string | null, bars: [number, number] | null): EdlUse => ({
  event: {
    number: 1,
    reel: "TAKE12",
    track: "AA",
    transition: "C",
    sourceIn: 0,
    sourceOut: 10,
    recordIn: 12,
    recordOut: 25.5,
    clipName: "Take 12.wav",
  },
  takeId,
  from: 10,
  to: 23.5,
  bars,
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

describe("timecodeSpan", () => {
  it("writes both ends in full, never shortening the out point", () => {
    expect(timecodeSpan("10:14:02:00", "10:19:40:00")).toBe("10:14:02:00 – 10:19:40:00");
    expect(timecodeSpan("10:58:02:00", "11:01:40:00")).toBe("10:58:02:00 – 11:01:40:00");
  });
  it("marks the end not yet known, as the take log does, and nothing for neither", () => {
    expect(timecodeSpan("10:14:02:00", null)).toBe("10:14:02:00 – …");
    expect(timecodeSpan(null, "10:19:40:00")).toBe("… – 10:19:40:00");
    expect(timecodeSpan(null, null)).toBeNull();
  });
});

describe("usedInLabel", () => {
  it("names the version and every stretch of bars it uses, in order", () => {
    expect(usedInLabel(decisions([use("a", [52, 60]), use("a", [12, 40])]), "a")).toBe(
      "V3 bars 12–40, 52–60",
    );
    expect(usedInLabel(decisions([use("a", [17, 17])]), "a")).toBe("V3 bar 17");
  });
  it("names the version alone where the list places it by no bars", () => {
    expect(usedInLabel(decisions([use("a", null)]), "a")).toBe("V3");
  });
  it("is null for a take the list does not use, or without a list", () => {
    expect(usedInLabel(decisions([use("b", [1, 4]), use(null, null)]), "a")).toBeNull();
    expect(usedInLabel(null, "a")).toBeNull();
  });
});

describe("falseStartsLabel", () => {
  it("counts them, and says nothing of none", () => {
    expect(falseStartsLabel(1)).toBe("1 false start");
    expect(falseStartsLabel(3)).toBe("3 false starts");
    expect(falseStartsLabel(0)).toBeNull();
  });
});

describe("coverageLabel", () => {
  it("writes the page and the bars, as far as they are given", () => {
    expect(coverageLabel({ page: 7, barFrom: 64, barTo: 88 })).toBe("p. 7 · bars 64–88");
    expect(coverageLabel({ page: null, barFrom: 72, barTo: null })).toBe("bar 72");
    expect(coverageLabel({ page: 3, barFrom: null, barTo: null })).toBeNull();
  });
});

describe("takeLoop", () => {
  it("loops from the in point to the out point, else the whole take", () => {
    expect(takeLoop({ inPoint: 4, outPoint: 30 }, 74)).toEqual({ start: 4, end: 30 });
    expect(takeLoop({ inPoint: null, outPoint: null }, 74)).toEqual({ start: 0, end: 74 });
    expect(takeLoop({ inPoint: 12, outPoint: null }, 74)).toEqual({ start: 12, end: 74 });
  });
  it("is null where the length is unknown", () => {
    expect(takeLoop({ inPoint: null, outPoint: null }, null)).toBeNull();
  });
});

describe("takesByTrack", () => {
  const maple = { id: "m", name: "Maple Leaf Rag" };
  const elite = { id: "e", name: "The Entertainer" };
  const take = (id: string, track: { id: string; name: string }) => ({ id, track });
  it("lists the session's tracks in order, each with its takes, and keeps one without", () => {
    const groups = takesByTrack([maple, elite], [take("t1", maple), take("t2", maple)]);
    expect(groups.map((g) => [g.track.name, g.takes.map((t) => t.id)])).toEqual([
      ["Maple Leaf Rag", ["t1", "t2"]],
      ["The Entertainer", []],
    ]);
  });
  it("adds a track a take belongs to that the session does not name, after its own", () => {
    const groups = takesByTrack([maple], [take("t1", elite), take("t2", maple)]);
    expect(groups.map((g) => g.track.id)).toEqual(["m", "e"]);
  });
});

describe("threadMatches", () => {
  const thread = { body: "Pedal noise at the join", authorName: "Mira Solberg", anchor: "Bars 9–12" };
  it("finds a thread by its words, its author or its anchor, every word given", () => {
    expect(threadMatches(thread, "")).toBe(true);
    expect(threadMatches(thread, "pedal JOIN")).toBe(true);
    expect(threadMatches(thread, "mira")).toBe(true);
    expect(threadMatches(thread, "bars 9")).toBe(true);
    expect(threadMatches(thread, "pedal tomas")).toBe(false);
  });
});

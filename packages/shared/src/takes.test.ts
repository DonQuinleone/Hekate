import { describe, expect, it } from "vitest";
import {
  barSpan,
  barsLabel,
  canMoveTake,
  clockOf,
  coverageGaps,
  covers,
  fieldChanges,
  gapsLabel,
  loggedNumber,
  nextTakeNumber,
  parseClock,
  slotProblem,
  startTakeInput,
  takeChangeInput,
  takeLogCsv,
  takeProblem,
  takesCovering,
} from "./takes.ts";

const take = (number: number, barFrom: number | null, barTo: number | null, extra = {}) => ({
  number,
  barFrom,
  barTo,
  starred: false,
  rating: 0,
  ...extra,
});

describe("takes and their bars", () => {
  it("covers its range, or its one bar", () => {
    expect(covers(take(1, 64, 88), 72)).toBe(true);
    expect(covers(take(1, 64, 88), 89)).toBe(false);
    expect(covers(take(1, 12, null), 12)).toBe(true);
    expect(covers(take(1, null, null), 1)).toBe(false);
    expect(barsLabel(take(1, 64, 88))).toBe("bars 64 to 88");
    expect(barsLabel(take(1, 12, null))).toBe("bar 12");
    expect(barsLabel(take(1, null, null))).toBeNull();
  });

  it("lists the takes for a bar, circled and best first", () => {
    const all = [
      take(1, 60, 80, { rating: 3 }),
      take(2, 70, 90, { rating: 5 }),
      take(3, 72, 72, { starred: true, rating: 2 }),
      take(4, 1, 40, { rating: 5 }),
      take(5, 65, 75, { rating: 3 }),
    ];
    expect(takesCovering(all, 72).map((t) => t.number)).toEqual([3, 2, 1, 5]);
    expect(takesCovering(all, 95)).toEqual([]);
  });

  it("finds the bars no take covers", () => {
    expect(coverageGaps([])).toEqual([]);
    expect(coverageGaps([take(1, 1, 16), take(2, 17, 32)])).toEqual([]);
    expect(coverageGaps([take(1, 5, 10), take(2, 15, 20), take(3, null, null)])).toEqual([
      [1, 4],
      [11, 14],
    ]);
    expect(coverageGaps([take(1, 0, 8)])).toEqual([]);
    expect(gapsLabel([[33, 40]])).toBe("bars 33 to 40");
    expect(gapsLabel([[52, 52]])).toBe("bar 52");
    expect(
      gapsLabel([
        [9, 12],
        [20, 20],
        [33, 40],
      ]),
    ).toBe("bars 9 to 12, 20 and 33 to 40");
  });

  it("refuses bars and points in the wrong order", () => {
    const place = { barFrom: null, barTo: null, inPoint: null, outPoint: null };
    expect(takeProblem(place)).toBeNull();
    expect(takeProblem({ ...place, barFrom: 9, barTo: 4 })).toMatch(/last bar/);
    expect(takeProblem({ ...place, barTo: 4 })).toMatch(/first bar/);
    expect(takeProblem({ ...place, inPoint: 30, outPoint: 12 })).toMatch(/out point/);
    expect(takeChangeInput.safeParse({ rating: 6 }).success).toBe(false);
    expect(takeChangeInput.safeParse({ barFrom: -1 }).success).toBe(false);
    expect(takeChangeInput.safeParse({ notes: "Lovely rubato", starred: true }).success).toBe(true);
  });

  it("reads and writes in and out points as a clock", () => {
    expect(parseClock("92.5")).toBe(92.5);
    expect(parseClock("1:32.5")).toBe(92.5);
    expect(parseClock(" 1:02:03 ")).toBe(3723);
    expect(parseClock("1:75")).toBeNull();
    expect(parseClock("1.5:20")).toBeNull();
    expect(parseClock("soon")).toBeNull();
    expect(parseClock("")).toBeNull();
    expect(clockOf(92.5)).toBe("1:32.5");
    expect(clockOf(92)).toBe("1:32");
    expect(clockOf(3723.04)).toBe("1:02:03");
    expect(parseClock(clockOf(61.25))).toBe(61.3);
  });
});

describe("a bar in a take", () => {
  const take = { barFrom: 9, barTo: 16, inPoint: 2, outPoint: 18, duration: 20 };
  it("lies where the take's bars spread evenly over its in and out points", () => {
    expect(barSpan(take, 9)).toEqual([2, 4]);
    expect(barSpan(take, 16)).toEqual([16, 18]);
    // Without in and out points, over the whole file.
    expect(barSpan({ ...take, inPoint: null, outPoint: null }, 10)).toEqual([2.5, 5]);
    // One bar given: the take is that bar.
    expect(barSpan({ ...take, barTo: null }, 9)).toEqual([2, 18]);
  });
  it("cannot be said outside the take's bars or without its length", () => {
    expect(barSpan(take, 8)).toBeNull();
    expect(barSpan(take, 17)).toBeNull();
    expect(barSpan({ ...take, outPoint: null, duration: null }, 9)).toBeNull();
    expect(barSpan({ ...take, barFrom: null, barTo: null }, 9)).toBeNull();
  });
});

describe("the take log (#51)", () => {
  it("moves a take only where a control room would", () => {
    expect(canMoveTake("idle", "recording")).toBe(true);
    expect(canMoveTake("armed", "recording")).toBe(true);
    expect(canMoveTake("recording", "recorded")).toBe(true);
    expect(canMoveTake("recording", "aborted")).toBe(true);
    expect(canMoveTake("aborted", "recorded")).toBe(true);
    expect(canMoveTake("recorded", "recorded")).toBe(true);
    expect(canMoveTake("recorded", "recording")).toBe(false);
    // A recorded take stays recorded; it is not aborted after the event.
    expect(canMoveTake("recorded", "aborted")).toBe(false);
    expect(canMoveTake("aborted", "recording")).toBe(false);
    expect(canMoveTake("idle", "recorded")).toBe(false);
  });

  it("numbers on across the project, per track, or as the recorder does", () => {
    const last = { project: 40, track: 7 };
    expect(nextTakeNumber("continuous", last)).toBe(41);
    expect(nextTakeNumber("per-track", last)).toBe(8);
    expect(nextTakeNumber("recorder", last, 112)).toBe(112);
    // Without the recorder's number, its track's next.
    expect(nextTakeNumber("recorder", last)).toBe(8);
    expect(nextTakeNumber("continuous", { project: 0, track: 0 })).toBe(1);
  });

  it("refuses a slot that ends before it starts", () => {
    expect(slotProblem("2026-10-14T14:00:00Z", "2026-10-14T16:00:00Z")).toBeNull();
    expect(slotProblem("2026-10-14T14:00:00Z", "2026-10-14T14:00:00Z")).toBe(
      "The slot ends before it starts",
    );
    expect(slotProblem(null, "2026-10-14T14:00:00Z")).toBeNull();
  });

  it("starts rolling unless armed, and takes only a timecode as one", () => {
    expect(startTakeInput.parse({ trackId: "0199f000-0000-7000-8000-000000000001" })).toEqual({
      trackId: "0199f000-0000-7000-8000-000000000001",
      lifecycle: "recording",
    });
    expect(
      startTakeInput.safeParse({
        trackId: "0199f000-0000-7000-8000-000000000001",
        timecodeIn: "10:00",
      }).success,
    ).toBe(false);
  });

  it("writes the log as a spreadsheet, with nobody's notes read as a formula", () => {
    const take = {
      id: "t",
      number: 12,
      label: null,
      notes: '=HYPERLINK("x"), then a good ending',
      rating: 4,
      starred: true,
      page: 3,
      pageTo: 4,
      sessionId: "s",
      lifecycle: "recorded" as const,
      falseStarts: 2,
      timecodeIn: "11:02:14:00",
      timecodeOut: "11:04:01:12",
      wallIn: "2026-10-14T14:02:14.000Z",
      wallOut: "2026-10-14T14:04:01.000Z",
      barFrom: 65,
      barTo: 88,
      inPoint: null,
      outPoint: null,
      file: null,
      createdAt: "2026-10-14T14:02:14.000Z",
      track: { id: "k", name: "Maple Leaf Rag" },
    };
    const csv = takeLogCsv([
      take,
      {
        ...take,
        number: 13,
        lifecycle: "aborted",
        notes: null,
        rating: 0,
        starred: false,
        falseStarts: 0,
        page: null,
        barFrom: null,
        barTo: null,
      },
    ]);
    expect(csv.split("\r\n")).toEqual([
      "Take,Track,State,Rating,Starred,False starts,Timecode in,Timecode out,Wall clock in,Wall clock out,Page,Bars,Notes",
      `12,Maple Leaf Rag,Recorded,4,Yes,2,11:02:14:00,11:04:01:12,2026-10-14T14:02:14.000Z,2026-10-14T14:04:01.000Z,3–4,65–88,"'=HYPERLINK(""x""), then a good ending"`,
      "13,Maple Leaf Rag,Aborted,,,,11:02:14:00,11:04:01:12,2026-10-14T14:02:14.000Z,2026-10-14T14:04:01.000Z,,,",
      "",
    ]);
  });

  it("keeps a take's pages in order, the first given before the last", () => {
    const place = { barFrom: null, barTo: null, inPoint: null, outPoint: null };
    expect(takeProblem({ ...place, page: 3, pageTo: 5 })).toBeNull();
    expect(takeProblem({ ...place, page: 3, pageTo: 3 })).toBeNull();
    expect(takeProblem({ ...place, page: 5, pageTo: 3 })).toBe(
      "The last page comes before the first",
    );
    expect(takeProblem({ ...place, page: null, pageTo: 3 })).toBe("Give the first page too");
  });
});

describe("fieldChanges", () => {
  const take = {
    notes: "Lovely rubato",
    rating: 4,
    starred: false,
    wallIn: new Date("2026-10-14T14:00:00Z"),
  };

  it("records only the fields that change, with the value each replaces", () => {
    expect(fieldChanges(take, { rating: 5, starred: false, notes: "Lovely rubato" })).toEqual([
      { field: "rating", before: 4, after: 5, overwrote: false },
    ]);
  });

  it("says when a change replaces a value its writer never saw", () => {
    // Written offline against "Lovely rubato"; someone has since changed the note.
    const now = { ...take, notes: "Keeper into the trio" };
    expect(
      fieldChanges(now, { notes: "Lovely rubato, a touch fast" }, { notes: "Lovely rubato" }),
    ).toEqual([
      {
        field: "notes",
        before: "Keeper into the trio",
        after: "Lovely rubato, a touch fast",
        overwrote: true,
      },
    ]);
    // A field nobody else touched is no conflict.
    expect(fieldChanges(now, { rating: 5 }, { rating: 4 })[0]?.overwrote).toBe(false);
  });

  it("takes a moment in any offset as the same moment", () => {
    expect(fieldChanges(take, { wallIn: "2026-10-14T15:00:00+01:00" })).toEqual([]);
    expect(fieldChanges(take, { wallIn: "2026-10-14T14:00:05Z" })).toEqual([
      {
        field: "wallIn",
        before: "2026-10-14T14:00:00.000Z",
        after: "2026-10-14T14:00:05.000Z",
        overwrote: false,
      },
    ]);
  });
});

describe("startTakeInput", () => {
  it("takes the log's own UUIDv7 for a take, and nothing else", () => {
    const trackId = "01a156e3-0d1a-7737-9546-0047ef13165d";
    expect(
      startTakeInput.safeParse({ trackId, id: "01a156e3-cf0b-754f-865f-24a5d296da03" }).success,
    ).toBe(true);
    expect(
      startTakeInput.safeParse({ trackId, id: "8f14e45f-ceea-467a-9575-0123456789ab" }).success,
    ).toBe(false);
  });
});

describe("loggedNumber", () => {
  it("reads the take a file was recorded as, when it can name a logged take", () => {
    expect(loggedNumber("27")).toBe(27);
    expect(loggedNumber(" 003 ")).toBe(3);
    expect(loggedNumber("12A")).toBeNull();
    expect(loggedNumber("")).toBeNull();
    expect(loggedNumber(null)).toBeNull();
  });
});

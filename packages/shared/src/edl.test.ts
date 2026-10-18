import { describe, expect, it } from "vitest";
import { barsUsed, type EdlTake, matchEdl, parseCmx3600, timecodeSeconds } from "./edl.ts";

// As a DAW exports a stereo edit: two takes, a dissolve between them, black at the head.
const list = `TITLE: MAPLE LEAF RAG V3
FCM: NON-DROP FRAME

001  BL       AA     C        00:00:00:00 00:00:02:00 01:00:00:00 01:00:02:00
002  TAKE12   AA     C        10:00:05:00 10:00:20:00 01:00:02:00 01:00:17:00
* FROM CLIP NAME: Take 12.wav
003  TAKE12   AA     C        10:00:20:00 10:00:20:00 01:00:17:00 01:00:17:00
003  MAPLELEA AA     D    025 10:02:10:00 10:02:30:12 01:00:17:00 01:00:37:12
* FROM CLIP NAME: Maple Leaf Rag T14.wav
M2   MAPLELEA       025.0                10:02:10:00
004  T09      A2     C        00:00:01:00 00:00:03:00 01:00:37:12 01:00:39:12
005  UNKNOWN  AA     C        00:00:01:00 00:00:03:00 01:00:39:12 01:00:41:12
`;

const take = (over: Partial<EdlTake>): EdlTake => ({
  id: "t",
  number: 1,
  label: null,
  fileName: "x.wav",
  start: null,
  duration: 60,
  inPoint: null,
  outPoint: null,
  barFrom: null,
  barTo: null,
  ...over,
});

describe("edit decision lists (#56)", () => {
  it("reads timecode at whole-frame rates and in drop frame", () => {
    expect(timecodeSeconds("01:00:00:00", 25)).toBe(3600);
    expect(timecodeSeconds("00:00:01:12", 25)).toBeCloseTo(1.48);
    expect(timecodeSeconds("00:00:01:12", 30)).toBeCloseTo(1.4);
    // Frame 25 does not exist at 25 frames a second.
    expect(timecodeSeconds("00:00:01:25", 25)).toBeNull();
    // Drop frame: 00:01:00;02 is the 1,800th frame, as 00:00:59;29 was the 1,799th.
    expect(timecodeSeconds("00:01:00;02", 29.97)).toBeCloseTo((1800 * 1001) / 30_000);
    expect(timecodeSeconds("10:00", 25)).toBeNull();
  });

  it("reads each event with its clip name, leaving out what has no length", () => {
    const edl = parseCmx3600(list);
    expect(edl.title).toBe("MAPLE LEAF RAG V3");
    expect(edl.dropFrame).toBe(false);
    // No frame reaches 24, so the rate is a guess, at 25.
    expect(edl).toMatchObject({ fps: 25, fpsGuessed: true, recordStart: 3600 });
    expect(edl.events.map((e) => e.number)).toEqual([1, 2, 3, 4, 5]);
    const dissolve = edl.events[2];
    expect(dissolve).toMatchObject({
      reel: "MAPLELEA",
      transition: "D",
      clipName: "Maple Leaf Rag T14.wav",
      recordIn: 17,
    });
    expect(dissolve?.recordOut).toBeCloseTo(37.48);
    expect(edl.events[1]).toMatchObject({ clipName: "Take 12.wav", sourceIn: 36_005 });
    // A rate given is used as given; frame 27 means 30.
    expect(parseCmx3600(list, 30).fps).toBe(30);
    expect(parseCmx3600("001  AX  A  C  00:00:00:27 00:00:01:00 00:00:00:00 00:00:00:03").fps).toBe(
      30,
    );
    expect(parseCmx3600("FCM: DROP FRAME\n").fps).toBe(29.97);
    // A drop frame list is read at 29.97 even when another rate is asked for.
    expect(parseCmx3600("FCM: DROP FRAME\n", 25)).toMatchObject({ fps: 29.97, fpsGuessed: false });
  });

  it("matches each source to a take by clip name, reel or take number, and places it", () => {
    const takes = [
      take({ id: "12", number: 12, fileName: "Take 12.wav", start: 36_000, duration: 90 }),
      take({
        id: "14",
        number: 14,
        fileName: "Maple Leaf Rag T14.wav",
        start: 36_120,
        duration: 60,
        barFrom: 1,
        barTo: 30,
        inPoint: 0,
        outPoint: 60,
      }),
      take({ id: "9", number: 9, fileName: "Scratch.wav" }),
    ];
    const uses = matchEdl(parseCmx3600(list), takes);
    // Black is no take; the rest, in order.
    expect(uses.map((u) => u.takeId)).toEqual(["12", "14", "9", null]);
    expect(uses[0]).toMatchObject({ from: 5, to: 20, bars: null });
    // 10 s to 30.5 s of a minute of 30 bars, two seconds each: bars 6 to 16.
    expect(uses[1]?.from).toBeCloseTo(10);
    expect(uses[1]?.bars).toEqual([6, 16]);
    // T09 by its number; a file with no timecode starts at zero.
    expect(uses[2]).toMatchObject({ from: 1, to: 3 });
  });

  it("leaves a place it cannot find unknown rather than guessing", () => {
    const [use] = matchEdl(parseCmx3600(list), [
      take({ id: "12", number: 12, fileName: "Take 12.wav", start: 0, duration: 90 }),
    ]).filter((u) => u.takeId);
    expect(use).toMatchObject({ takeId: "12", from: null, to: null, bars: null });
  });

  it("reads every transition, and stays quick on lines made to be slow", () => {
    const keyed = parseCmx3600(
      "007  T3  A  K    B   030 00:00:01:00 00:00:02:00 01:00:00:00 01:00:01:00\n" +
        "008  T3  A  W001 015 00:00:02:00 00:00:03:00 01:00:01:00 01:00:02:00",
    );
    expect(keyed.events.map((e) => e.transition)).toEqual(["K B", "W001"]);
    const started = Date.now();
    const spaces = " ".repeat(200_000);
    parseCmx3600(`TITLE:${spaces}x\nFCM:${spaces}x\n*SOURCE FILE:${spaces}\n001${spaces}`);
    const [second] = parseCmx3600(list).events;
    if (second)
      matchEdl(
        { ...parseCmx3600(""), events: [{ ...second, reel: `t${"0".repeat(200_000)}` }] },
        [],
      );
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("spreads a take's bars over the part that counts", () => {
    const t = take({ barFrom: 9, barTo: 16, inPoint: 2, outPoint: 18 });
    // Two seconds a bar from 2 s: 6 s to 10 s is bars 11 and 12.
    expect(barsUsed(t, 6, 10)).toEqual([11, 12]);
    expect(barsUsed(t, 0, 4)).toEqual([9, 9]);
    expect(barsUsed(t, 20, 30)).toBeNull();
    expect(barsUsed(take({}), 0, 1)).toBeNull();
  });
});

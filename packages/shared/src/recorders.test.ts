import { describe, expect, it } from "vitest";
import {
  addFrames,
  POSITION_STALE_MS,
  parseTimecodeLabel,
  RECORDER_GONE_MS,
  type RecorderEvent,
  type RecorderTimecode,
  recorderClaimInput,
  recorderHeld,
  sameFrame,
  secondsOfTimecode,
  takeActionFor,
  timecodeAtFrame,
  timecodeLabel,
  timecodeNow,
} from "./recorders.ts";

const tc = (label: string, rate: RecorderTimecode["rate"] = "25") =>
  parseTimecodeLabel(label, rate) as RecorderTimecode;

describe("timecode arithmetic", () => {
  it("writes a label as the take log keeps it, with a semicolon where frames drop", () => {
    expect(timecodeLabel(tc("10:02:14:05"))).toBe("10:02:14:05");
    expect(timecodeLabel(tc("10:02:14;05", "29.97df"))).toBe("10:02:14;05");
  });

  it("moves a label on across seconds, drop-frame skips and midnight, either way", () => {
    expect(timecodeLabel(addFrames(tc("10:00:00:24"), 1))).toBe("10:00:01:00");
    expect(timecodeLabel(addFrames(tc("10:00:59;29", "29.97df"), 1))).toBe("10:01:00;02");
    expect(timecodeLabel(addFrames(tc("23:59:59:24"), 2))).toBe("00:00:00:01");
    expect(timecodeLabel(addFrames(tc("00:00:00:00"), -1))).toBe("23:59:59:24");
    expect(timecodeLabel(timecodeAtFrame(25 * 3600, "25"))).toBe("01:00:00:00");
  });

  it("gives the seconds a label stands for, at its rate", () => {
    expect(secondsOfTimecode(tc("01:00:00:00"))).toBe(3600);
    expect(secondsOfTimecode(tc("00:00:01:12"))).toBe(1.48);
    // An hour of 29.97 timecode, dropping frames, is 3600 seconds of labels in 3599.9964 s.
    expect(secondsOfTimecode(tc("01:00:00;00", "29.97df"))).toBeCloseTo(3599.9964, 3);
  });

  it("reads typed labels, refusing what the rate cannot show", () => {
    expect(parseTimecodeLabel("1:00:00:00", "25")).toMatchObject({ hours: 1 });
    expect(parseTimecodeLabel("01:00:00:25", "25")).toBeNull();
    expect(parseTimecodeLabel("24:00:00:00", "25")).toBeNull();
    expect(parseTimecodeLabel("10:01:00;00", "29.97df")).toBeNull();
    expect(parseTimecodeLabel("ten", "25")).toBeNull();
    expect(sameFrame(tc("01:00:00:00"), tc("01:00:00:00"))).toBe(true);
    expect(sameFrame(tc("01:00:00:00"), tc("01:00:00:00", "24"))).toBe(false);
  });
});

describe("timecodeNow", () => {
  const at = 1_000_000;
  it("holds a stopped recorder where it is", () => {
    expect(
      timecodeLabel(timecodeNow({ timecode: tc("01:00:00:00"), at, rolling: false }, at + 5000)),
    ).toBe("01:00:00:00");
  });

  it("plays a rolling one on from its last word, but not past a second of silence", () => {
    const position = { timecode: tc("01:00:00:00"), at, rolling: true };
    expect(timecodeLabel(timecodeNow(position, at + 520))).toBe("01:00:00:13");
    expect(timecodeLabel(timecodeNow(position, at + POSITION_STALE_MS + 9000))).toBe("01:00:01:00");
    expect(timecodeLabel(timecodeNow(position, at - 100))).toBe("01:00:00:00");
  });
});

describe("takeActionFor", () => {
  const at = 0;
  const record: RecorderEvent = { type: "record", timecode: tc("10:00:00:00"), at };
  const recordStop: RecorderEvent = { type: "record-stop", timecode: tc("10:01:00:00"), at };
  const rolling: RecorderEvent = { type: "rolling", timecode: tc("10:00:00:00"), at };
  const stopped: RecorderEvent = { type: "stopped", timecode: tc("10:01:00:00"), at };
  const recording = { id: "t1", lifecycle: "recording" as const };
  const armed = { id: "t2", lifecycle: "armed" as const };
  const done = { id: "t3", lifecycle: "recorded" as const };

  it("does nothing when the recorder only fills in timecode", () => {
    expect(takeActionFor(record, "off", null)).toBeNull();
    expect(takeActionFor(stopped, "off", recording)).toBeNull();
  });

  it("starts the next take when the recorder records, with its timecode and number", () => {
    expect(takeActionFor(record, "record", null)).toEqual({
      kind: "start",
      timecodeIn: "10:00:00:00",
      number: null,
    });
    expect(takeActionFor(record, "record", done)).toMatchObject({ kind: "start" });
    expect(
      takeActionFor({ ...record, take: { number: 27, name: "S12T27" } }, "record", null),
    ).toMatchObject({ number: 27 });
  });

  it("rolls the take armed rather than starting another, and leaves one recording be", () => {
    expect(takeActionFor(record, "record", armed)).toEqual({
      kind: "roll",
      takeId: "t2",
      timecodeIn: "10:00:00:00",
    });
    expect(takeActionFor(record, "record", recording)).toBeNull();
  });

  it("stops the take recording when recording stops, or the transport does", () => {
    expect(takeActionFor(recordStop, "record", recording)).toEqual({
      kind: "stop",
      takeId: "t1",
      timecodeOut: "10:01:00:00",
    });
    expect(takeActionFor(stopped, "record", recording)).toMatchObject({ kind: "stop" });
    expect(takeActionFor(recordStop, "record", armed)).toBeNull();
    expect(takeActionFor(recordStop, "record", null)).toBeNull();
  });

  it("on rolling, starts as the transport rolls and stops as it stops; record is not enough", () => {
    expect(takeActionFor(rolling, "rolling", null)).toMatchObject({ kind: "start", number: null });
    expect(takeActionFor(stopped, "rolling", recording)).toMatchObject({ kind: "stop" });
    expect(takeActionFor(record, "rolling", null)).toBeNull();
    expect(takeActionFor(recordStop, "rolling", recording)).toBeNull();
    expect(takeActionFor(rolling, "record", null)).toBeNull();
  });

  it("changes no take on a position or a status", () => {
    const position: RecorderEvent = {
      type: "position",
      position: { timecode: tc("10:00:00:00"), at, rolling: true },
    };
    expect(takeActionFor(position, "rolling", null)).toBeNull();
    expect(takeActionFor({ type: "status", status: { state: "idle" } }, "record", recording)).toBe(
      null,
    );
  });

  it("starts without timecode where the recorder gave none", () => {
    expect(takeActionFor({ type: "record", timecode: null, at }, "record", null)).toEqual({
      kind: "start",
      timecodeIn: null,
      number: null,
    });
  });
});

describe("the recorder's claim", () => {
  it("names an adapter plainly, and carries the connection's own claim", () => {
    const claim = "01a16b55-0000-7000-8000-000000000001";
    expect(recorderClaimInput.safeParse({ kind: "daw-midi", claim }).success).toBe(true);
    expect(recorderClaimInput.safeParse({ kind: "DAW MIDI", claim }).success).toBe(false);
    expect(recorderClaimInput.safeParse({ kind: "", claim }).success).toBe(false);
    expect(recorderClaimInput.safeParse({ kind: "daw-midi" }).success).toBe(false);
    expect(recorderClaimInput.safeParse({ kind: "daw-midi", claim: "tab 1" }).success).toBe(false);
  });

  it("holds while the browser driving it is heard from", () => {
    const now = new Date("2026-10-24T10:00:00Z");
    expect(recorderHeld(new Date(now.getTime() - 5000), now)).toBe(true);
    expect(recorderHeld(new Date(now.getTime() - RECORDER_GONE_MS - 1), now)).toBe(false);
    expect(recorderHeld(null, now)).toBe(false);
  });
});

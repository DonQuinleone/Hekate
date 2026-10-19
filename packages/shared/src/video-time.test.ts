import { describe, expect, it } from "vitest";
import { frameRates, timecode } from "./comment-export.ts";
import {
  frameShowing,
  frameTime,
  labelFrames,
  matteBars,
  parseTimecode,
  safeAreas,
  timecodeFor,
  videoClock,
  videoTimecode,
} from "./video-time.ts";

const label = (hours: number, minutes: number, seconds: number, frames: number) => ({
  hours,
  minutes,
  seconds,
  frames,
});

describe("videoClock", () => {
  it("counts at the standard rate nearest the file's own, from zero without a timecode", () => {
    expect(videoClock({ fps: 25 })).toEqual({ rate: frameRates["25"], start: 0 });
    expect(videoClock({ fps: 23.976 })?.rate).toBe(frameRates["23.976"]);
    expect(videoClock({})).toBeNull();
  });

  it("starts at the file's timecode and drops frames where it does", () => {
    expect(videoClock({ fps: 25, timecode: "10:00:00:00" })).toEqual({
      rate: frameRates["25"],
      start: 10 * 3600 * 25,
    });
    const ntsc = videoClock({ fps: 29.97, timecode: "01:00:00;00" });
    expect(ntsc?.rate).toBe(frameRates["29.97df"]);
    expect(ntsc?.start).toBe(107892);
    // A colon at 29.97 counts every label; a semicolon at 25 has no frames to drop.
    expect(videoClock({ fps: 29.97, timecode: "01:00:00:00" })?.rate).toBe(frameRates["29.97"]);
    expect(videoClock({ fps: 25, timecode: "01:00:00;00" })?.rate).toBe(frameRates["25"]);
  });

  it("ignores a timecode it cannot read", () => {
    expect(videoClock({ fps: 25, timecode: "ten o'clock" })?.start).toBe(0);
    expect(videoClock({ fps: 25, timecode: "00:00:00:30" })?.start).toBe(0);
  });
});

describe("labelFrames", () => {
  it("is the inverse of timecode, drop frame included", () => {
    for (const id of ["25", "29.97df", "59.94df", "23.976"] as const) {
      const rate = frameRates[id];
      for (const frames of [0, 1, 1799, 1800, 1801, 17982, 107892, 123456]) {
        const [h, m, s, f] = timecode(frames, rate).split(/[:;]/).map(Number);
        expect(labelFrames(label(h ?? 0, m ?? 0, s ?? 0, f ?? 0), rate)).toBe(frames);
      }
    }
  });

  it("refuses a label the rate never shows", () => {
    const df = frameRates["29.97df"];
    expect(labelFrames(label(0, 1, 0, 0), df)).toBeNull();
    expect(labelFrames(label(0, 1, 0, 1), df)).toBeNull();
    expect(labelFrames(label(0, 1, 0, 2), df)).toBe(1800);
    // Every tenth minute keeps its first frames.
    expect(labelFrames(label(0, 10, 0, 0), df)).toBe(17982);
    expect(labelFrames(label(0, 0, 0, 25), frameRates["25"])).toBeNull();
    expect(labelFrames(label(0, 60, 0, 0), frameRates["25"])).toBeNull();
  });
});

describe("frames and time", () => {
  it("shows a frame from its own time until the next", () => {
    const rate = frameRates["25"];
    expect(frameShowing(0, rate)).toBe(0);
    expect(frameShowing(0.039, rate)).toBe(0);
    expect(frameShowing(0.04, rate)).toBe(1);
    // Stepping a frame at a time adds up to a hair short; it is still that frame.
    let t = 0;
    for (let i = 0; i < 300; i++) t += 1 / 25;
    expect(frameShowing(t, rate)).toBe(300);
    expect(frameShowing(frameTime(1798, frameRates["29.97df"]), frameRates["29.97df"])).toBe(1798);
  });

  it("writes the time on the file's own clock, and a length from zero", () => {
    const clock = videoClock({ fps: 25, timecode: "10:00:00:00" });
    if (!clock) throw new Error("no clock");
    expect(videoTimecode(72.32, clock)).toBe("10:01:12:08");
    expect(timecodeFor(90, clock)).toBe("00:01:30:00");
    const ntsc = videoClock({ fps: 29.97, timecode: "00:00:00;00" });
    if (!ntsc) throw new Error("no clock");
    expect(videoTimecode(frameTime(1800, ntsc.rate), ntsc)).toBe("00:01:00;02");
  });
});

describe("parseTimecode", () => {
  const clock = { rate: frameRates["25"], start: 10 * 3600 * 25 };

  it("reads a full timecode on the file's clock", () => {
    expect(parseTimecode("10:00:12:08", clock)).toBe(12 * 25 + 8);
    expect(parseTimecode("10001208", clock)).toBe(12 * 25 + 8);
    expect(parseTimecode(" 10.00.12.08 ", clock)).toBe(12 * 25 + 8);
  });

  it("counts anything shorter from the start, right-aligned", () => {
    expect(parseTimecode("12:00", clock)).toBe(300);
    expect(parseTimecode("1200", clock)).toBe(300);
    expect(parseTimecode("5", clock)).toBe(5);
    expect(parseTimecode("1:00:00", clock)).toBe(1500);
  });

  it("reads fewer than eight digits as a time from the start", () => {
    expect(parseTimecode("1001208", clock)).toBe((60 * 60 + 12) * 25 + 8);
  });

  it("reads a label earlier than the file as the next day's, as timecode wraps at midnight", () => {
    const late = {
      rate: frameRates["25"],
      start: labelFrames(label(23, 59, 59, 0), frameRates["25"]) ?? 0,
    };
    expect(parseTimecode("00:00:01:00", late)).toBe(50);
    // Before the file's first frame is a day later: past the end of any file.
    expect(parseTimecode("09:59:59:24", clock)).toBe(24 * 3600 * 25 - 1);
  });

  it("refuses what is not a timecode here", () => {
    expect(parseTimecode("", clock)).toBeNull();
    expect(parseTimecode("twelve", clock)).toBeNull();
    expect(parseTimecode("12::00", clock)).toBeNull();
    expect(parseTimecode("00:00:00:25", clock)).toBeNull();
    expect(parseTimecode("24:00:00:00", clock)).toBeNull();
    expect(parseTimecode("1:00:00:00:00", clock)).toBeNull();
    const ntsc = { rate: frameRates["29.97df"], start: 0 };
    expect(parseTimecode("00:01:00;00", ntsc)).toBeNull();
    expect(parseTimecode("00:01:00;02", ntsc)).toBe(1800);
  });
});

describe("matteBars", () => {
  it("lays bars above and below a wider matte, and either side of a narrower one", () => {
    const wide = matteBars(16 / 9, 2.39);
    expect(wide.side).toBe(0);
    expect(wide.top).toBeCloseTo((1 - 16 / 9 / 2.39) / 2, 6);
    const square = matteBars(16 / 9, 4 / 3);
    expect(square.top).toBe(0);
    expect(square.side).toBeCloseTo(0.125, 6);
    expect(matteBars(1.85, 1.85)).toEqual({ top: 0, side: 0 });
    expect(matteBars(0, 2.39)).toEqual({ top: 0, side: 0 });
  });

  it("keeps safe areas at the broadcast standard", () => {
    expect(safeAreas.action).toBeCloseTo(0.035, 6);
    expect(safeAreas.title).toBeCloseTo(0.05, 6);
  });
});

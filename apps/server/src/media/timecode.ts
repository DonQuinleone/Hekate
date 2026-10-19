import {
  frameShowing,
  labelFrames,
  type MediaInfo,
  type QaFinding,
  timecode,
  timecodePattern,
  type VideoClock,
  videoClock,
} from "@hekate/shared";

/**
 * Timecode continuity, part of the video QA (#42). A file writes where its timecode starts,
 * sometimes in more than one place; its picture may also carry a timecode on its frames (an
 * MPEG-2 group of pictures, an H.264 or HEVC picture-timing message), which `showinfo`
 * prints as the frames pass in the picture checks' decode. Each carried timecode should be
 * the first one plus the frames since: one that is not is a break, where an edit or a
 * recording restarted the count.
 */

/** At most so many breaks are listed, so a broken file does not flood the findings. */
const MAX_BREAKS = 100;

/** The timecode in a `showinfo` side-data line: a GOP's, or the first of an SMPTE 12-1 set. */
const carried = /side data - (GOP|SMPTE 12-1) timecode:\D*(\d{2}:\d{2}:\d{2}[:;.]\d{2})/;
const frameLine = /\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:(-?[\d.e+-]+)/;

interface Break {
  at: number;
  expected: string;
  found: string;
}

/** The frame count a written timecode stands for at a clock's rate; null where it cannot be. */
function framesOf(label: string, clock: VideoClock): number | null {
  const m = timecodePattern.exec(label.replace(".", ":"));
  if (!m) return null;
  return labelFrames(
    { hours: Number(m[1]), minutes: Number(m[2]), seconds: Number(m[3]), frames: Number(m[5]) },
    clock.rate,
  );
}

export class TimecodeChecks {
  private readonly video: NonNullable<MediaInfo["video"]>;
  private clock: VideoClock | null;
  private day: number;
  private carry = "";
  /** The time of the frame being read, and of the first frame. */
  private time: number | null = null;
  private origin: number | null = null;
  /** The first carried timecode, as written, and where it was. */
  private first: string | null = null;
  /** What the count is reckoned from: a carried timecode's frames, at a time. */
  private anchor: { frames: number; at: number } | null = null;
  private carriedFrames = 0;
  private breakCount = 0;
  private readonly breaks: Break[] = [];

  constructor(video: NonNullable<MediaInfo["video"]>) {
    this.video = video;
    this.clock = videoClock(video);
    this.day = this.dayOf(this.clock);
  }

  private dayOf(clock: VideoClock | null) {
    return clock
      ? (labelFrames({ hours: 24, minutes: 0, seconds: 0, frames: 0 }, clock.rate) ?? 0)
      : 0;
  }

  /** Read more of ffmpeg's log. */
  push(chunk: Buffer | string) {
    const text = this.carry + chunk.toString();
    const lines = text.split("\n");
    this.carry = lines.pop() ?? "";
    for (const line of lines) this.line(line);
  }

  private line(line: string) {
    if (!line.includes("Parsed_showinfo")) return;
    const frame = frameLine.exec(line);
    if (frame) {
      const t = Number(frame[1]);
      this.time = Number.isFinite(t) ? t : null;
      if (this.time !== null) this.origin ??= this.time;
      return;
    }
    const tc = carried.exec(line);
    if (tc?.[2] && this.time !== null)
      this.carriedAt(tc[2], this.time - (this.origin ?? 0), tc[1] === "GOP");
  }

  private carriedAt(label: string, at: number, group: boolean) {
    // Where the file writes no start, the frames' own timecode says whether it drops frames.
    if (this.first === null && !this.video.timecode && timecodePattern.test(label)) {
      this.clock = videoClock({ fps: this.video.fps, timecode: label });
      this.day = this.dayOf(this.clock);
    }
    const clock = this.clock;
    if (!clock) return;
    const frames = framesOf(label, clock);
    if (frames === null) return;
    this.carriedFrames += 1;
    this.first ??= label;
    const anchor = this.anchor;
    this.anchor = { frames, at };
    if (!anchor) return;
    const expected = anchor.frames + frameShowing(at - anchor.at, clock.rate);
    const off = this.day > 0 ? (((frames - expected) % this.day) + this.day) % this.day : 0;
    // ffmpeg's MPEG-2 decoder gives a group's timecode to the frame before the group's first.
    if (off === 0 || (group && off === 1)) {
      // On time: keep counting from the earlier anchor, so rounding never accumulates.
      this.anchor = anchor;
      return;
    }
    this.breakCount += 1;
    if (this.breaks.length < MAX_BREAKS)
      this.breaks.push({
        at,
        expected: timecode(expected % this.day, clock.rate),
        found: label,
      });
  }

  finish(): QaFinding[] {
    if (this.carry) this.line(this.carry);
    this.carry = "";
    const clock = this.clock;
    const out: QaFinding[] = [];
    const finding = (
      severity: QaFinding["severity"],
      summary: string,
      at: number | null,
      details: QaFinding["details"],
    ) =>
      out.push({
        check: "timecode",
        severity,
        summary,
        channel: null,
        start: at === null ? null : Math.round(at * 1000) / 1000,
        end: at === null ? null : Math.round(at * 1000) / 1000,
        details,
      });
    // Without a frame rate no timecode can be counted; said, so the check is seen to have run.
    if (!clock) {
      finding("info", "The frame rate is not known, so the timecode cannot be counted", null, {
        timecode: this.video.timecode ?? null,
      });
      return out;
    }
    const declared = this.video.timecode ?? null;
    const written = this.video.timecodes ?? [];
    if (written.length > 1)
      finding(
        "warn",
        `The file writes ${written.length} different start timecodes: ${written.join(", ")}`,
        null,
        { timecodes: written.join(", ") },
      );
    if (declared?.includes(";") && !clock.rate.drop)
      finding(
        "warn",
        `Drop-frame timecode at ${clock.rate.nominal} fps, where no frames are dropped`,
        null,
        { timecode: declared, fps: this.video.fps ?? null },
      );
    if (declared && this.first && framesOf(declared, clock) !== framesOf(this.first, clock))
      finding(
        "warn",
        `The picture's own timecode starts at ${this.first}; the file says ${declared}`,
        0,
        { timecode: declared, carried: this.first },
      );
    for (const b of this.breaks)
      finding("fail", `Timecode jumps from ${b.expected} to ${b.found}`, b.at, {
        expected: b.expected,
        found: b.found,
      });
    if (this.breakCount > this.breaks.length)
      finding("fail", `${this.breakCount - this.breaks.length} more breaks in the timecode`, null, {
        breaks: this.breakCount,
      });
    const start = declared ?? this.first;
    if (this.breakCount === 0 && start)
      finding("pass", `Continuous from ${start}`, null, {
        timecode: start,
        carried: this.carriedFrames,
      });
    if (!start) finding("info", "No timecode: counted from 00:00:00:00", null, { timecode: null });
    return out;
  }
}

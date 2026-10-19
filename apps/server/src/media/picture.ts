import type { MediaInfo, QaFinding } from "@hekate/shared";
import { MediaToolError, run, safeInputArgs } from "./ffmpeg.ts";

/**
 * The picture checks of the video QA (#42): black, frozen and missing frames, interlacing,
 * broadcast-safe levels, letterboxing and flashing, read from ffmpeg's per-frame measurements
 * as they stream past in one decode. Like the audio's signal checks they do not depend on the
 * project, and each reports a pass when it finds nothing, so a report says what was checked.
 */

/** Black or frozen this long, seconds, is worth saying. */
const BLACK_MIN = 1;
const FREEZE_MIN = 2;
/** A still picture covering this share of the video is a still image, not a fault. */
const STILL_SHARE = 0.9;
/** A gap this many frames long, or longer, between frames means frames are missing. */
const GAP_FRAMES = 1.5;
/** Luma outside EBU R103's range on more than this share of a frame makes it unsafe. */
const LEVELS_AREA = 0.01;
/** Unsafe passages shorter than this are left alone: a sparkle, not a grade. */
const LEVELS_MIN = 0.2;
/** A change in screen luminance of this much, cd/m², is a transition (ITU-R BT.1702). */
const FLASH_STEP = 20;
/** ...when the darker side is below this. */
const FLASH_DARK = 160;
/** More than three flashes (six transitions) in any second is too many (Ofcom). */
const FLASH_TRANSITIONS = 6;
/** The share of a picture's edge that a bar must take to count as letterboxing. */
const BAR_SHARE = 0.01;
/** Passages this close together are one, seconds. */
const MERGE = 1;
/** At most so many findings of one check, so a broken file does not flood the list. */
const MAX_EVENTS = 100;

interface Span {
  start: number;
  end: number;
  /** Events merged into it. */
  count: number;
  /** The worst value seen in it, where the check has one, and their sum. */
  worst: number;
  sum: number;
}

/** Spans of one check, those close together merged. */
class Spans {
  readonly list: Span[] = [];
  total = 0;
  private readonly merge: number;

  constructor(merge = MERGE) {
    this.merge = merge;
  }

  add(start: number, end: number, worst = 0) {
    this.total += 1;
    const last = this.list.at(-1);
    if (last && start - last.end <= this.merge) {
      last.end = Math.max(last.end, end);
      last.count += 1;
      last.worst = Math.max(last.worst, worst);
      last.sum += worst;
      return;
    }
    if (this.list.length >= MAX_EVENTS) return;
    this.list.push({ start, end, count: 1, worst, sum: worst });
  }
}

const round = (t: number) => Math.round(t * 1000) / 1000;
const seconds = (t: number) => `${t.toFixed(1)} s`;

/** The bits per component of a pixel format: `yuv420p10le` is 10; 8 where it does not say. */
export function pixelDepth(pixelFormat: string | undefined): number {
  const m = /p(\d+)(?:le|be)$/.exec(pixelFormat ?? "");
  return m ? Number(m[1]) : 8;
}

/**
 * Whether a format's levels can be judged against broadcast range: limited-range YUV. Full
 * range (`yuvj`) and RGB have no headroom to be outside of.
 */
export function limitedRange(pixelFormat: string | undefined): boolean {
  if (!pixelFormat) return true;
  return /^(yuv|yuva|nv|p0|p2|y210|uyvy|yuyv)/.test(pixelFormat) && !pixelFormat.startsWith("yuvj");
}

/** What a picture's frames are measured with, in the order they run. */
export function pictureFilters(): string {
  return [
    // Field order first, on the picture as it was made.
    "idet",
    // The bounds of everything that is not black, over the whole video.
    "cropdetect=limit=0.094:round=2:reset=0",
    // The rest needs no more than a small picture.
    "scale=w='min(iw,640)':h=-2:flags=area",
    "blackdetect=d=0:pix_th=0.10",
    "freezedetect=n=-60dB:d=2",
    // EBU R103 allows luma from −1% to 103%: what lies inside that is moved into the nominal
    // range, and the colour set to grey, so signalstats's count of pixels outside it (16 to
    // 235, which compression undershoots at every black edge) counts only what R103 refuses.
    "lutyuv=y='if(between(val,minval-0.01*(maxval-minval),minval),minval,if(between(val,maxval,maxval+0.03*(maxval-minval)),maxval,val))':u='(minval+maxval)/2':v='(minval+maxval)/2'",
    "signalstats=stat=brng",
    "metadata=mode=print:file=-",
  ].join(",");
}

/**
 * The picture checks, read from the lines `metadata=mode=print` writes: a `frame:` line with
 * its time, then that frame's `lavfi.` keys.
 */
export class PictureChecks {
  private readonly fps: number | undefined;
  private readonly width: number;
  private readonly height: number;
  private readonly depthScale: number;
  private readonly limited: boolean;
  private readonly fullRange: boolean;
  private carry = "";

  /** The frame being read: its time, and its keys so far. */
  private time: number | null = null;
  private keys = new Map<string, string>();
  /** The first frame's time, which every other is counted from. */
  private origin: number | null = null;
  private last: number | null = null;
  private step: number | null = null;
  frames = 0;

  private blackFrom: number | null = null;
  private readonly black = new Spans(0);
  private freezeFrom: number | null = null;
  private readonly frozen = new Spans(0);
  private readonly gaps = new Spans();
  private missing = 0;
  private fields = { tff: 0, bff: 0, progressive: 0, undetermined: 0 };
  private bounds: { x1: number; x2: number; y1: number; y2: number } | null = null;
  private readonly unsafe = new Spans();
  private lumaMin = Number.POSITIVE_INFINITY;
  private lumaMax = Number.NEGATIVE_INFINITY;

  // Flashing: the direction the luminance is moving, how far it has gone, and recent transitions.
  private direction = 0;
  private extreme = 0;
  private low = Number.POSITIVE_INFINITY;
  private high = Number.NEGATIVE_INFINITY;
  private transitions: number[] = [];
  private readonly flashes = new Spans();

  constructor(video: NonNullable<MediaInfo["video"]>) {
    this.fps = video.fps;
    this.width = video.width;
    this.height = video.height;
    this.depthScale = 2 ** (pixelDepth(video.pixelFormat) - 8);
    this.limited = limitedRange(video.pixelFormat);
    this.fullRange = video.pixelFormat?.startsWith("yuvj") ?? false;
  }

  /** Read more of ffmpeg's output. */
  push(chunk: Buffer | string) {
    const text = this.carry + chunk.toString();
    const lines = text.split("\n");
    this.carry = lines.pop() ?? "";
    for (const line of lines) this.line(line);
  }

  private line(line: string) {
    if (line.startsWith("frame:")) {
      this.endFrame();
      const t = Number(/pts_time:(\S+)/.exec(line)?.[1]);
      this.time = Number.isFinite(t) ? t : null;
      return;
    }
    const eq = line.indexOf("=");
    if (line.startsWith("lavfi.") && eq > 0) {
      this.keys.set(line.slice(6, eq), line.slice(eq + 1).trim());
    }
  }

  private num(key: string): number | null {
    const value = this.keys.get(key);
    if (value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  /** A time ffmpeg gives, counted from the first frame. */
  private at(t: number) {
    return Math.max(0, t - (this.origin ?? 0));
  }

  private endFrame() {
    const time = this.time;
    if (time === null) {
      this.keys.clear();
      return;
    }
    this.origin ??= time;
    const t = this.at(time);
    this.frames += 1;

    // Missing frames: a gap longer than the frame rate allows.
    if (this.last !== null) {
      const delta = t - this.last;
      if (delta > 0) this.step ??= delta;
      const frame = this.fps ? 1 / this.fps : null;
      if (frame && delta > GAP_FRAMES * frame) {
        const count = Math.round(delta / frame) - 1;
        this.missing += count;
        this.gaps.add(this.last + frame, t, count);
      }
    }
    this.last = t;

    const blackStart = this.num("black_start");
    if (blackStart !== null) this.blackFrom = this.at(blackStart);
    const blackEnd = this.num("black_end");
    if (blackEnd !== null && this.blackFrom !== null) {
      this.addBlack(this.blackFrom, this.at(blackEnd));
      this.blackFrom = null;
    }
    const freezeStart = this.num("freezedetect.freeze_start");
    if (freezeStart !== null) this.freezeFrom = this.at(freezeStart);
    const freezeEnd = this.num("freezedetect.freeze_end");
    if (freezeEnd !== null && this.freezeFrom !== null) {
      this.addFrozen(this.freezeFrom, this.at(freezeEnd));
      this.freezeFrom = null;
    }

    const tff = this.num("idet.multiple.tff");
    if (tff !== null) {
      this.fields = {
        tff,
        bff: this.num("idet.multiple.bff") ?? 0,
        progressive: this.num("idet.multiple.progressive") ?? 0,
        undetermined: this.num("idet.multiple.undetermined") ?? 0,
      };
    }
    const x1 = this.num("cropdetect.x1");
    const x2 = this.num("cropdetect.x2");
    const y1 = this.num("cropdetect.y1");
    const y2 = this.num("cropdetect.y2");
    if (x1 !== null && x2 !== null && y1 !== null && y2 !== null) this.bounds = { x1, x2, y1, y2 };

    const yavg = this.num("signalstats.YAVG");
    const ymin = this.num("signalstats.YMIN");
    const ymax = this.num("signalstats.YMAX");
    const brng = this.num("signalstats.BRNG");
    if (ymin !== null && ymax !== null && brng !== null && this.limited) {
      if (brng > LEVELS_AREA) {
        this.unsafe.add(t, t + this.frame(), brng);
        this.lumaMin = Math.min(this.lumaMin, ymin / this.depthScale);
        this.lumaMax = Math.max(this.lumaMax, ymax / this.depthScale);
      }
    }
    if (yavg !== null) this.flash(t, this.luminance(yavg));
    this.keys.clear();
    this.time = null;
  }

  /** How long a frame lasts, seconds. */
  private frame() {
    return this.fps ? 1 / this.fps : (this.step ?? 1 / 25);
  }

  /** Mean luma as screen luminance, cd/m², on BT.1702's 200 cd/m² display. */
  private luminance(yavg: number) {
    const code = yavg / this.depthScale;
    const signal = this.fullRange ? code / 255 : (code - 16) / 219;
    return 200 * Math.min(1, Math.max(0, signal)) ** 2.2;
  }

  /**
   * Screen-wide flashing: transitions of FLASH_STEP or more, turning back and forth, with the
   * darker side under FLASH_DARK; more than FLASH_TRANSITIONS of them in a second is a passage.
   */
  private flash(t: number, l: number) {
    let turned = false;
    let darker = 0;
    if (this.direction === 0) {
      this.low = Math.min(this.low, l);
      this.high = Math.max(this.high, l);
      if (this.high - this.low >= FLASH_STEP) {
        this.direction = l === this.high ? 1 : -1;
        turned = true;
        darker = this.low;
        this.extreme = l;
      }
    } else if (this.direction * (l - this.extreme) > 0) {
      this.extreme = l;
    } else if (Math.abs(l - this.extreme) >= FLASH_STEP) {
      darker = Math.min(l, this.extreme);
      this.direction = -this.direction;
      this.extreme = l;
      turned = true;
    }
    if (!turned || darker >= FLASH_DARK) return;
    this.transitions.push(t);
    while ((this.transitions[0] ?? t) < t - 1) this.transitions.shift();
    if (this.transitions.length > FLASH_TRANSITIONS) {
      this.flashes.add(this.transitions[0] ?? t, t, this.transitions.length / 2);
    }
  }

  private addBlack(start: number, end: number) {
    if (end - start >= BLACK_MIN) this.black.add(start, end);
  }

  private addFrozen(start: number, end: number) {
    if (end - start >= FREEZE_MIN) this.frozen.add(start, end);
  }

  /** The findings, once ffmpeg has finished. */
  finish(): QaFinding[] {
    if (this.carry) this.line(this.carry);
    this.carry = "";
    this.endFrame();
    if (this.frames === 0 || this.last === null) return [];
    const length = this.last + this.frame();
    // Passages still open at the end run to it.
    if (this.blackFrom !== null) this.addBlack(this.blackFrom, length);
    if (this.freezeFrom !== null) this.addFrozen(this.freezeFrom, length);
    this.blackFrom = null;
    this.freezeFrom = null;
    const edge = this.frame() * 1.5;
    const atStart = (s: Span) => s.start <= edge;
    const atEnd = (s: Span) => s.end >= length - edge;
    const out: QaFinding[] = [];
    const finding = (
      check: QaFinding["check"],
      severity: QaFinding["severity"],
      summary: string,
      span: Pick<Span, "start" | "end"> | null,
      details: QaFinding["details"] = {},
    ) =>
      out.push({
        check,
        severity,
        summary,
        channel: null,
        start: span ? round(span.start) : null,
        end: span ? round(span.end) : null,
        details,
      });

    // Black: at either end is how films start and finish; inside, it is worth a look.
    const blackThroughout = this.black.list.some((s) => atStart(s) && atEnd(s));
    if (blackThroughout) {
      finding("black-frames", "fail", "The picture is black throughout", null);
    } else {
      for (const s of this.black.list) {
        const where = atStart(s) ? " at the start" : atEnd(s) ? " at the end" : "";
        finding(
          "black-frames",
          where ? "info" : "warn",
          `Black for ${seconds(s.end - s.start)}${where}`,
          s,
          { seconds: round(s.end - s.start) },
        );
      }
      if (this.black.list.length === 0) finding("black-frames", "pass", "No black frames", null);
    }

    // Frozen: not where the picture is black (black is still too), and a still image is meant.
    const inBlack = (s: Span) =>
      this.black.list.reduce(
        (sum, b) => sum + Math.max(0, Math.min(s.end, b.end) - Math.max(s.start, b.start)),
        0,
      ) >=
      0.8 * (s.end - s.start);
    const frozen = this.frozen.list.filter((s) => !inBlack(s));
    const still = frozen.reduce((sum, s) => sum + (s.end - s.start), 0);
    if (!blackThroughout && still >= STILL_SHARE * length) {
      finding("frozen-frames", "info", "A still picture throughout", null);
    } else {
      for (const s of frozen) {
        const where = atStart(s) ? " at the start" : atEnd(s) ? " at the end" : "";
        finding(
          "frozen-frames",
          where ? "info" : "warn",
          `Frozen for ${seconds(s.end - s.start)}${where}`,
          s,
          { seconds: round(s.end - s.start) },
        );
      }
      if (frozen.length === 0) finding("frozen-frames", "pass", "No frozen frames", null);
    }

    // Missing frames, where the frame rate says how many there should be.
    if (this.fps) {
      for (const s of this.gaps.list) {
        finding(
          "dropped-frames",
          "warn",
          s.sum > 1 ? `${s.sum} frames missing` : "A frame missing",
          s,
          { frames: s.sum, totalInFile: this.missing },
        );
      }
      if (this.gaps.list.length === 0)
        finding("dropped-frames", "pass", "No missing frames", null, { frames: this.frames });
    }

    out.push(...this.interlacing());
    out.push(...this.letterbox(blackThroughout));

    // Levels, where the format has a broadcast range to keep to.
    if (this.limited) {
      const unsafe = this.unsafe.list.filter((s) => s.end - s.start >= LEVELS_MIN);
      for (const s of unsafe) {
        finding(
          "broadcast-levels",
          "warn",
          `Outside broadcast-safe levels for ${seconds(s.end - s.start)}`,
          s,
          {
            share: round(s.worst),
            // The extremes across the file, as 8-bit codes.
            lumaMinInFile: Math.round(this.lumaMin),
            lumaMaxInFile: Math.round(this.lumaMax),
          },
        );
      }
      if (unsafe.length === 0)
        finding("broadcast-levels", "pass", "Within broadcast-safe levels", null);
    }

    for (const s of this.flashes.list) {
      finding(
        "flashing",
        "warn",
        `Screen-wide flashing for ${seconds(Math.max(s.end - s.start, this.frame()))}, more than 3 flashes a second`,
        s,
        { flashesPerSecond: round(s.worst) },
      );
    }
    if (this.flashes.list.length === 0)
      finding("flashing", "pass", "No screen-wide flashing", null);
    return out;
  }

  /**
   * Field order, from idet's count of frames that look interlaced. Real interlacing keeps
   * one field order throughout; a progressive picture it misreads splits between the two.
   */
  private interlacing(): QaFinding[] {
    const { tff, bff, progressive, undetermined } = this.fields;
    const determined = tff + bff + progressive;
    const order = Math.max(tff, bff);
    const other = Math.min(tff, bff);
    const share = determined > 0 ? order / determined : 0;
    const consistent = order > 0 && order >= 4 * other;
    const first = tff >= bff ? "top field first" : "bottom field first";
    const details = { tff, bff, progressive, undetermined };
    const base = { check: "interlacing" as const, channel: null, start: null, end: null, details };
    if (determined >= 25 && consistent && share >= 0.8)
      return [{ ...base, severity: "info", summary: `Interlaced, ${first}` }];
    if (determined >= 25 && consistent && share >= 0.1)
      return [
        {
          ...base,
          severity: "warn",
          summary: `Partly interlaced: ${Math.round(share * 100)}% of frames, ${first}`,
        },
      ];
    return [{ ...base, severity: "pass", summary: "Progressive" }];
  }

  /** Bars the picture never reaches into, over the whole video. */
  private letterbox(blackThroughout: boolean): QaFinding[] {
    const b = this.bounds;
    if (!b || blackThroughout || b.x2 <= b.x1 || b.y2 <= b.y1) return [];
    const top = b.y1;
    const bottom = this.height - 1 - b.y2;
    const left = b.x1;
    const right = this.width - 1 - b.x2;
    const tall = top > BAR_SHARE * this.height && bottom > BAR_SHARE * this.height;
    const wide = left > BAR_SHARE * this.width && right > BAR_SHARE * this.width;
    const w = b.x2 - b.x1 + 1;
    const h = b.y2 - b.y1 + 1;
    const details = { top, bottom, left, right, width: w, height: h };
    const base = { check: "letterbox" as const, channel: null, start: null, end: null, details };
    if (!tall && !wide)
      return [{ ...base, severity: "pass", summary: "The picture fills the frame" }];
    const kind = tall && wide ? "Windowboxed" : tall ? "Letterboxed" : "Pillarboxed";
    return [
      {
        ...base,
        severity: "info",
        summary: `${kind}: the picture is ${w}×${h} inside ${this.width}×${this.height} (${(w / h).toFixed(2)}:1)`,
      },
    ];
  }
}

/** Measure a video's picture in one decode, without keeping its frames or their numbers. */
export async function analysePicture(
  input: string,
  video: NonNullable<MediaInfo["video"]>,
  signal?: AbortSignal,
): Promise<QaFinding[]> {
  const checks = new PictureChecks(video);
  await run(
    "ffmpeg",
    [
      ...safeInputArgs("ffmpeg"),
      "-v",
      "error",
      "-i",
      `file:${input}`,
      "-map",
      "0:v:0",
      "-vf",
      pictureFilters(),
      "-f",
      "null",
      "-",
    ],
    { signal, timeoutMs: 60 * 60_000, onStdout: (chunk) => checks.push(chunk) },
  );
  const findings = checks.finish();
  // Not one frame: the picture cannot be read, which no finding should pass over.
  if (checks.frames === 0) throw new MediaToolError("No frame of the picture could be read");
  return findings;
}

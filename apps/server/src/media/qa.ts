import { channelName, type QaCheck, type QaFinding } from "@hekate/shared";

/**
 * The signal checks of the audio QA (#41): read from the samples as they stream past in
 * the analysis decode (interleaved 32-bit float), never holding the recording in memory.
 * Each check reports what it found where, or a pass, so a report says what was checked.
 */

/** A sample this close to full scale is taken as clipped. */
const FULL_SCALE = 0.9999;
/** So many full-scale samples in a row are a clip. */
const CLIP_RUN = 3;
/** So many identical samples in a row, high up, are a flattened (clipped, then lowered) peak. */
const FLAT_RUN = 4;
/** ...and high up means at least this share of full scale. */
const FLAT_LEVEL = 0.5;
/** Digital silence inside the music this long is a dropout, seconds. */
const DROPOUT = 0.02;
/** Digital silence at either end this long is worth saying, seconds. */
const EDGE_SILENCE = 1;
/** A DC offset above −60 dBFS is worth saying. */
const DC_LIMIT = 0.001;
/** Events this close together are one passage, seconds. */
const MERGE = 0.25;
/** At most so many findings of one check, so a broken file does not flood the list. */
const MAX_EVENTS = 100;

interface Passage {
  channel: number | null;
  start: number;
  end: number;
  /** Events merged into it, and the longest of them in samples. */
  count: number;
  longest: number;
}

/** Events of one check gathered into passages, per channel. */
class Passages {
  readonly list: Passage[] = [];
  total = 0;
  private open = new Map<number | null, Passage>();

  add(channel: number | null, start: number, end: number, length: number) {
    this.total += 1;
    const current = this.open.get(channel);
    if (current && start - current.end <= MERGE) {
      current.end = end;
      current.count += 1;
      current.longest = Math.max(current.longest, length);
      return;
    }
    if (this.list.length >= MAX_EVENTS) return;
    const passage = { channel, start, end, count: 1, longest: length };
    this.list.push(passage);
    this.open.set(channel, passage);
  }
}

const round = (t: number) => Math.round(t * 1000) / 1000;
const db = (linear: number) => 20 * Math.log10(Math.max(linear, 1e-12));

export class SignalChecks {
  readonly channels: number;
  readonly sampleRate: number;
  private carry = Buffer.alloc(0);
  private channel = 0;
  /** Sample frames (one sample per channel) seen. */
  private frame = 0;

  // Clipping and flattened peaks, per channel.
  private clipRun: Uint32Array;
  private flatRun: Uint32Array;
  private flatValue: Float32Array;
  private readonly clips = new Passages();
  private readonly flats = new Passages();

  // DC offset, per channel.
  private sums: Float64Array;

  // Clicks: the two samples before, and how much the signal usually moves, per channel.
  private before2: Float32Array;
  private before1: Float32Array;
  private movement: Float32Array;
  private readonly clicks = new Passages();
  private readonly settle: number;

  // Digital silence across every channel.
  private frameSilent = true;
  private zeroRun = 0;
  private readonly dropouts = new Passages();
  /** Longer digital silences inside the music: pauses, most likely meant. */
  private readonly gaps = new Passages();
  private leading = 0;
  private trailing = 0;

  // The front pair, for phase and mono fold-down.
  private left = 0;
  private lr = 0;
  private ll = 0;
  private rr = 0;

  constructor(channels: number, sampleRate: number) {
    this.channels = channels;
    this.sampleRate = sampleRate;
    this.clipRun = new Uint32Array(channels);
    this.flatRun = new Uint32Array(channels);
    this.flatValue = new Float32Array(channels);
    this.sums = new Float64Array(channels);
    this.before2 = new Float32Array(channels);
    this.before1 = new Float32Array(channels);
    this.movement = new Float32Array(channels);
    // How fast the usual movement follows the music: about 10 ms.
    this.settle = 1 / Math.max(1, 0.01 * sampleRate);
  }

  /** How much has been decoded, in seconds. */
  get seconds(): number {
    return this.frame / this.sampleRate;
  }

  push(chunk: Buffer): void {
    const bytes = this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : chunk;
    const whole = bytes.length - (bytes.length % 4);
    for (let offset = 0; offset < whole; offset += 4) {
      this.sample(this.channel, bytes.readFloatLE(offset));
      this.channel += 1;
      if (this.channel === this.channels) {
        this.channel = 0;
        this.endFrame();
      }
    }
    this.carry = Buffer.from(bytes.subarray(whole));
  }

  private time(frame: number) {
    return round(frame / this.sampleRate);
  }

  private sample(c: number, x: number): void {
    const level = Math.abs(x);
    if (x !== 0) this.frameSilent = false;
    this.sums[c] = (this.sums[c] as number) + x;

    // Clipping: full-scale samples in a row.
    if (level >= FULL_SCALE) this.clipRun[c] = (this.clipRun[c] as number) + 1;
    else this.endClip(c);

    // Flattened peaks: the same high value in a row, below full scale.
    if (level >= FLAT_LEVEL && level < FULL_SCALE && x === this.flatValue[c]) {
      this.flatRun[c] = (this.flatRun[c] as number) + 1;
    } else {
      this.endFlat(c);
      this.flatValue[c] = x;
      this.flatRun[c] = level >= FLAT_LEVEL && level < FULL_SCALE ? 1 : 0;
    }

    // Clicks: a single sample that leaps away from its neighbours and straight back.
    if (this.frame >= 2) {
      const a = this.before2[c] as number;
      const b = this.before1[c] as number;
      const up = b - a;
      const down = x - b;
      const usual = this.movement[c] as number;
      const threshold = Math.max(0.05, 12 * usual);
      if (
        Math.abs(up) > threshold &&
        Math.abs(down) > threshold &&
        Math.sign(up) !== Math.sign(down) &&
        Math.abs(x - a) < 0.25 * Math.min(Math.abs(up), Math.abs(down))
      ) {
        const at = (this.frame - 1) / this.sampleRate;
        this.clicks.add(c, round(at), round(at), 1);
      }
      this.movement[c] = usual + (Math.abs(down) - usual) * this.settle;
    }
    this.before2[c] = this.before1[c] as number;
    this.before1[c] = x;

    // The front pair.
    if (this.channels >= 2 && c < 2) {
      if (c === 0) this.left = x;
      else {
        this.lr += this.left * x;
        this.ll += this.left * this.left;
        this.rr += x * x;
      }
    }
  }

  private endClip(c: number) {
    const run = this.clipRun[c] as number;
    if (run >= CLIP_RUN) {
      this.clips.add(c, this.time(this.frame - run), this.time(this.frame), run);
    }
    this.clipRun[c] = 0;
  }

  private endFlat(c: number) {
    const run = this.flatRun[c] as number;
    if (run >= FLAT_RUN) {
      this.flats.add(c, this.time(this.frame - run), this.time(this.frame), run);
    }
    this.flatRun[c] = 0;
  }

  private endFrame(): void {
    if (this.frameSilent) this.zeroRun += 1;
    else {
      this.endSilence(false);
      this.zeroRun = 0;
    }
    this.frameSilent = true;
    this.frame += 1;
  }

  /** A run of digital silence has ended: at the start, at the end, or inside the music. */
  private endSilence(atEnd: boolean) {
    const run = this.zeroRun;
    if (run === 0) return;
    const start = this.frame - run;
    if (start === 0) this.leading = run;
    else if (atEnd) this.trailing = run;
    else if (run >= EDGE_SILENCE * this.sampleRate) {
      this.gaps.add(null, this.time(start), this.time(this.frame), run);
    } else if (run >= DROPOUT * this.sampleRate) {
      this.dropouts.add(null, this.time(start), this.time(this.frame), run);
    }
  }

  finish(): QaFinding[] {
    for (let c = 0; c < this.channels; c++) {
      this.endClip(c);
      this.endFlat(c);
    }
    this.endSilence(true);
    if (this.frame === 0) return [];
    const out: QaFinding[] = [];
    const sr = this.sampleRate;

    const report = (
      check: QaCheck,
      passages: Passages,
      fail: boolean,
      describe: (p: Passage) => string,
      none: string,
    ) => {
      if (passages.list.length === 0) {
        out.push({
          check,
          severity: "pass",
          summary: none,
          channel: null,
          start: null,
          end: null,
          details: {},
        });
        return;
      }
      for (const p of passages.list) {
        out.push({
          check,
          severity: fail ? "fail" : "warn",
          summary: `${describe(p)}${p.channel === null ? "" : ` on ${channelName(p.channel)}`}`,
          channel: p.channel,
          start: p.start,
          end: p.end,
          details: { events: p.count, longestSamples: p.longest, totalInFile: passages.total },
        });
      }
    };

    report(
      "clipping",
      this.clips,
      true,
      (p) =>
        p.count > 1
          ? `Clipped ${p.count} times, the longest ${p.longest} samples`
          : `Clipped for ${p.longest} samples`,
      "No clipping",
    );
    report(
      "flat-tops",
      this.flats,
      false,
      (p) => `Flattened peaks${p.count > 1 ? ` (${p.count})` : ""}: clipped, then turned down`,
      "No flattened peaks",
    );
    report(
      "dropouts",
      this.dropouts,
      true,
      (p) => `Digital silence for ${Math.round((p.longest / sr) * 1000)} ms inside the music`,
      "No dropouts",
    );
    report(
      "clicks",
      this.clicks,
      false,
      (p) => (p.count > 1 ? `${p.count} clicks` : "A click"),
      "No clicks",
    );

    // DC offset, per channel.
    let offsets = 0;
    for (let c = 0; c < this.channels; c++) {
      const mean = (this.sums[c] as number) / this.frame;
      if (Math.abs(mean) > DC_LIMIT) {
        offsets += 1;
        out.push({
          check: "dc-offset",
          severity: "warn",
          summary: `DC offset of ${db(Math.abs(mean)).toFixed(0).replace("-", "−")} dBFS on ${channelName(c)}`,
          channel: c,
          start: null,
          end: null,
          details: { mean },
        });
      }
    }
    if (offsets === 0) {
      out.push({
        check: "dc-offset",
        severity: "pass",
        summary: "No DC offset",
        channel: null,
        start: null,
        end: null,
        details: {},
      });
    }

    // Long silences inside the music, and at either end.
    for (const g of this.gaps.list) {
      out.push({
        check: "silence",
        severity: "info",
        summary: `${(g.longest / sr).toFixed(1)} s of digital silence inside the music`,
        channel: null,
        start: g.start,
        end: g.end,
        details: { seconds: g.longest / sr },
      });
    }
    const duration = this.frame / sr;
    if (this.leading >= EDGE_SILENCE * sr) {
      out.push({
        check: "silence",
        severity: "info",
        summary: `${(this.leading / sr).toFixed(1)} s of digital silence at the start`,
        channel: null,
        start: 0,
        end: round(this.leading / sr),
        details: { seconds: this.leading / sr },
      });
    }
    if (this.trailing >= EDGE_SILENCE * sr) {
      out.push({
        check: "silence",
        severity: "info",
        summary: `${(this.trailing / sr).toFixed(1)} s of digital silence at the end`,
        channel: null,
        start: round(duration - this.trailing / sr),
        end: round(duration),
        details: { seconds: this.trailing / sr },
      });
    }

    // Phase and mono fold-down of the front pair.
    if (this.channels >= 2 && this.ll > 0 && this.rr > 0) {
      const correlation = this.lr / Math.sqrt(this.ll * this.rr);
      const loss =
        -10 *
        Math.log10(Math.max(1e-12, (this.ll + this.rr + 2 * this.lr) / (2 * (this.ll + this.rr))));
      const severity = correlation < 0 ? "fail" : loss > 6 ? "warn" : "pass";
      out.push({
        check: "phase",
        severity,
        summary:
          correlation < 0
            ? `Out of phase: correlation ${correlation.toFixed(2).replace("-", "−")}`
            : loss > 6
              ? `Folds down to mono ${loss.toFixed(1)} dB quieter`
              : `Correlation ${correlation.toFixed(2)}; mono fold-down loses ${loss.toFixed(1)} dB`,
        channel: null,
        start: null,
        end: null,
        details: { correlation, monoLossDb: loss },
      });
    }
    return out;
  }
}

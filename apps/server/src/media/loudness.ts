import {
  channelLevels,
  highest,
  type LoudnessSeries,
  type LoudnessSummary,
  linearToDb,
  SILENCE,
} from "@hekate/shared";

/** Grows a float array in blocks, so a long file costs no copying while it is measured. */
class Column {
  private blocks: Float32Array[] = [];
  private readonly block = 16_384;
  length = 0;
  set(index: number, value: number) {
    while (index >= this.blocks.length * this.block) this.blocks.push(new Float32Array(this.block));
    (this.blocks[Math.floor(index / this.block)] as Float32Array)[index % this.block] = value;
    this.length = Math.max(this.length, index + 1);
  }
  toArray(length = this.length): Float32Array {
    const out = new Float32Array(length);
    this.blocks.forEach((block, i) => {
      const start = i * this.block;
      if (start < length) out.set(block.subarray(0, Math.min(this.block, length - start)), start);
    });
    return out;
  }
}

/** A mean square as dBFS; nothing, or rounding below zero, is silence. */
const powerToDb = (power: number) =>
  power > 0 ? Math.max(SILENCE, 10 * Math.log10(power)) : SILENCE;

/** ffmpeg prints silence as `-inf`, or as its own floor of about -120.7 LUFS. */
const level = (text: string) => {
  const value = Number.parseFloat(text);
  return Number.isFinite(value) ? Math.max(SILENCE, value) : SILENCE;
};

/**
 * Reads the metadata ffmpeg prints for every 100 ms frame (`ametadata=mode=print`): the
 * `ebur128` filter's momentary, short-term and integrated loudness, range and running true
 * peaks, and the `astats` filter's per-channel peak and RMS. Lines may arrive in any chunks.
 */
export class LoudnessParser {
  private frame = -1;
  private readonly momentary = new Column();
  private readonly shortTerm = new Column();
  private readonly peak = new Column();
  private readonly rms = new Column();
  integrated = SILENCE;
  range = 0;
  readonly channels: number;
  /** Running maximum per channel, linear. */
  readonly truePeaks: number[];

  constructor(channels: number) {
    this.channels = channels;
    this.truePeaks = new Array(channels).fill(0);
  }

  get count() {
    return this.frame + 1;
  }

  line(text: string): void {
    if (text.startsWith("frame:")) {
      this.frame += 1;
      // Until a measure is printed for a frame, it reads as silence.
      this.momentary.set(this.frame, SILENCE);
      this.shortTerm.set(this.frame, SILENCE);
      for (let c = 0; c < this.channels; c++) {
        this.peak.set(this.frame * this.channels + c, SILENCE);
        this.rms.set(this.frame * this.channels + c, SILENCE);
      }
      return;
    }
    if (this.frame < 0) return;
    const equals = text.indexOf("=");
    if (equals < 0) return;
    const key = text.slice(0, equals);
    const value = text.slice(equals + 1).trim();
    if (key === "lavfi.r128.M") this.momentary.set(this.frame, level(value));
    else if (key === "lavfi.r128.S") this.shortTerm.set(this.frame, level(value));
    else if (key === "lavfi.r128.I") this.integrated = level(value);
    else if (key === "lavfi.r128.LRA") this.range = Number.parseFloat(value) || 0;
    else if (key.startsWith("lavfi.r128.true_peaks_ch")) {
      const channel = Number.parseInt(key.slice("lavfi.r128.true_peaks_ch".length), 10);
      if (channel >= 0 && channel < this.channels) {
        this.truePeaks[channel] = Math.max(this.truePeaks[channel] ?? 0, Number(value) || 0);
      }
    } else if (key.startsWith("lavfi.astats.")) {
      // lavfi.astats.<channel, from 1>.<measure>
      const [channelText, measure] = key.slice("lavfi.astats.".length).split(".");
      const channel = Number.parseInt(channelText ?? "", 10) - 1;
      if (!(channel >= 0 && channel < this.channels)) return;
      const at = this.frame * this.channels + channel;
      if (measure === "Peak_level") this.peak.set(at, level(value));
      else if (measure === "RMS_level") this.rms.set(at, level(value));
    }
  }

  columns(count = this.count) {
    return {
      momentary: this.momentary.toArray(count),
      shortTerm: this.shortTerm.toArray(count),
      peak: this.peak.toArray(count * this.channels),
      rms: this.rms.toArray(count * this.channels),
    };
  }
}

/**
 * Phase correlation of the first two channels (left and right, or front left and right
 * of a surround layout) over each frame, from interleaved 32-bit float PCM in chunks of
 * any size: +1 is mono, 0 unrelated, -1 out of phase. Silence on either side reads as 0.
 * The same sums give the RMS of the pair's mid, (L+R)/2, and side, (L−R)/2, in dBFS.
 */
export class PhaseMeter {
  private carry = Buffer.alloc(0);
  private channel = 0;
  private frames = 0;
  private lr = 0;
  private ll = 0;
  private rr = 0;
  private left = 0;
  private readonly values = new Column();
  private readonly mid = new Column();
  private readonly side = new Column();
  /** Sample frames (one sample per channel) seen. */
  total = 0;
  readonly channels: number;
  readonly samplesPerFrame: number;

  constructor(channels: number, samplesPerFrame: number) {
    this.channels = channels;
    this.samplesPerFrame = samplesPerFrame;
  }

  push(chunk: Buffer): void {
    const bytes = this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : chunk;
    const whole = bytes.length - (bytes.length % 4);
    for (let offset = 0; offset < whole; offset += 4) {
      const c = this.channel;
      if (c < 2 && this.channels >= 2) {
        const sample = bytes.readFloatLE(offset);
        if (c === 0) this.left = sample;
        else {
          this.lr += this.left * sample;
          this.ll += this.left * this.left;
          this.rr += sample * sample;
        }
      }
      this.channel += 1;
      if (this.channel === this.channels) {
        this.channel = 0;
        this.total += 1;
        this.frames += 1;
        if (this.frames === this.samplesPerFrame) this.emit();
      }
    }
    this.carry = Buffer.from(bytes.subarray(whole));
  }

  private emit(): void {
    const energy = Math.sqrt(this.ll * this.rr);
    const at = this.values.length;
    this.values.set(at, energy > 0 ? this.lr / energy : 0);
    // Mean of ((L ± R) / 2)², from the sums already kept.
    const n = Math.max(1, this.frames);
    this.mid.set(at, powerToDb((this.ll + 2 * this.lr + this.rr) / 4 / n));
    this.side.set(at, powerToDb((this.ll - 2 * this.lr + this.rr) / 4 / n));
    this.frames = 0;
    this.lr = 0;
    this.ll = 0;
    this.rr = 0;
  }

  finish(count: number): { phase: Float32Array; mid: Float32Array; side: Float32Array } {
    if (this.frames > 0) this.emit();
    const pair = this.channels >= 2;
    const column = (c: Column) => (pair ? c.toArray(count) : new Float32Array(0));
    return { phase: column(this.values), mid: column(this.mid), side: column(this.side) };
  }
}

/**
 * The filters that measure loudness and levels per frame, ahead of the PCM output: frames
 * are first cut to `samplesPerFrame` so every measure lines up with the series. The audio
 * passes through unchanged, so the same decode also feeds the waveform peaks.
 */
export function loudnessFilters(samplesPerFrame: number, metadataPath: string): string {
  // Filter arguments have their own escaping; a workspace path never needs any.
  if (!/^[A-Za-z0-9/_.-]+$/.test(metadataPath)) {
    throw new Error("The media workspace path must use only letters, digits, / _ . and -");
  }
  return [
    `asetnsamples=n=${samplesPerFrame}:p=0`,
    "ebur128=peak=true:metadata=1:framelog=quiet",
    "astats=metadata=1:reset=1:measure_perchannel=Peak_level+RMS_level:measure_overall=none",
    `ametadata=mode=print:file=${metadataPath}`,
  ].join(",");
}

/** The series and summary, once ffmpeg has finished. */
export function finishLoudness(
  parsed: LoudnessParser,
  phase: PhaseMeter,
  sampleRate: number,
): { series: LoudnessSeries; summary: LoudnessSummary } {
  const count = parsed.count;
  const columns = parsed.columns(count);
  const series: LoudnessSeries = {
    channels: parsed.channels,
    sampleRate,
    samplesPerFrame: phase.samplesPerFrame,
    count,
    hasPhase: parsed.channels >= 2,
    hasMidSide: parsed.channels >= 2,
    ...columns,
    ...phase.finish(count),
  };
  const levels = channelLevels(series, phase.total);
  const truePeaks = parsed.truePeaks.map(linearToDb);
  const audibleTruePeaks = truePeaks.filter((p): p is number => p !== null);
  return {
    series,
    summary: {
      // ffmpeg reports -70 LUFS, the absolute gate, when nothing passes it.
      integrated: parsed.integrated > -70 ? parsed.integrated : null,
      range: parsed.range,
      momentaryMax: highest(series.momentary),
      shortTermMax: highest(series.shortTerm),
      truePeak: audibleTruePeaks.length > 0 ? Math.max(...audibleTruePeaks) : null,
      channels: levels.map((l, c) => ({ truePeak: truePeaks[c] ?? null, ...l })),
    },
  };
}

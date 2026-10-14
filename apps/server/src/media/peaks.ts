import { BASE_SAMPLES_PER_PEAK, type PeakLevel } from "@hekate/shared";

/** Peaks are 8-bit: a sample of full scale maps to ±127. */
const quantise = (sample: number) => Math.round(Math.max(-1, Math.min(1, sample)) * 127);

/** Peaks grow in blocks of this many, so memory follows the file's length without copying. */
const BLOCK = 65_536;

/**
 * Builds the finest peak level from interleaved 32-bit float PCM, arriving in chunks of
 * any size (a chunk may end mid-sample or mid-frame).
 */
export class PeakBuilder {
  readonly channels: number;
  readonly sampleRate: number;
  readonly samplesPerPeak: number;
  private blocks: Int8Array[] = [];
  private count = 0;
  private min: Float32Array;
  private max: Float32Array;
  /** Frames (one sample per channel) in the current peak so far. */
  private frames = 0;
  private channel = 0;
  private carry = Buffer.alloc(0);

  constructor(channels: number, sampleRate: number, samplesPerPeak = BASE_SAMPLES_PER_PEAK) {
    this.channels = channels;
    this.sampleRate = sampleRate;
    this.samplesPerPeak = samplesPerPeak;
    this.min = new Float32Array(channels).fill(Number.POSITIVE_INFINITY);
    this.max = new Float32Array(channels).fill(Number.NEGATIVE_INFINITY);
  }

  push(chunk: Buffer): void {
    const bytes = this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : chunk;
    const whole = bytes.length - (bytes.length % 4);
    for (let offset = 0; offset < whole; offset += 4) {
      const sample = bytes.readFloatLE(offset);
      const c = this.channel;
      if (sample < (this.min[c] as number)) this.min[c] = sample;
      if (sample > (this.max[c] as number)) this.max[c] = sample;
      this.channel += 1;
      if (this.channel === this.channels) {
        this.channel = 0;
        this.frames += 1;
        if (this.frames === this.samplesPerPeak) this.emit();
      }
    }
    this.carry = Buffer.from(bytes.subarray(whole));
  }

  private emit(): void {
    const slot = this.count % BLOCK;
    if (slot === 0) this.blocks.push(new Int8Array(BLOCK * this.channels * 2));
    const block = this.blocks.at(-1) as Int8Array;
    for (let c = 0; c < this.channels; c++) {
      const at = (slot * this.channels + c) * 2;
      block[at] = quantise(this.min[c] as number);
      block[at + 1] = quantise(this.max[c] as number);
    }
    this.count += 1;
    this.frames = 0;
    this.min.fill(Number.POSITIVE_INFINITY);
    this.max.fill(Number.NEGATIVE_INFINITY);
  }

  /** The finest level, including a last, partial peak. */
  finish(): PeakLevel {
    if (this.frames > 0) this.emit();
    const stride = this.channels * 2;
    const data = new Int8Array(this.count * stride);
    this.blocks.forEach((block, i) => {
      const start = i * BLOCK * stride;
      data.set(block.subarray(0, Math.min(block.length, data.length - start)), start);
    });
    return {
      channels: this.channels,
      sampleRate: this.sampleRate,
      samplesPerPeak: this.samplesPerPeak,
      count: this.count,
      data,
    };
  }
}

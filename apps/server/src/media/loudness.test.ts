import { SILENCE } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { finishLoudness, LoudnessParser, loudnessFilters, PhaseMeter } from "./loudness.ts";

const pcm = (samples: number[]) => {
  const buffer = Buffer.alloc(samples.length * 4);
  samples.forEach((s, i) => {
    buffer.writeFloatLE(s, i * 4);
  });
  return buffer;
};

const printed = `frame:0    pts:0       pts_time:0
lavfi.r128.M=-120.691
lavfi.r128.S=-120.691
lavfi.r128.I=-70.000
lavfi.r128.LRA=0.000
lavfi.r128.true_peaks_ch0=0.125
lavfi.r128.true_peaks_ch1=0.250
lavfi.astats.1.Peak_level=-18.063921
lavfi.astats.1.RMS_level=-21.074027
lavfi.astats.2.Peak_level=-inf
lavfi.astats.2.RMS_level=-inf
frame:1    pts:4800    pts_time:0.1
lavfi.r128.M=-18.373
lavfi.r128.S=-19.5
lavfi.r128.I=-18.380
lavfi.r128.LRA=1.5
lavfi.r128.true_peaks_ch0=0.5
lavfi.r128.true_peaks_ch1=0.250
lavfi.astats.1.Peak_level=-6
lavfi.astats.1.RMS_level=-9
lavfi.astats.2.Peak_level=-12
lavfi.astats.2.RMS_level=-15
lavfi.astats.3.Peak_level=-1`;

describe("loudness parser", () => {
  it("reads ffmpeg's printed meters into frames", () => {
    const parser = new LoudnessParser(2);
    for (const line of printed.split("\n")) parser.line(line);
    expect(parser.count).toBe(2);
    const { momentary, shortTerm, peak, rms } = parser.columns();
    // ffmpeg's own floor, and -inf, both read as silence.
    expect(Array.from(momentary)).toEqual([SILENCE, Math.fround(-18.373)]);
    expect(Array.from(shortTerm)).toEqual([SILENCE, -19.5]);
    expect(Array.from(peak)).toEqual([Math.fround(-18.063921), SILENCE, -6, -12]);
    expect(Array.from(rms)).toEqual([Math.fround(-21.074027), SILENCE, -9, -15]);
    expect(parser.integrated).toBeCloseTo(-18.38, 5);
    expect(parser.range).toBe(1.5);
    expect(parser.truePeaks).toEqual([0.5, 0.25]);
  });

  it("summarises the file, with no integrated loudness for silence", () => {
    const parser = new LoudnessParser(2);
    for (const line of printed.split("\n").slice(0, 11)) parser.line(line);
    const { summary } = finishLoudness(parser, new PhaseMeter(2, 4800), 48000);
    expect(summary.integrated).toBeNull();
    expect(summary.momentaryMax).toBeNull();
    expect(summary.truePeak).toBeCloseTo(-12.04, 2);
    expect(summary.channels[1]?.samplePeak).toBeNull();
  });
});

describe("phase meter", () => {
  it("correlates the first two channels per frame, whatever the chunk boundaries", () => {
    // Three channels, two frames of two samples: in phase, then out of phase. The third
    // channel is ignored.
    const samples = [0.5, 0.5, 9, -0.25, -0.25, 9, 0.5, -0.5, 9, 0.25, -0.25, 9];
    const bytes = pcm(samples);
    const meter = new PhaseMeter(3, 2);
    for (const [start, end] of [
      [0, 5],
      [5, 22],
      [22, bytes.length],
    ] as const) {
      meter.push(bytes.subarray(start, end));
    }
    expect(Array.from(meter.finish(2))).toEqual([1, -1]);
    expect(meter.total).toBe(4);
  });

  it("has nothing to say about mono", () => {
    const meter = new PhaseMeter(1, 2);
    meter.push(pcm([0.1, 0.2, 0.3]));
    expect(meter.finish(2)).toHaveLength(0);
  });
});

describe("loudness filters", () => {
  it("refuses a workspace path that would need escaping", () => {
    expect(loudnessFilters(4800, "/tmp/job-1/loudness.txt")).toContain(
      "ametadata=mode=print:file=/tmp/job-1/loudness.txt",
    );
    expect(() => loudnessFilters(4800, "/tmp/a,b:c/loudness.txt")).toThrow();
  });
});

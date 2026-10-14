import { describe, expect, it } from "vitest";
import {
  bandFrequency,
  byteToLevel,
  decodeSpectrogram,
  encodeSpectrogram,
  levelToByte,
  rowBands,
  SPECTROGRAM_FLOOR,
  type Spectrogram,
  scaleFrequency,
  scalePosition,
} from "./spectrogram.ts";

const sample: Spectrogram = {
  sampleRate: 48_000,
  fftSize: 2048,
  samplesPerColumn: 1536,
  columns: 2,
  bands: 3,
  lowBands: 3,
  highFactor: 1,
  data: Uint8Array.from([0, 128, 255, 10, 20, 30]),
};

describe("spectrogram format", () => {
  it("round-trips, and refuses what is not a whole spectrogram", () => {
    const bytes = encodeSpectrogram(sample);
    expect(decodeSpectrogram(bytes)).toEqual(sample);
    expect(() => decodeSpectrogram(bytes.subarray(0, bytes.length - 1))).toThrow(/Truncated/);
    expect(() => decodeSpectrogram(new Uint8Array(40))).toThrow(/Not a spectrogram/);
  });

  it("quantises levels between the floor and 0 dB", () => {
    expect(levelToByte(0)).toBe(255);
    expect(levelToByte(6)).toBe(255);
    expect(levelToByte(SPECTROGRAM_FLOOR)).toBe(0);
    expect(levelToByte(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(byteToLevel(levelToByte(-60))).toBeCloseTo(-60, 0);
  });
});

describe("frequency scales", () => {
  it("places and finds frequencies, each the inverse of the other", () => {
    for (const scale of ["linear", "log", "mel", "bark"] as const) {
      expect(scalePosition(scale, 20, 20, 20_000)).toBeCloseTo(0, 6);
      expect(scalePosition(scale, 20_000, 20, 20_000)).toBeCloseTo(1, 6);
      const hz = scaleFrequency(scale, 0.37, 20, 20_000);
      expect(scalePosition(scale, hz, 20, 20_000)).toBeCloseTo(0.37, 6);
    }
    // A decade per third of the height on a log scale from 20 Hz to 20 kHz.
    expect(scaleFrequency("log", 1 / 3, 20, 20_000)).toBeCloseTo(200, 3);
    // Mel and Bark give the low end more room than linear does.
    expect(scalePosition("mel", 1000, 0, 20_000)).toBeGreaterThan(0.25);
    expect(scalePosition("linear", 1000, 0, 20_000)).toBeCloseTo(0.05, 6);
  });

  it("maps rows, top first, to the bands they cover", () => {
    const layout = {
      sampleRate: 48_000,
      fftSize: 2048,
      bands: 1024,
      lowBands: 1024,
      highFactor: 1,
    };
    const rows = rowBands(layout, 4, "linear", 0, 24_000);
    expect(Array.from(rows)).toEqual([768, 1023, 512, 767, 256, 511, 0, 255]);
  });

  it("keeps the low end at full detail and pools only above it", () => {
    // 96 kHz: 2048 bins of 23.4375 Hz; the first 1024 kept, the rest pooled in twos.
    const layout = {
      sampleRate: 96_000,
      fftSize: 4096,
      bands: 1536,
      lowBands: 1024,
      highFactor: 2,
    };
    expect(bandFrequency(layout, 1)).toBeCloseTo(23.4375, 6);
    expect(bandFrequency(layout, 1024)).toBeCloseTo(24_000, 6);
    expect(bandFrequency(layout, 1025)).toBeCloseTo(24_046.875, 6);
    expect(bandFrequency(layout, 1536)).toBeCloseTo(48_000, 6);
    const rows = rowBands(layout, 2, "linear", 0, 48_000);
    expect(Array.from(rows)).toEqual([1024, 1535, 0, 1023]);
  });
});

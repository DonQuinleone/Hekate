import { levelToByte, type Spectrogram } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import {
  colourTable,
  combineSpectrograms,
  defaultView,
  lookupTable,
  readView,
  renderSpectrogram,
} from "./spectrogram";

describe("colour tables", () => {
  it("runs from the first stop to the last", () => {
    const table = lookupTable(["#000000", "#ff8000"]);
    expect(Array.from(table.subarray(0, 3))).toEqual([0, 0, 0]);
    expect(Array.from(table.subarray(255 * 3))).toEqual([255, 128, 0]);
    expect(Array.from(table.subarray(128 * 3, 128 * 3 + 3))).toEqual([128, 64, 0]);
    expect(colourTable("greyscale")[255 * 3]).toBe(255);
    expect(colourTable("signal", ["#000000", "#f0762e"])[255 * 3]).toBe(0xf0);
  });
});

describe("stored views", () => {
  it("keeps what is valid and repairs the rest", () => {
    expect(readView(null)).toEqual(defaultView);
    expect(
      readView({ colourMap: "inferno", scale: "nope", floor: -90, ceiling: -95 }),
    ).toMatchObject({ colourMap: "inferno", scale: defaultView.scale, floor: -90, ceiling: -89 });
    expect(readView({ low: 5000, high: 100 })).toMatchObject({ low: 5000, high: 5001 });
  });
});

describe("rendering", () => {
  // Four columns, eight bands: one loud band, and a click in one column only.
  const spectrogram: Spectrogram = {
    sampleRate: 16_000,
    fftSize: 16,
    samplesPerColumn: 4,
    columns: 4,
    bands: 8,
    lowBands: 8,
    highFactor: 1,
    data: new Uint8Array(32),
  };
  for (let c = 0; c < 4; c++) spectrogram.data[c * 8 + 6] = levelToByte(0);
  spectrogram.data[2 * 8 + 1] = levelToByte(-60);
  const view = {
    ...defaultView,
    scale: "linear" as const,
    low: 0,
    high: 8000,
    floor: -120,
    ceiling: 0,
  };
  const grey = colourTable("greyscale");
  const brightness = (pixels: Uint8ClampedArray, width: number, x: number, y: number) =>
    pixels[(y * width + x) * 4] as number;

  it("puts each band at its height, high frequencies at the top", () => {
    const pixels = renderSpectrogram(spectrogram, 4, 8, view, grey);
    // Band 6 (6–7 kHz) is the second row from the top.
    expect(brightness(pixels, 4, 0, 1)).toBe(255);
    expect(brightness(pixels, 4, 0, 0)).toBe(0);
    // The click (band 1, -60 dB) is half brightness, in its own column only.
    expect(brightness(pixels, 4, 2, 6)).toBeCloseTo(128, -1);
    expect(brightness(pixels, 4, 1, 6)).toBe(0);
  });

  it("keeps the loudest value when the view is smaller than the data", () => {
    const pixels = renderSpectrogram(spectrogram, 2, 2, view, grey);
    // The lower half of the second column holds the click; the top half, the loud band.
    expect(brightness(pixels, 2, 1, 1)).toBeCloseTo(128, -1);
    expect(brightness(pixels, 2, 0, 0)).toBe(255);
  });

  it("stretches the floor and ceiling", () => {
    const pixels = renderSpectrogram(
      spectrogram,
      4,
      8,
      { ...view, floor: -60, ceiling: -30 },
      grey,
    );
    expect(brightness(pixels, 4, 2, 6)).toBe(0);
    expect(brightness(pixels, 4, 0, 1)).toBe(255);
  });
});

describe("combining channels", () => {
  it("keeps the loudest of every cell", () => {
    const base = {
      sampleRate: 16_000,
      fftSize: 16,
      samplesPerColumn: 4,
      columns: 1,
      bands: 3,
      lowBands: 3,
      highFactor: 1,
    };
    const combined = combineSpectrograms([
      { ...base, data: Uint8Array.from([10, 200, 0]) },
      { ...base, data: Uint8Array.from([90, 5, 0]) },
    ]);
    expect(Array.from(combined?.data ?? [])).toEqual([90, 200, 0]);
    expect(combineSpectrograms([])).toBeUndefined();
  });
});

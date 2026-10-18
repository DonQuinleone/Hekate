import { encodeSpectrogram, SPECTROGRAM_FLOOR, type Spectrogram } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { declaredLength, integrityFinding } from "./analysis.ts";
import { averageSpectrum, bandwidthFinding } from "./bandwidth.ts";
import { lfeFinding, lfeOf } from "./lfe.ts";

/** A level in dB as a spectrogram stores it. */
const byte = (db: number) =>
  Math.round(Math.max(0, Math.min(255, ((db - SPECTROGRAM_FLOOR) / -SPECTROGRAM_FLOOR) * 255)));

/** A spectrogram whose every column has the spectrum `levelAt` gives, band by band. */
function spectrogram(
  sampleRate: number,
  levelAt: (hz: number) => number,
  columns = 8,
): Spectrogram {
  const fftSize = sampleRate >= 88_200 ? 4096 : 2048;
  const bands = fftSize / 2;
  const binHz = sampleRate / fftSize;
  const row = Uint8Array.from({ length: bands }, (_, b) => byte(levelAt((b + 0.5) * binHz)));
  const data = new Uint8Array(columns * bands);
  for (let c = 0; c < columns; c++) data.set(row, c * bands);
  return {
    sampleRate,
    fftSize,
    samplesPerColumn: 4096,
    columns,
    bands,
    lowBands: bands,
    highFactor: 1,
    data,
  };
}

const check = (s: Spectrogram) => bandwidthFinding(averageSpectrum([s]));

describe("how high a recording reaches (#41)", () => {
  it("finds the wall a lossy encode leaves", () => {
    const mp3 = spectrogram(44_100, (hz) => (hz < 16_000 ? -30 - hz / 2000 : SPECTROGRAM_FLOOR));
    expect(check(mp3)).toMatchObject({
      check: "bandwidth",
      severity: "warn",
      summary: expect.stringMatching(/^Nothing above 16\.0 kHz: a sharp cut-off/),
    });
  });

  it("finds a hi-res file that holds nothing above a CD's range", () => {
    const upsampled = spectrogram(96_000, (hz) => (hz < 22_050 ? -35 : SPECTROGRAM_FLOOR));
    expect(check(upsampled)).toMatchObject({
      severity: "warn",
      summary: expect.stringMatching(/in a 96 kHz file: most likely made at 44\.1 or 48 kHz/),
    });
  });

  it("passes music that fades into its noise, however early", () => {
    // Acoustic music: falling 12 dB an octave above 2 kHz, over a dithered floor.
    const piano = spectrogram(48_000, (hz) =>
      Math.max(-110, hz < 2000 ? -25 : -25 - 12 * Math.log2(hz / 2000)),
    );
    expect(check(piano)).toMatchObject({ severity: "pass" });
    const full = spectrogram(48_000, (hz) => -30 - hz / 4000);
    expect(check(full)).toMatchObject({
      severity: "pass",
      summary: expect.stringMatching(/^Content reaches 2[34]\.\d kHz$/),
    });
  });

  it("says nothing of silence, or of a recording with nothing between 1 and 5 kHz", () => {
    expect(check(spectrogram(48_000, () => SPECTROGRAM_FLOOR))).toBeNull();
    expect(check(spectrogram(48_000, (hz) => (hz < 500 ? -20 : SPECTROGRAM_FLOOR)))).toBeNull();
    expect(bandwidthFinding(averageSpectrum([]))).toBeNull();
  });
});

describe("what the LFE carries (#74)", () => {
  const lfe = (s: Spectrogram) => lfeFinding(averageSpectrum([s]), 3);

  it("passes an LFE low-passed at its crossover", () => {
    // 24 dB an octave above 120 Hz, as a bass-management filter leaves it.
    const filtered = spectrogram(48_000, (hz) =>
      Math.max(-110, hz < 120 ? -20 : -20 - 24 * Math.log2(hz / 120)),
    );
    expect(lfe(filtered)).toMatchObject({
      check: "lfe",
      severity: "pass",
      channel: 3,
      summary: "Nothing above the 120 Hz crossover on the LFE",
    });
  });

  it("fails content above the crossover, and full-range content as channels out of order", () => {
    const leaking = spectrogram(48_000, (hz) =>
      hz < 120 ? -20 : hz < 1000 ? -32 : SPECTROGRAM_FLOOR,
    );
    expect(lfe(leaking)).toMatchObject({
      severity: "fail",
      summary: expect.stringMatching(
        /^Content above the 120 Hz crossover on the LFE \(channel 4\), at 2\d\d Hz only 12 dB below its bass: low-pass it at 120 Hz$/,
      ),
    });
    // A vocal where the LFE should be: film order puts the LFE last.
    const vocal = spectrogram(48_000, (hz) => (hz < 100 ? -40 : hz < 8000 ? -22 : -60));
    expect(lfe(vocal)).toMatchObject({
      severity: "fail",
      summary: expect.stringMatching(/^Full-range content on the LFE \(channel 4\): most likely/),
    });
  });

  it("records a silent LFE as looked at, and finds the LFE among the channels", () => {
    expect(lfe(spectrogram(48_000, () => SPECTROGRAM_FLOOR))).toMatchObject({
      severity: "pass",
      summary: "Nothing on the LFE (channel 4)",
    });
    const quiet = encodeSpectrogram(spectrogram(48_000, () => SPECTROGRAM_FLOOR));
    const full = encodeSpectrogram(spectrogram(48_000, () => -20));
    const spectra = [0, 1, 2, 3, 4, 5].map((c) => ({
      channel: String(c),
      bytes: c === 3 ? full : quiet,
    }));
    expect(lfeOf(spectra, [3]).map((f) => [f.channel, f.severity])).toEqual([[3, "fail"]]);
    expect(lfeOf(spectra, [])).toEqual([]);
  });
});

describe("whether a file decodes whole (#41)", () => {
  it("fails a file cut short, at the point it stops", () => {
    expect(integrityFinding(83.4, 180, 0)).toMatchObject({
      severity: "fail",
      start: 83.4,
      summary: "Decodes to 01:23.400 of the 03:00.000 it declares: the file is likely cut short",
    });
  });

  it("fails a file the decoder stumbled through", () => {
    expect(integrityFinding(180, 180, 3)).toMatchObject({
      severity: "fail",
      summary: "The decoder met 3 errors on the way through: the file may be damaged",
    });
  });

  it("judges a recording's sound by its own length, never a video's picture (#41)", () => {
    const sound = { duration: 58.5 };
    expect(declaredLength({ kind: "video", mediaInfo: { duration: 60, audio: sound } })).toBe(58.5);
    expect(
      declaredLength({ kind: "video", mediaInfo: { duration: 60, audio: {} } }),
    ).toBeUndefined();
    expect(declaredLength({ kind: "audio", mediaInfo: { duration: 60, audio: {} } })).toBe(60);
    expect(declaredLength({ kind: "audio", mediaInfo: null })).toBeUndefined();
  });
  it("passes a whole file, allowing the last fraction of a second", () => {
    expect(integrityFinding(179.7, 180, 0)).toMatchObject({ severity: "pass" });
    expect(integrityFinding(42, undefined, 0)).toMatchObject({ severity: "pass" });
  });
});

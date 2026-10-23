import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bandFrequency,
  byteToLevel,
  decodeSpectrogram,
  type Spectrogram,
  spectrogramFftSizes,
  spectrogramOverlaps,
  spectrogramWindows,
} from "@hekate/shared";
import { afterAll, describe, expect, it } from "vitest";
import { run } from "./ffmpeg.ts";
import {
  computeSpectrograms,
  Fft,
  fftSizeFor,
  SpectrogramBuilder,
  spectrogramsInThread,
  windowOf,
} from "./spectrogram.ts";

const pcm = (
  frames: number,
  channels: number,
  sample: (frame: number, channel: number) => number,
) => {
  const buffer = Buffer.alloc(frames * channels * 4);
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) buffer.writeFloatLE(sample(f, c), (f * channels + c) * 4);
  }
  return buffer;
};

/** The loudest band of a column, and its level in dB. */
const loudest = (s: Spectrogram, column: number) => {
  let best = 0;
  for (let b = 1; b < s.bands; b++) {
    if ((s.data[column * s.bands + b] as number) > (s.data[column * s.bands + best] as number))
      best = b;
  }
  return {
    hz: (bandFrequency(s, best) + bandFrequency(s, best + 1)) / 2,
    db: byteToLevel(s.data[column * s.bands + best] as number),
  };
};

describe("fft", () => {
  it("matches a direct transform", () => {
    const n = 16;
    const fft = new Fft(n);
    const input = Array.from({ length: n }, (_, i) => Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1));
    const re = Float64Array.from(input);
    const im = new Float64Array(n);
    fft.transform(re, im);
    for (let k = 0; k < n; k++) {
      let sr = 0;
      let si = 0;
      input.forEach((x, t) => {
        sr += x * Math.cos((-2 * Math.PI * k * t) / n);
        si += x * Math.sin((-2 * Math.PI * k * t) / n);
      });
      expect(re[k]).toBeCloseTo(sr, 9);
      expect(im[k]).toBeCloseTo(si, 9);
    }
  });

  it("keeps bands about 23 Hz wide at any rate", () => {
    expect(fftSizeFor(44_100)).toBe(2048);
    expect(fftSizeFor(48_000)).toBe(2048);
    expect(fftSizeFor(96_000)).toBe(4096);
    expect(fftSizeFor(192_000)).toBe(8192);
  });
});

describe("spectrogram builder", () => {
  it("finds each channel's tone at its level, and mid and side of the front pair", () => {
    const rate = 48_000;
    const frames = rate;
    // Left: 937.5 Hz at -6 dBFS. Right: the same tone inverted, plus 5015.625 Hz at -20 dBFS.
    // Centre: silent. Both tones sit on band centres (23.4375 Hz apart), so no scalloping.
    const tone = (hz: number, f: number) => Math.sin((2 * Math.PI * hz * f) / rate);
    const builder = new SpectrogramBuilder(3, rate, frames);
    const bytes = pcm(frames, 3, (f, c) =>
      c === 0
        ? 0.5 * tone(937.5, f)
        : c === 1
          ? -0.5 * tone(937.5, f) + 0.1 * tone(5015.625, f)
          : 0,
    );
    // Arbitrary chunking, cutting samples in half.
    for (let at = 0; at < bytes.length; at += 4099) builder.push(bytes.subarray(at, at + 4099));
    const out = builder.finish();
    expect(out.map((o) => o.channel)).toEqual(["0", "1", "2", "mid", "side"]);
    const [left, right, centre, mid, side] = out.map((o) => o.spectrogram);
    const middle = Math.floor((left?.columns ?? 0) / 2);
    const l = loudest(left as Spectrogram, middle);
    expect(Math.abs(l.hz - 937.5)).toBeLessThan(25);
    expect(l.db).toBeCloseTo(-6.02, 0);
    expect(loudest(right as Spectrogram, middle).db).toBeCloseTo(-6.02, 0);
    expect(loudest(centre as Spectrogram, middle).db).toBeLessThan(-130);
    // The low tones cancel in the mid, which keeps half the 5 kHz tone.
    const m = loudest(mid as Spectrogram, middle);
    expect(Math.abs(m.hz - 5015.625)).toBeLessThan(25);
    expect(m.db).toBeCloseTo(-26.02, 0);
    expect(loudest(side as Spectrogram, middle).db).toBeCloseTo(-6.02, 0);
  });

  it("fits a long file into a bounded number of columns", () => {
    const builder = new SpectrogramBuilder(1, 48_000, 48_000 * 3600);
    expect(builder.samplesPerColumn % builder.hop).toBe(0);
    expect(Math.ceil((48_000 * 3600) / builder.samplesPerColumn)).toBeLessThanOrEqual(4096);
    expect(builder.outputs).toEqual(["0"]);
  });

  it("never makes columns shorter than 100 ms, however short the file", () => {
    for (const rate of [44_100, 48_000, 96_000, 192_000]) {
      const builder = new SpectrogramBuilder(2, rate, rate);
      expect(builder.samplesPerColumn / rate).toBeGreaterThanOrEqual(0.1);
      // So each column pools several overlapping windows.
      expect(builder.samplesPerColumn / builder.hop).toBeGreaterThanOrEqual(8);
    }
  });

  it("analyses with the window, FFT size and overlap chosen, each column pooling windows (#34)", () => {
    const rate = 48_000;
    const frames = rate * 2;
    const tone = (f: number) => 0.5 * Math.sin((2 * Math.PI * 937.5 * f) / rate);
    for (const window of spectrogramWindows) {
      for (const fftSize of spectrogramFftSizes) {
        for (const overlap of spectrogramOverlaps) {
          const builder = new SpectrogramBuilder(1, rate, frames, {
            analysis: { window, fftSize, overlap },
          });
          expect(builder.fftSize).toBe(fftSize === "auto" ? 2048 : Number(fftSize));
          expect(builder.hop).toBe(builder.fftSize * (1 - Number(overlap) / 100));
          expect(builder.samplesPerColumn / rate).toBeGreaterThanOrEqual(0.1);
          expect(builder.samplesPerColumn / builder.hop).toBeGreaterThanOrEqual(4);
          builder.push(pcm(frames, 1, tone));
          const s = builder.finish()[0]?.spectrogram as Spectrogram;
          const found = loudest(s, Math.floor(s.columns / 2));
          // Every window finds the tone at its level, within its own bands' width.
          expect(Math.abs(found.hz - 937.5)).toBeLessThan(rate / builder.fftSize);
          expect(found.db).toBeGreaterThan(-8);
          expect(found.db).toBeLessThan(-5);
        }
      }
    }
  });

  it("draws each kind of window as itself", () => {
    const hann = windowOf("hann", 8);
    expect(hann[0]).toBeCloseTo(0);
    expect(hann[4]).toBeCloseTo(1);
    expect(windowOf("hamming", 8)[0]).toBeCloseTo(0.08);
    expect(windowOf("blackman-harris", 8)[0]).toBeCloseTo(0.00006, 4);
    const kaiser = windowOf("kaiser", 8);
    expect(kaiser[4]).toBeCloseTo(1);
    expect(kaiser[0]).toBeLessThan(0.01);
  });

  it("keeps 23 Hz bands up to 24 kHz at high rates, pooling only above", () => {
    const at48 = new SpectrogramBuilder(1, 48_000, 48_000);
    expect([at48.bands, at48.lowBands, at48.highFactor]).toEqual([1024, 1024, 1]);
    const at96 = new SpectrogramBuilder(1, 96_000, 96_000);
    expect([at96.bands, at96.lowBands, at96.highFactor]).toEqual([1536, 1024, 2]);
    const at192 = new SpectrogramBuilder(1, 192_000, 192_000);
    expect([at192.bands, at192.lowBands, at192.highFactor]).toEqual([1536, 1024, 6]);
  });

  it("stays bounded when the file is far longer than expected", () => {
    const rate = 48_000;
    // No duration known, and room for only 8 columns.
    const builder = new SpectrogramBuilder(1, rate, 0, { maxColumns: 8 });
    const span = builder.samplesPerColumn;
    const seconds = 30;
    // A click in the very last tenth of a second, to show columns stay in time.
    const bytes = pcm(rate * seconds, 1, (f) => (f > rate * (seconds - 0.1) ? 0.9 : 0));
    for (let at = 0; at < bytes.length; at += 65_536) builder.push(bytes.subarray(at, at + 65_536));
    const [only] = builder.finish();
    const s = only?.spectrogram as Spectrogram;
    expect(s.columns).toBeLessThanOrEqual(16);
    expect(s.samplesPerColumn).toBeGreaterThan(span);
    expect(s.samplesPerColumn * s.columns).toBeGreaterThanOrEqual(rate * seconds);
    // The click lands in the last column and nowhere earlier.
    expect(loudest(s, s.columns - 1).db).toBeGreaterThan(-20);
    expect(loudest(s, 0).db).toBeLessThan(-120);
  });
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe.runIf(hasFfmpeg || process.env.CI)("spectrograms from a file", () => {
  const root = mkdtempSync(join(tmpdir(), "hekate-spectrogram-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("decodes every channel of a 96 kHz 5.1 file", async () => {
    const path = join(root, "mix.wav");
    await run("ffmpeg", [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=3000:sample_rate=96000:duration=2",
      "-af",
      "pan=5.1(side)|FL=c0|FR=c0|FC=0.5*c0|LFE=0*c0|SL=0.25*c0|SR=0.25*c0",
      "-c:a",
      "pcm_s24le",
      path,
    ]);
    const out = await computeSpectrograms(
      path,
      { channels: 6, sampleRate: 96_000 },
      2,
      new AbortController().signal,
    );
    expect(out).toHaveLength(8);
    const centre = out[2]?.spectrogram as Spectrogram;
    expect(centre.fftSize).toBe(4096);
    expect(centre.bands).toBe(1536);
    const at = loudest(centre, Math.floor(centre.columns / 2));
    expect(Math.abs(at.hz - 3000)).toBeLessThan(50);
    // ffmpeg's sine is at 1/8 of full scale; the centre has half of it.
    expect(at.db).toBeCloseTo(20 * Math.log10(0.0625), 0);
    expect(loudest(out[3]?.spectrogram as Spectrogram, 10).db).toBeLessThan(-130);
  });

  it("builds them on their own thread, and stops when cancelled", async () => {
    const path = join(root, "stereo.wav");
    await run("ffmpeg", [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=937.5:sample_rate=48000:duration=20",
      "-ac",
      "2",
      "-c:a",
      "pcm_s16le",
      path,
    ]);
    const audio = { channels: 2, sampleRate: 48_000 };
    const out = await spectrogramsInThread(path, audio, 20, new AbortController().signal);
    expect(out.map((o) => o.channel)).toEqual(["0", "1", "mid", "side"]);
    const left = decodeSpectrogram(out[0]?.bytes as Uint8Array);
    expect(left.columns).toBe(out[0]?.columns);
    expect(Math.abs(loudest(left, 100).hz - 937.5)).toBeLessThan(25);

    const controller = new AbortController();
    const running = spectrogramsInThread(path, audio, 20, controller.signal);
    controller.abort();
    await expect(running).rejects.toThrow(/cancel/);
  });
});

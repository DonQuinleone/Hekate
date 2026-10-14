import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { analyseAudio } from "./analysis.ts";
import { run } from "./ffmpeg.ts";
import { PeakBuilder } from "./peaks.ts";

const pcm = (samples: number[]) => {
  const buffer = Buffer.alloc(samples.length * 4);
  samples.forEach((s, i) => {
    buffer.writeFloatLE(s, i * 4);
  });
  return buffer;
};

describe("peak builder", () => {
  it("tracks each channel's extremes per block, whatever the chunk boundaries", () => {
    // Stereo, two frames a peak: left then right, interleaved.
    const samples = [0.5, -0.25, -1, 0.1, 0.2, 0.3, 0.4, -0.9, 1.5, 0];
    const whole = new PeakBuilder(2, 48000, 2);
    whole.push(pcm(samples));
    const split = new PeakBuilder(2, 48000, 2);
    const bytes = pcm(samples);
    // Cut mid-sample and mid-frame.
    for (const [start, end] of [
      [0, 3],
      [3, 13],
      [13, 14],
      [14, bytes.length],
    ] as const) {
      split.push(bytes.subarray(start, end));
    }
    const a = whole.finish();
    const b = split.finish();
    expect(b).toEqual(a);
    expect(a.count).toBe(3);
    expect(Array.from(a.data)).toEqual([
      // Peak 0: left 0.5 and -1, right -0.25 and 0.1.
      -127, 64, -32, 13,
      // Peak 1: left 0.2 and 0.4, right 0.3 and -0.9.
      25, 51, -114, 38,
      // Peak 2, partial: left 1.5 clamps to full scale, right 0.
      127, 127, 0, 0,
    ]);
  });
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe.runIf(hasFfmpeg || process.env.CI)("analysis of a file", () => {
  const root = mkdtempSync(join(tmpdir(), "hekate-peaks-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("keeps every channel of a 5.1 mix apart", async () => {
    const path = join(root, "mix-51.wav");
    // Each channel at its own level, so a mixed-up channel would show.
    const volumes = [1, 0.8, 0.6, 0.4, 0.2, 0.1];
    await run("ffmpeg", [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=3",
      "-af",
      `pan=5.1(side)|${["FL", "FR", "FC", "LFE", "SL", "SR"].map((ch, i) => `${ch}=${volumes[i]}*c0`).join("|")}`,
      "-c:a",
      "pcm_s24le",
      path,
    ]);
    const { levels, loudness } = await analyseAudio(
      path,
      { channels: 6, sampleRate: 48000 },
      root,
      new AbortController().signal,
    );
    const base = levels[0];
    expect(base?.channels).toBe(6);
    expect(base?.count).toBe(Math.ceil((3 * 48000) / 256));
    // The loudest point of each channel, across the whole file.
    const loudest = volumes.map((_, channel) => {
      let max = 0;
      for (let peak = 0; peak < (base?.count ?? 0); peak++) {
        max = Math.max(max, base?.data[(peak * 6 + channel) * 2 + 1] ?? 0);
      }
      return max;
    });
    // ffmpeg's sine source peaks at 1/8 of full scale.
    expect(loudest).toEqual(volumes.map((v) => Math.round(v * 127 * 0.125)));

    // Levels per channel, in the same order: each channel's own peak.
    const { series, summary } = loudness;
    expect(series.channels).toBe(6);
    expect(series.count).toBe(30);
    summary.channels.forEach((channel, i) => {
      const expected = 20 * Math.log10((volumes[i] ?? 0) * 0.125);
      expect(channel.samplePeak).toBeCloseTo(expected, 1);
      // A sine's RMS is 3 dB below its peak.
      expect(channel.rms).toBeCloseTo(expected - 3.01, 1);
      expect(channel.truePeak).toBeCloseTo(expected, 0);
    });
    expect(summary.integrated).toBeLessThan(-10);
    expect(summary.integrated).toBeGreaterThan(-30);
  });

  /** Ten seconds of 1 kHz at -18 dBFS in both channels, the right one inverted or not. */
  const stereo = async (name: string, right: string) => {
    const path = join(root, name);
    await run("ffmpeg", [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1000:sample_rate=48000:duration=10",
      "-af",
      `pan=stereo|FL=c0|FR=${right}`,
      "-c:a",
      "pcm_f32le",
      path,
    ]);
    return analyseAudio(
      path,
      { channels: 2, sampleRate: 48000 },
      root,
      new AbortController().signal,
    );
  };

  it("measures loudness to EBU R 128 and phase from the front pair", async () => {
    const { loudness } = await stereo("in-phase.wav", "c0");
    // Both channels of a 1 kHz sine at -18.06 dBFS peak: -18.06 LUFS, give or take K-weighting.
    expect(loudness.summary.integrated).toBeCloseTo(-18.06, 0);
    expect(loudness.summary.range).toBeLessThan(1);
    expect(loudness.summary.truePeak).toBeCloseTo(-18.06, 0);
    // Momentary needs 400 ms of audio; then it is steady.
    expect(loudness.series.momentary[0]).toBe(-120);
    expect(loudness.series.momentary[10]).toBeCloseTo(-18.06, 0);
    expect(loudness.series.phase[10]).toBeCloseTo(1, 3);

    const inverted = await stereo("out-of-phase.wav", "-1*c0");
    expect(inverted.loudness.series.phase[10]).toBeCloseTo(-1, 3);
  });
});

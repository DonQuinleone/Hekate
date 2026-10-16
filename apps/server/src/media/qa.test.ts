import type { QaFinding } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { SignalChecks } from "./qa.ts";

const RATE = 48_000;

/** Interleaved 32-bit float PCM from one function per channel, `seconds` long. */
function pcm(seconds: number, ...channels: ((t: number, i: number) => number)[]): Buffer {
  const frames = Math.round(seconds * RATE);
  const out = Buffer.alloc(frames * channels.length * 4);
  for (let i = 0; i < frames; i++) {
    for (const [c, f] of channels.entries()) {
      out.writeFloatLE(f(i / RATE, i), (i * channels.length + c) * 4);
    }
  }
  return out;
}

/** Run the checks over the audio in awkward chunks, as a pipe delivers it. */
function check(audio: Buffer, channels: number): QaFinding[] {
  const checks = new SignalChecks(channels, RATE);
  for (let o = 0; o < audio.length; o += 1001) checks.push(audio.subarray(o, o + 1001));
  return checks.finish();
}

const tone =
  (amp: number, hz = 440) =>
  (t: number) =>
    amp * Math.sin(2 * Math.PI * hz * t);
const of = (findings: QaFinding[], check: QaFinding["check"]) =>
  findings.filter((f) => f.check === check);
const worst = (findings: QaFinding[], check: QaFinding["check"]) =>
  of(findings, check).map((f) => f.severity);

describe("signal checks", () => {
  it("passes clean music, and says what it checked", () => {
    const found = check(pcm(2, tone(0.5), tone(0.45)), 2);
    for (const c of [
      "clipping",
      "flat-tops",
      "dropouts",
      "clicks",
      "dc-offset",
      "phase",
    ] as const) {
      expect(worst(found, c), c).toEqual(["pass"]);
    }
  });

  it("finds clipping, and peaks clipped then turned down", () => {
    const clipped = (t: number) => Math.max(-1, Math.min(1, 1.6 * Math.sin(2 * Math.PI * 100 * t)));
    const found = check(pcm(1, clipped, tone(0.3)), 2);
    const clips = of(found, "clipping");
    expect(clips[0]).toMatchObject({ severity: "fail", channel: 0 });
    expect(clips[0]?.summary).toMatch(/^Clipped \d+ times/);
    const lowered = (t: number) => 0.7 * clipped(t);
    const flats = of(check(pcm(1, lowered, tone(0.3)), 2), "flat-tops");
    expect(flats[0]).toMatchObject({ severity: "warn", channel: 0 });
  });

  it("finds a dropout inside the music, and silence at the ends", () => {
    const gappy = (t: number) =>
      (t >= 1 && t < 1.05) || (t < 1.5 - 0.0 - 0.0 && t < 0)
        ? 0
        : 0.4 * Math.sin(2 * Math.PI * 220 * t);
    const found = check(pcm(2, gappy, gappy), 2);
    const dropout = of(found, "dropouts")[0];
    expect(dropout).toMatchObject({ severity: "fail", channel: null });
    expect(dropout?.start).toBeCloseTo(1, 2);
    expect(dropout?.summary).toBe("Digital silence for 50 ms inside the music");
    const lead = (t: number) => (t < 1.5 ? 0 : 0.4 * Math.sin(2 * Math.PI * 220 * t));
    expect(of(check(pcm(3, lead, lead), 2), "silence")[0]).toMatchObject({
      severity: "info",
      summary: "1.5 s of digital silence at the start",
    });
  });

  it("finds a click, a DC offset, and a pair out of phase", () => {
    const spike = (t: number, i: number) =>
      i === 24_000 ? 0.8 : 0.05 * Math.sin(2 * Math.PI * 220 * t);
    const clicks = of(check(pcm(1, spike, tone(0.05, 220)), 2), "clicks");
    expect(clicks[0]).toMatchObject({ severity: "warn", channel: 0 });
    expect(clicks[0]?.start).toBeCloseTo(0.5, 3);

    const offset = (t: number) => 0.01 + 0.3 * Math.sin(2 * Math.PI * 220 * t);
    expect(of(check(pcm(1, offset, tone(0.3, 220)), 2), "dc-offset")[0]).toMatchObject({
      severity: "warn",
      channel: 0,
      summary: "DC offset of −40 dBFS on channel 1",
    });

    const inverted = (t: number) => -0.4 * Math.sin(2 * Math.PI * 220 * t);
    expect(of(check(pcm(1, tone(0.4, 220), inverted), 2), "phase")[0]).toMatchObject({
      severity: "fail",
      summary: "Out of phase: correlation −1.00",
    });
  });
});

import { describe, expect, it } from "vitest";
import type { LoudnessSummary } from "./loudness.ts";
import {
  type CustomProfile,
  customProfileInput,
  customRef,
  deliveryFindings,
  deliveryProfiles,
  effectiveProfile,
  orderFindings,
  profileFor,
  profileRef,
  suggestedProfile,
} from "./qa.ts";

const info = (sampleRate: number, bitDepth: number, channels: number) => ({
  audio: { codec: "pcm_s24le", channels, sampleRate, bitDepth },
});
const summary = (integrated: number, truePeak: number, rms = [-18, -18]): LoudnessSummary => ({
  integrated,
  range: 6,
  momentaryMax: null,
  shortTermMax: null,
  truePeak,
  channels: rms.map((r) => ({ truePeak, samplePeak: r === -200 ? null : r + 12, rms: r })),
});
const by = (found: ReturnType<typeof deliveryFindings>, check: string) =>
  found.find((f) => f.check === check);

describe("delivery checks", () => {
  it("passes a master made for its delivery, and says what was checked", () => {
    const found = deliveryFindings(
      deliveryProfiles.streaming,
      info(48_000, 24, 2),
      summary(-14.4, -1.3),
    );
    expect(found.map((f) => [f.check, f.severity])).toEqual([
      ["format", "pass"],
      ["loudness", "pass"],
      ["true-peak", "pass"],
    ]);
    expect(by(found, "loudness")?.summary).toBe("−14.4 LUFS, on target");
  });

  it("fails one too loud, too hot or in the wrong format", () => {
    const found = deliveryFindings(deliveryProfiles.cd, info(48_000, 24, 2), summary(-8, 0.4));
    expect(by(found, "format")).toMatchObject({
      severity: "fail",
      summary: "Not as CD asks: 48 kHz, 24-bit",
    });
    expect(by(found, "true-peak")?.summary).toBe("True peak 0.4 dBTP, over the −0.1 dBTP ceiling");
    // A lossy file reports no bit depth, so it cannot pass a master's.
    const lossy = deliveryFindings(
      deliveryProfiles.cd,
      { audio: { codec: "aac", channels: 2, sampleRate: 44_100 } },
      summary(-14, -1),
    );
    expect(by(lossy, "format")).toMatchObject({
      severity: "fail",
      summary: "Not as CD asks: aac, no bit depth",
    });
    // CD has no loudness target.
    expect(by(found, "loudness")).toBeUndefined();
    const loud = deliveryFindings(
      deliveryProfiles.streaming,
      info(44_100, 16, 2),
      summary(-9.2, -1),
    );
    expect(by(loud, "loudness")).toMatchObject({
      severity: "fail",
      summary: "−9.2 LUFS, 4.8 LU above the −14 LUFS target",
    });
    expect(
      by(deliveryFindings(deliveryProfiles.streaming, null, summary(-12.5, -2)), "loudness")
        ?.severity,
    ).toBe("warn");
  });

  it("finds a dead channel and a lopsided pair", () => {
    const found = deliveryFindings(
      deliveryProfiles.surround,
      info(48_000, 24, 6),
      summary(-23, -2, [-20, -26, -24, -200, -30, -30]),
    );
    expect(by(found, "dead-channel")).toMatchObject({
      channel: 3,
      summary: "Nothing on channel 4",
    });
    expect(by(found, "imbalance")?.summary).toBe("Left is 6.0 dB louder than right");
  });

  it("suggests a profile from the channels, and puts the worst first", () => {
    expect(suggestedProfile(2)).toBe("streaming");
    expect(suggestedProfile(6)).toBe("surround");
    expect(suggestedProfile(12)).toBe("atmos");
    const found = deliveryFindings(
      deliveryProfiles.streaming,
      info(44_100, 16, 2),
      summary(-9, 0.5),
    );
    expect(orderFindings(found).map((f) => f.severity)).toEqual(["fail", "fail", "pass"]);
  });
});

describe("delivery profiles per file, track, project and workspace", () => {
  const vinyl: CustomProfile = {
    id: "0190a6f0-0000-7000-8000-0000000000aa",
    label: "Vinyl cut",
    loudness: null,
    truePeakMax: -3,
    sampleRates: { rates: [96_000], atLeast: false },
    bitDepthMin: 24,
    channels: null,
  };
  const customs = [vinyl];

  it("takes the nearest choice: the file's, then the track's, the project's, the workspace's", () => {
    const all = {
      file: "cd",
      track: "broadcast",
      project: "atmos",
      workspace: customRef(vinyl.id),
    } as const;
    expect(effectiveProfile(all, 2, customs)).toMatchObject({ ref: "cd", source: "file" });
    expect(effectiveProfile({ ...all, file: null }, 2, customs).source).toBe("track");
    expect(effectiveProfile({ ...all, file: null, track: null }, 2, customs).source).toBe(
      "project",
    );
    const workspace = effectiveProfile({ workspace: all.workspace }, 2, customs);
    expect(workspace).toMatchObject({ source: "workspace", profile: { label: "Vinyl cut" } });
  });

  it("suggests from the channels when nothing chooses, and passes over a deleted profile", () => {
    expect(effectiveProfile({}, 6, customs)).toMatchObject({
      ref: "surround",
      source: "suggested",
    });
    const gone = customRef("0190a6f0-0000-7000-8000-0000000000bb");
    expect(profileFor(gone, customs)).toBeNull();
    expect(effectiveProfile({ track: gone, project: "cd" }, 2, customs).source).toBe("project");
  });

  it("names built-in and custom profiles alike, and checks a custom one's numbers", () => {
    expect(profileRef.parse("streaming")).toBe("streaming");
    expect(profileRef.parse(`custom:${vinyl.id.toUpperCase()}`)).toBe(customRef(vinyl.id));
    expect(profileRef.safeParse("custom:nope").success).toBe(false);
    // Thirty-six characters that are not an id are refused here, not by the database.
    expect(profileRef.safeParse(`custom:${"-".repeat(36)}`).success).toBe(false);
    expect(profileRef.safeParse("vinyl").success).toBe(false);
    const { id: _, ...input } = vinyl;
    expect(customProfileInput.safeParse(input).success).toBe(true);
    expect(customProfileInput.safeParse({ ...input, truePeakMax: 3 }).success).toBe(false);
    expect(
      customProfileInput.safeParse({ ...input, sampleRates: { rates: [], atLeast: true } }).success,
    ).toBe(false);
  });

  it("takes any layout where a profile names none", () => {
    const info = {
      container: "wav",
      duration: 60,
      audio: { codec: "pcm_s24le", sampleRate: 96_000, channels: 6, bitDepth: 24 },
    };
    const [format] = deliveryFindings(vinyl, info as never, null);
    expect(format).toMatchObject({ check: "format", severity: "pass" });
  });
});

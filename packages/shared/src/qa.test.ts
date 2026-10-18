import { describe, expect, it } from "vitest";
import type { LoudnessSummary } from "./loudness.ts";
import type { MediaInfo } from "./media.ts";
import {
  type CustomProfile,
  customProfileInput,
  customRef,
  type DeliveryProfile,
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
    expect(effectiveProfile(all, 2, customs, false)).toMatchObject({ ref: "cd", source: "file" });
    expect(effectiveProfile({ ...all, file: null }, 2, customs, false).source).toBe("track");
    expect(effectiveProfile({ ...all, file: null, track: null }, 2, customs, false).source).toBe(
      "project",
    );
    const workspace = effectiveProfile({ workspace: all.workspace }, 2, customs, false);
    expect(workspace).toMatchObject({ source: "workspace", profile: { label: "Vinyl cut" } });
  });

  it("suggests from the channels when nothing chooses, and passes over a deleted profile", () => {
    expect(effectiveProfile({}, 6, customs, false)).toMatchObject({
      ref: "surround",
      source: "suggested",
    });
    const gone = customRef("0190a6f0-0000-7000-8000-0000000000bb");
    expect(profileFor(gone, customs)).toBeNull();
    expect(effectiveProfile({ track: gone, project: "cd" }, 2, customs, false).source).toBe(
      "project",
    );
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

describe("layouts and Atmos (#74)", () => {
  const layout = (channels: number, channelLayout?: string) => ({
    audio: { codec: "pcm_s24le", channels, sampleRate: 48_000, bitDepth: 24, channelLayout },
  });
  const adm = (over: Partial<NonNullable<NonNullable<MediaInfo["metadata"]>["adm"]>> = {}) => ({
    ...layout(14, "14 channels"),
    metadata: {
      tags: {},
      adm: { bytes: 900, bed: 12, layout: "7.1.4", objects: 2, lfe: [3], dolby: true, ...over },
    },
  });

  it("checks how the channels are laid out, where the count is right", () => {
    const surround = deliveryProfiles.surround;
    expect(by(deliveryFindings(surround, layout(6, "5.1(side)"), null), "layout")).toMatchObject({
      severity: "pass",
      summary: "5.1, as Surround 5.1 asks",
    });
    expect(by(deliveryFindings(surround, layout(6, "hexagonal"), null), "layout")).toMatchObject({
      severity: "fail",
      summary: "Laid out as 6.0; Surround 5.1 asks for 5.1",
    });
    expect(by(deliveryFindings(surround, layout(6), null), "layout")).toMatchObject({
      severity: "warn",
      summary: "The file does not say how its 6 channels are laid out; Surround 5.1 asks for 5.1",
    });
    // A count the format check fails is not reported twice.
    expect(by(deliveryFindings(surround, layout(2, "stereo"), null), "layout")).toBeUndefined();
    expect(
      by(deliveryFindings(deliveryProfiles.streaming, layout(2, "stereo"), null), "layout"),
    ).toBeUndefined();
  });

  it("asks an Atmos delivery for its ADM, and notes one nobody asked for", () => {
    const atmos = deliveryProfiles.atmos;
    expect(by(deliveryFindings(atmos, adm(), null), "atmos")).toMatchObject({
      severity: "pass",
      summary: "ADM BWF: 7.1.4 bed + 2 objects, with Dolby metadata",
    });
    // As many channels as the bed and objects need: the count is no fault.
    expect(by(deliveryFindings(atmos, adm(), null), "format")?.severity).toBe("pass");
    expect(by(deliveryFindings(atmos, adm({ dolby: false }), null), "atmos")?.severity).toBe(
      "warn",
    );
    const plain = { ...layout(12, "7.1.4"), metadata: { tags: {}, adm: null } };
    expect(by(deliveryFindings(atmos, plain, null), "atmos")).toMatchObject({
      severity: "fail",
      summary: expect.stringMatching(/^No ADM metadata: /),
    });
    // A file read before ADM was is not judged either way.
    expect(
      by(deliveryFindings(atmos, { ...plain, metadata: { tags: {} } }, null), "atmos"),
    ).toBeUndefined();
    expect(by(deliveryFindings(deliveryProfiles.streaming, adm(), null), "atmos")).toMatchObject({
      severity: "info",
      summary: "An ADM master (7.1.4 bed + 2 objects), which Streaming does not ask for",
    });
  });

  it("checks an ADM master's bed against a profile's layout, and suggests Atmos for one", () => {
    const immersive: DeliveryProfile = {
      ...deliveryProfiles.atmos,
      label: "Atmos, 7.1.2 bed",
      layout: "7.1.2",
    };
    expect(by(deliveryFindings(immersive, adm(), null), "layout")).toMatchObject({
      severity: "fail",
      summary: "Laid out as 7.1.4; Atmos, 7.1.2 bed asks for 7.1.2",
    });
    expect(suggestedProfile(10, true)).toBe("atmos");
    expect(suggestedProfile(10)).toBe("surround");
    const { id: _, ...input } = {
      id: "",
      label: "Atmos 7.1.2",
      loudness: null,
      truePeakMax: -1,
      sampleRates: { rates: [48_000], atLeast: false },
      bitDepthMin: 24 as const,
      channels: null,
    };
    expect(customProfileInput.safeParse({ ...input, layout: "7.1.2", atmos: true }).success).toBe(
      true,
    );
    expect(customProfileInput.safeParse({ ...input, layout: "6.0" }).success).toBe(false);
  });
});

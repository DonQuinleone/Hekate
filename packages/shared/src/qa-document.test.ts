import { describe, expect, it } from "vitest";
import type { PeakLevel } from "./peaks.ts";
import { deliveryProfiles, type QaFinding } from "./qa.ts";
import {
  cropEnvelope,
  cropWindow,
  findingAdvice,
  findingAt,
  formatDump,
  loudnessCurve,
  loudnessGauge,
  qaDocument,
  qaVerdict,
  reportGroups,
  rulesChecked,
  scaleAt,
  severityCounts,
} from "./qa-document.ts";
import type { CustomRule } from "./qa-rules.ts";

const finding = (f: Partial<QaFinding>): QaFinding => ({
  check: "clipping",
  severity: "fail",
  summary: "Clipped 118 times",
  channel: null,
  start: 12,
  end: 12.5,
  details: {},
  ...f,
});

const streaming = deliveryProfiles.streaming;

describe("the report's verdict (#515)", () => {
  it("says what fails, by name, and that the file is not ready", () => {
    expect(
      qaVerdict(
        [
          finding({}),
          finding({ start: 20 }),
          finding({ check: "true-peak", start: null, end: null }),
        ],
        "ready",
        "Streaming",
      ),
    ).toEqual({ tone: "fail", words: "Not ready for Streaming: clipping and true peak fail." });
    expect(qaVerdict([finding({})], "ready", "CD").words).toBe("Not ready for CD: clipping fails.");
    // Many failing checks are counted rather than listed.
    expect(
      qaVerdict(
        (["clipping", "clicks", "dropouts", "phase"] as const).map((check) => finding({ check })),
        "ready",
        "CD",
      ).words,
    ).toBe("Not ready for CD: clipping, clicks and 2 more fail.");
  });

  it("is ready with what is worth a look, or ready outright", () => {
    expect(qaVerdict([finding({ severity: "warn" })], "ready", "Streaming")).toEqual({
      tone: "warn",
      words: "Ready for Streaming, with one thing worth a look.",
    });
    expect(
      qaVerdict(
        [finding({ severity: "warn" }), finding({ severity: "warn", check: "phase" })],
        "ready",
        "Streaming",
      ).words,
    ).toBe("Ready for Streaming, with 2 things worth a look.");
    expect(
      qaVerdict([finding({ severity: "pass" }), finding({ severity: "info" })], "ready", "CD"),
    ).toEqual({ tone: "pass", words: "Ready for CD: every check passes." });
  });

  it("names a project rule by its own name", () => {
    expect(
      qaVerdict([finding({ check: "custom", details: { name: "ISRC present" } })], "ready", "CD")
        .words,
    ).toBe("Not ready for CD: ISRC present fails.");
  });

  it("says nothing of readiness before the checks have run", () => {
    expect(qaVerdict([], "pending", "CD")).toEqual({
      tone: "pending",
      words: "Still being measured.",
    });
    expect(qaVerdict([], "failed", "CD").tone).toBe("pending");
  });
});

describe("the loudness gauge", () => {
  it("centres on the target, 8 LU either side, numbered every 2 LU", () => {
    const g = loudnessGauge(-16, { target: -14, tolerance: 1 });
    expect(g).toMatchObject({ min: -22, max: -6, target: -14, tolerance: 1, value: -16 });
    expect(g.ticks).toEqual([-22, -20, -18, -16, -14, -12, -10, -8, -6]);
    expect(g.zones).toEqual([
      { from: -16, to: -15, tone: "warn" },
      { from: -15, to: -13, tone: "pass" },
      { from: -13, to: -12, tone: "warn" },
    ]);
    expect(scaleAt(g, -14)).toBe(0.5);
  });

  it("widens to take a value far from the target, numbered in fives", () => {
    const g = loudnessGauge(-31, { target: -14, tolerance: 1 });
    expect(g.min).toBeLessThanOrEqual(-33);
    expect(g.ticks.every((t) => t % 5 === 0)).toBe(true);
    expect(scaleAt(g, -31)).toBeGreaterThan(0);
    // Never past 0 LUFS.
    expect(loudnessGauge(-1, { target: -3, tolerance: 1 }).max).toBe(0);
  });

  it("without a target, reads from −30 to 0 LUFS", () => {
    const g = loudnessGauge(-11.2, null);
    expect(g).toMatchObject({ min: -30, max: 0, target: null, zones: [] });
    expect(g.ticks).toEqual([-30, -25, -20, -15, -10, -5, 0]);
    expect(loudnessGauge(-41, null).min).toBe(-45);
  });
});

describe("a finding's crop", () => {
  it("gives a moment three quarters of a second either side", () => {
    expect(cropWindow({ start: 31, end: 31.04 }, 40)).toEqual({
      from: 30.25,
      to: 31.79,
      markFrom: 31,
      markTo: 31.04,
    });
    expect(cropWindow({ start: 31, end: null }, 40)).toMatchObject({ from: 30.25, to: 31.75 });
  });

  it("gives a passage half as much again either side, at most a minute", () => {
    expect(cropWindow({ start: 10, end: 14 }, 60)).toEqual({
      from: 8,
      to: 16,
      markFrom: 10,
      markTo: 14,
    });
    const long = cropWindow({ start: 100, end: 150 }, 600);
    expect(long).toEqual({ from: 95, to: 155, markFrom: 100, markTo: 150 });
  });

  it("moves rather than cuts at either end of the file", () => {
    expect(cropWindow({ start: 0.1, end: 0.2 }, 40)).toMatchObject({ from: 0, to: 1.6 });
    const last = cropWindow({ start: 39.9, end: 40 }, 40);
    expect(last?.from).toBeCloseTo(38.4);
    expect(last?.to).toBe(40);
  });

  it("is none for the whole file", () => {
    expect(cropWindow({ start: null, end: null }, 40)).toBeNull();
  });

  it("draws the waveform in columns across every channel", () => {
    // Two channels, 10 peaks a second; the second channel louder from the fifth second.
    const count = 100;
    const data = new Int8Array(count * 4);
    for (let p = 0; p < count; p++) {
      data[p * 4] = -10;
      data[p * 4 + 1] = 10;
      data[p * 4 + 2] = p >= 50 ? -100 : -5;
      data[p * 4 + 3] = p >= 50 ? 100 : 5;
    }
    const level: PeakLevel = { channels: 2, sampleRate: 1000, samplesPerPeak: 100, count, data };
    const env = cropEnvelope(level, { from: 4, to: 6 }, 4);
    expect(env).toEqual([
      [-0.08, 0.08],
      [-0.08, 0.08],
      [-0.78, 0.78],
      [-0.78, 0.78],
    ]);
    expect(cropEnvelope(level, { from: 20, to: 21 }, 4)).toBeNull();
  });
});

describe("findings in the report", () => {
  const findings = [
    finding({ check: "true-peak", start: null, end: null, details: { ceiling: -1 } }),
    finding({ start: 30, end: 30.2 }),
    finding({ check: "phase", severity: "warn", start: null, end: null }),
    finding({ check: "dropouts", start: 31, end: 31.04, channel: 1 }),
    finding({ start: 12, end: 12.5 }),
    finding({ check: "dc-offset", severity: "pass", start: null, end: null }),
  ];

  it("groups them by severity, then time, the whole file first; passes left out", () => {
    const groups = reportGroups(findings, streaming, 40, null);
    expect(groups.map((g) => [g.label, g.findings.map((f) => f.at)])).toEqual([
      [
        "Fails",
        ["Whole file", "00:12.000–00:12.500", "00:30.000–00:30.200", "00:31.000–00:31.040"],
      ],
      ["Worth a look", ["Whole file"]],
    ]);
    const dropout = groups[0]?.findings[3];
    expect(dropout).toMatchObject({ name: "Dropouts", channel: "Channel 2" });
    expect(dropout?.crop).toMatchObject({ markFrom: 31, envelope: null });
    expect(groups[0]?.findings[0]?.crop).toBeNull();
    expect(severityCounts(findings)).toEqual({ fail: 4, warn: 1, info: 0, pass: 1 });
  });

  it("sets out the first few of a check in full, and the rest a line each", () => {
    const clicks = Array.from({ length: 7 }, (_, i) =>
      finding({ check: "clicks", start: i * 2, end: i * 2 + 0.01 }),
    );
    const [group] = reportGroups(clicks, streaming, 40, null);
    expect(group?.findings.map((f) => f.illustrated)).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(group?.findings[5]?.crop).toBeNull();
  });

  it("writes where each is", () => {
    expect(findingAt({ start: 12, end: 12.5 })).toBe("00:12.000–00:12.500");
    expect(findingAt({ start: 12, end: 12.001 })).toBe("00:12.000");
    expect(findingAt({ start: null, end: null })).toBe("Whole file");
  });

  it("says what to do, with the numbers the finding gives", () => {
    expect(
      findingAdvice(
        finding({ check: "loudness", details: { integrated: -11.5, target: -14 } }),
        streaming,
      ),
    ).toBe(
      "Bring the master down by 2.5 LU, to −14 LUFS, with gain before the limiter rather than more limiting.",
    );
    expect(
      findingAdvice(
        finding({ check: "loudness", details: { integrated: -16, target: -14 } }),
        streaming,
      ),
    ).toMatch(/^Raise the master by 2\.0 LU, to −14 LUFS, keeping the true peak under −1\.0 dBTP/);
    expect(
      findingAdvice(finding({ check: "true-peak", details: { ceiling: -1 } }), streaming),
    ).toMatch(/^Set the limiter's ceiling to −1\.0 dBTP or below/);
  });
});

describe("the appendices", () => {
  it("draws the loudness curve from the loudest of each stretch, silence as a gap", () => {
    const values = [-20, -18, null, null, -30, -12];
    const curve = loudnessCurve(values, 0.1, { target: -14, tolerance: 1 }, 3);
    expect(curve).toMatchObject({
      duration: 0.6000000000000001,
      points: [-18, null, -12],
      min: -40,
      max: 0,
      target: -14,
    });
    expect(curve?.ticks).toEqual([-40, -35, -30, -25, -20, -15, -10, -5, 0]);
    expect(loudnessCurve([-55], 0.1, null)?.min).toBe(-55);
    expect(loudnessCurve([], 0.1, null)).toBeNull();
  });

  it("lists the rules it was checked against, and how each came out", () => {
    const rule: CustomRule = {
      id: "0190a6f0-0000-7000-8000-000000000001",
      name: "ISRC present",
      appliesTo: "any",
      measure: "isrc",
      operator: "matches",
      value: "?*",
      severity: "warn",
      on: true,
    };
    const info = {
      duration: 40,
      audio: { codec: "pcm_s16le", channels: 2, sampleRate: 44_100, bitDepth: 16 },
    };
    const lines = rulesChecked(
      streaming,
      [rule, { ...rule, id: "0190a6f0-0000-7000-8000-000000000002", name: "Off", on: false }],
      [
        finding({ check: "loudness", severity: "fail", start: null, end: null }),
        finding({ check: "true-peak", severity: "pass", start: null, end: null }),
        finding({ start: 12, end: 12.5 }),
        finding({
          check: "custom",
          severity: "warn",
          start: null,
          end: null,
          details: { rule: rule.id, name: rule.name },
        }),
      ],
      info,
      "ready",
    );
    const by = (label: string) => lines.find((l) => l.label === label);
    expect(by("Integrated loudness")).toEqual({
      source: "profile",
      label: "Integrated loudness",
      asked: "−14 LUFS ± 1 LU",
      result: "fail",
    });
    expect(by("True peak")?.result).toBe("pass");
    expect(by("Sample rate")?.asked).toBe("44.1 kHz or higher");
    // The format was not judged: no finding, so no result.
    expect(by("Bit depth")?.result).toBeNull();
    expect(by("Clipping")).toMatchObject({ source: "signal", result: "fail" });
    // A signal check that found nothing on a measured file passed.
    expect(by("Clicks")?.result).toBe("pass");
    // No picture checks for a recording, and no LFE check for stereo.
    expect(by("Black frames")).toBeUndefined();
    expect(by("LFE")).toBeUndefined();
    expect(by("ISRC present")).toEqual({
      source: "project",
      label: "ISRC present",
      asked: "ISRC matches ?*",
      result: "warn",
    });
    expect(by("Off")).toBeUndefined();
  });

  it("judges each format ask on its own, so a row fails only for its own reason", () => {
    // Stereo 48 kHz at 16-bit, against a profile asking 48 kHz, 24-bit, stereo: only the
    // bit depth misses, though the one format check fails for it.
    const master = {
      ...streaming,
      sampleRates: { rates: [48_000], atLeast: false },
      bitDepthMin: 24 as const,
      channels: 2,
    };
    const info = {
      duration: 40,
      audio: { codec: "pcm_s16le", channels: 2, sampleRate: 48_000, bitDepth: 16 },
    };
    const lines = rulesChecked(
      master,
      [],
      [finding({ check: "format", severity: "fail", start: null, end: null })],
      info,
      "ready",
    );
    const result = (label: string) => lines.find((l) => l.label === label)?.result;
    expect(result("Bit depth")).toBe("fail");
    expect(result("Sample rate")).toBe("pass");
    expect(result("Channels")).toBe("pass");
  });

  it("gives the format and metadata in full", () => {
    expect(
      formatDump({
        format: "wav",
        duration: 40,
        bitRate: 1_411_200,
        audio: {
          codec: "pcm_s16le",
          channels: 2,
          channelLayout: "stereo",
          sampleRate: 44_100,
          bitDepth: 16,
        },
        metadata: {
          tags: { title: "Maple Leaf Rag" },
          bext: { originator: "Endless Hall Records" },
        },
      }),
    ).toEqual([
      ["Container", "wav"],
      ["Codec", "pcm_s16le"],
      ["Sample rate", "44.1 kHz"],
      ["Bit depth", "16-bit"],
      ["Channels", "2 (stereo)"],
      ["Duration", "00:40.000"],
      ["Bit rate", "1411 kb/s"],
      ["Originator", "Endless Hall Records"],
      ["Title", "Maple Leaf Rag"],
      ["ISRC", "none"],
      ["Artwork", "none"],
    ]);
  });
});

describe("the whole document", () => {
  it("is made from the facts, the same for the PDF and the page", () => {
    const doc = qaDocument({
      file: {
        id: "f",
        name: "Maple Leaf Rag - Dry v2.wav",
        track: "Maple Leaf Rag",
        version: 2,
        variant: "Dry",
      },
      workspace: "Endless Hall Records",
      project: "Joplin Rags",
      preparedBy: { name: "Tomas Varga", role: "Engineer" },
      preparedAt: new Date("2026-10-31T14:02:00Z"),
      preparedOn: "2026-10-31 14:02 UTC",
      measuredOn: "2026-10-30",
      profile: streaming,
      rules: [],
      status: "ready",
      loudness: {
        integrated: -16,
        range: 6.2,
        momentaryMax: -10,
        shortTermMax: -12,
        truePeak: 0.4,
        channels: [],
      },
      format: {
        duration: 40,
        audio: { codec: "pcm_s16le", channels: 2, sampleRate: 44_100, bitDepth: 16 },
      },
      findings: [
        finding({}),
        finding({ check: "dc-offset", severity: "pass", start: null, end: null }),
      ],
      peaks: null,
      shortTerm: { values: [-20, -16, -14], secondsPerFrame: 0.1 },
      link: "https://review.example.test/files/f",
    });
    expect(doc.verdict.tone).toBe("fail");
    expect(doc.summary).toMatchObject({ integrated: -16, truePeak: 0.4, ceiling: -1 });
    expect(doc.summary.gauge?.target).toBe(-14);
    expect(doc.groups).toHaveLength(1);
    expect(doc.passed).toEqual([{ name: "DC offset", summary: "Clipped 118 times" }]);
    expect(doc.appendix.curve?.points).toEqual([-20, -16, -14]);
    expect(doc.appendix.link).toBe("https://review.example.test/files/f");
    // It travels as JSON unchanged.
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });
});

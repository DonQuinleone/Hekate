import { describe, expect, it } from "vitest";
import type { QaFinding } from "./qa.ts";
import {
  applyQaSettings,
  type CustomRule,
  checkRuns,
  customRule,
  defaultQaSettings,
  meetsRule,
  openQaCategories,
  qaSettingsOf,
  ruleCategory,
  ruleFindings,
  uploadRuleRefusals,
  wildcardMatches,
} from "./qa-rules.ts";

const finding = (check: QaFinding["check"], severity: QaFinding["severity"]): QaFinding => ({
  check,
  severity,
  summary: check,
  channel: null,
  start: null,
  end: null,
  details: {},
});

const rule = (over: Partial<CustomRule>): CustomRule => ({
  id: "0190a6f0-0000-7000-8000-0000000000aa",
  name: "Masters at 96 kHz",
  appliesTo: "audio",
  measure: "sampleRate",
  operator: "is",
  value: "96",
  severity: "fail",
  on: true,
  ...over,
});

const info = {
  duration: 200,
  audio: { codec: "flac", channels: 2, sampleRate: 48_000, bitDepth: 24 },
};
const summary = {
  integrated: -15.2,
  range: 7,
  momentaryMax: null,
  shortTermMax: null,
  truePeak: -0.4,
  channels: [],
};

describe("QA rules", () => {
  it("keeps signal checks, drops delivery checks when switched off, and moves severities", () => {
    const found = [
      finding("clipping", "fail"),
      finding("loudness", "warn"),
      finding("true-peak", "fail"),
      finding("format", "pass"),
    ];
    expect(applyQaSettings(found, defaultQaSettings)).toEqual(found);
    const off = applyQaSettings(found, { ...defaultQaSettings, delivery: false });
    expect(off.map((f) => f.check)).toEqual(["clipping"]);
    // Silence is reported as info; the project's severity applies to it as to any other.
    const quiet = applyQaSettings([finding("silence", "info")], {
      ...defaultQaSettings,
      checks: { silence: { on: true, severity: "warn" } },
    });
    expect(quiet.map((f) => f.severity)).toEqual(["warn"]);
    const tuned = applyQaSettings(found, {
      ...defaultQaSettings,
      checks: {
        clipping: { on: false, severity: "warn" },
        "true-peak": { on: false, severity: null },
        format: { on: true, severity: "info" },
      },
    });
    // A signal check cannot be turned off, only softened; a pass stays a pass.
    expect(tuned.map((f) => [f.check, f.severity])).toEqual([
      ["clipping", "warn"],
      ["loudness", "warn"],
      ["format", "pass"],
    ]);
  });

  it("measures a rule of the project's own, passed or at its severity", () => {
    const [failed] = ruleFindings([rule({})], { name: "Rag.flac" }, info, summary);
    expect(failed).toMatchObject({ check: "custom", severity: "fail" });
    expect(failed?.summary).toBe("Masters at 96 kHz: 48 kHz, not is 96");
    const [passed] = ruleFindings(
      [rule({ measure: "integrated", operator: "between", value: "−16 to −14", severity: "warn" })],
      { name: "Rag.flac" },
      info,
      summary,
    );
    expect(passed?.severity).toBe("pass");
    // Switched off, for immersive audio only, or with nothing measured: no finding.
    expect(ruleFindings([rule({ on: false })], { name: "x" }, info, summary)).toEqual([]);
    expect(ruleFindings([rule({ appliesTo: "immersive" })], { name: "x" }, info, summary)).toEqual(
      [],
    );
    expect(
      ruleFindings([rule({ measure: "truePeak", value: "-1" })], { name: "x" }, info, null),
    ).toEqual([]);
  });

  it("asks what a file says about itself, once that has been read (#41)", () => {
    const isrc = rule({
      name: "ISRC embedded",
      measure: "isrc",
      operator: "matches",
      value: "????????????",
      severity: "warn",
    });
    const tagged = {
      ...info,
      metadata: { tags: { isrc: "GBEHR2600001" }, bext: { originator: "Endless Hall Records" } },
    };
    expect(ruleFindings([isrc], { name: "x" }, tagged, summary)[0]?.severity).toBe("pass");
    // A field the file lacks reads as empty, and is said to be missing.
    const [missing] = ruleFindings(
      [isrc],
      { name: "x" },
      { ...info, metadata: { tags: {} } },
      null,
    );
    expect(missing).toMatchObject({
      severity: "warn",
      summary: "ISRC embedded: none, not matches ????????????",
    });
    // A file whose metadata was never read is not judged on it.
    expect(ruleFindings([isrc], { name: "x" }, info, summary)).toEqual([]);
    const originator = rule({ measure: "originator", operator: "matches", value: "?*" });
    expect(ruleFindings([originator], { name: "x" }, tagged, null)[0]?.severity).toBe("pass");
    expect(ruleCategory(isrc)).toBe("metadata");
  });

  it("compares numbers, lists, ranges and names", () => {
    expect(meetsRule({ operator: "atMost", value: "−1" }, -1)).toBe(true);
    expect(meetsRule({ operator: "atMost", value: "-1" }, -0.4)).toBe(false);
    expect(meetsRule({ operator: "oneOf", value: "44.1, 48" }, 48)).toBe(true);
    expect(meetsRule({ operator: "between", value: "-16 to -14" }, -15.2)).toBe(true);
    expect(meetsRule({ operator: "oneOf", value: "flac; wav" }, "FLAC")).toBe(true);
    expect(meetsRule({ operator: "matches", value: "*_master.wav" }, "Rag_Master.WAV")).toBe(true);
    expect(meetsRule({ operator: "matches", value: "*_master.wav" }, "Rag_master.flac")).toBe(
      false,
    );
    // A pattern is a pattern, not a regular expression.
    expect(meetsRule({ operator: "matches", value: "a.c" }, "abc")).toBe(false);
    expect(meetsRule({ operator: "matches", value: "rag_v?.wav" }, "Rag_V3.wav")).toBe(true);
    expect(meetsRule({ operator: "matches", value: "*" }, "")).toBe(true);
  });

  it("refuses a rule that cannot be measured as written", () => {
    expect(customRule.safeParse(rule({})).success).toBe(true);
    expect(customRule.safeParse(rule({ value: "fast" })).success).toBe(false);
    expect(customRule.safeParse(rule({ operator: "between", value: "96" })).success).toBe(false);
    expect(customRule.safeParse(rule({ operator: "matches" })).success).toBe(false);
    expect(customRule.safeParse(rule({ measure: "codec", operator: "atLeast" })).success).toBe(
      false,
    );
  });

  it("reads stored settings safely", () => {
    expect(qaSettingsOf(null)).toEqual(defaultQaSettings);
    expect(qaSettingsOf({ delivery: "yes" })).toEqual(defaultQaSettings);
    const kept = { delivery: false, checks: {}, rules: [rule({})] };
    expect(qaSettingsOf(kept)).toEqual(kept);
  });

  it("matches wildcards in time that grows with the name, however the pattern is made", () => {
    expect(wildcardMatches("*a*a*a*a*a*a*a*b", "a".repeat(5000))).toBe(false);
    expect(wildcardMatches("*a*a*a*a*a*a*a*b", `${"a".repeat(5000)}b`)).toBe(true);
    const started = Date.now();
    for (let i = 0; i < 20; i++) wildcardMatches("*a*a*a*a*a*a*a*a*a*a*a*b", "a".repeat(255));
    expect(Date.now() - started).toBeLessThan(500);
    // Long runs of spaces in a list or a range are read as plainly.
    expect(meetsRule({ operator: "oneOf", value: `44.1${" ".repeat(10_000)}, 48` }, 48)).toBe(true);
  });
});

describe("uploadRuleRefusals", () => {
  const file = {
    name: "Rag.flac",
    info,
    summary,
    probing: false,
    measuring: false,
  } as Parameters<typeof uploadRuleRefusals>[1][number];

  it("holds a version back on a rule marked On upload that fails, saying why", () => {
    const [refused] = uploadRuleRefusals([rule({ onUpload: true })], [file]);
    expect(refused).toMatchObject({ check: "rule", rule: "Masters at 96 kHz", file: "Rag.flac" });
    expect(refused?.message).toContain("Masters at 96 kHz: 48 kHz, not is 96");
  });

  it("lets it through where the rule passes, is not marked, or is switched off", () => {
    expect(uploadRuleRefusals([rule({ onUpload: true, value: "48" })], [file])).toEqual([]);
    expect(uploadRuleRefusals([rule({})], [file])).toEqual([]);
    expect(uploadRuleRefusals([rule({ onUpload: true, on: false })], [file])).toEqual([]);
  });

  it("waits for a file still being probed, and for its loudness where a rule asks it", () => {
    const loud = rule({ onUpload: true, measure: "truePeak", operator: "atMost", value: "-1" });
    expect(uploadRuleRefusals([loud], [{ ...file, measuring: true }])[0]?.check).toBe("measuring");
    // A rule on the format is judged as soon as the probe is in.
    expect(
      uploadRuleRefusals([rule({ onUpload: true })], [{ ...file, measuring: true }])[0]?.check,
    ).toBe("rule");
    expect(
      uploadRuleRefusals([rule({ onUpload: true })], [{ ...file, probing: true }])[0]?.check,
    ).toBe("measuring");
  });

  it("keeps rules made before it as they were", () => {
    expect(customRule.safeParse(rule({})).success).toBe(true);
    expect(customRule.parse(rule({ onUpload: true })).onUpload).toBe(true);
  });
});

describe("checkRuns", () => {
  it("runs a signal check always, and a delivery check only with the delivery checks and its own", () => {
    expect(checkRuns({ ...defaultQaSettings, delivery: false }, "clipping")).toBe(true);
    expect(checkRuns(defaultQaSettings, "true-peak")).toBe(true);
    expect(checkRuns({ ...defaultQaSettings, delivery: false }, "true-peak")).toBe(false);
    expect(
      checkRuns(
        { ...defaultQaSettings, checks: { "true-peak": { on: false, severity: null } } },
        "true-peak",
      ),
    ).toBe(false);
  });
});

describe("openQaCategories", () => {
  it("opens what the profile works with and folds the rest", () => {
    expect([...openQaCategories("music", ["audio", "document"])].sort()).toEqual([
      "artwork",
      "audio",
      "metadata",
      "naming",
    ]);
    expect(openQaCategories("music", ["audio"]).has("video")).toBe(false);
    expect(openQaCategories("music", ["audio"]).has("immersive")).toBe(false);
    expect(openQaCategories("video", []).has("video")).toBe(true);
    expect(openQaCategories("general", ["document"]).has("audio")).toBe(false);
    expect(openQaCategories("general", ["audio"]).has("audio")).toBe(true);
  });
});

import type { QaFinding } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { filterFindings, findingLoop, findingMarks, qaIssues } from "./qa";

describe("qaIssues (#15)", () => {
  const of = (check: string, severity: string) => ({ check, severity }) as unknown as QaFinding;
  it("counts each check that found something once, failures and warnings alike", () => {
    expect(
      qaIssues([
        of("clipping", "fail"),
        of("clipping", "fail"),
        of("truePeak", "warn"),
        of("loudness", "pass"),
        of("silence", "note"),
      ]),
    ).toBe(2);
    expect(qaIssues([])).toBe(0);
  });
});

const finding = (start: number | null, end: number | null) =>
  ({ start, end }) as unknown as QaFinding;

describe("findingLoop", () => {
  it("loops the passage a finding spans", () => {
    expect(findingLoop(finding(12.4, 13.9))).toEqual({ start: 12.4, end: 13.9 });
  });

  it("has nothing to loop for a moment, or a finding about the whole file", () => {
    expect(findingLoop(finding(12.4, 12.41))).toBeNull();
    expect(findingLoop(finding(12.4, null))).toBeNull();
    expect(findingLoop(finding(null, null))).toBeNull();
  });
});

describe("findingMarks (#43)", () => {
  const of = (severity: string, start: number | null, end: number | null = null) =>
    ({ severity, start, end }) as unknown as QaFinding;
  it("marks failures and warnings that have a place, and nothing else", () => {
    expect(
      findingMarks([
        of("fail", 12, 12.5),
        of("warn", 30),
        of("pass", 5),
        of("note", 7),
        of("fail", null),
      ]),
    ).toEqual([
      { start: 12, end: 12.5, severity: "fail" },
      { start: 30, end: null, severity: "warn" },
    ]);
  });
});

describe("filterFindings (#43)", () => {
  const finding = (check: QaFinding["check"], severity: QaFinding["severity"]): QaFinding => ({
    check,
    severity,
    summary: "",
    channel: null,
    start: null,
    end: null,
    details: {},
  });
  const all = [
    finding("clipping", "fail"),
    finding("clipping", "warn"),
    finding("loudness", "fail"),
    finding("silence", "info"),
  ];
  it("narrows to a severity, a check, both, or neither", () => {
    const none = { severity: null, check: null };
    expect(filterFindings(all, none)).toEqual(all);
    expect(filterFindings(all, { ...none, severity: "fail" }).map((f) => f.check)).toEqual([
      "clipping",
      "loudness",
    ]);
    expect(filterFindings(all, { ...none, check: "clipping" })).toHaveLength(2);
    expect(filterFindings(all, { severity: "warn", check: "loudness" })).toEqual([]);
  });
});

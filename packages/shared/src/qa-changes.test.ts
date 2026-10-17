import { describe, expect, it } from "vitest";
import type { QaFinding } from "./qa.ts";
import { findingChanges } from "./qa-changes.ts";

const finding = (f: Partial<QaFinding>): QaFinding => ({
  check: "clipping",
  severity: "fail",
  summary: "Clipping",
  channel: null,
  start: null,
  end: null,
  details: {},
  ...f,
});

describe("what changed in the checks between versions", () => {
  it("calls a problem gone from the later version fixed, and one only it has new", () => {
    const clip = finding({ check: "clipping", start: 12, end: 12.2, channel: 0 });
    const loud = finding({ check: "loudness", severity: "warn", summary: "Too loud" });
    const dropout = finding({ check: "dropouts", start: 40, end: 40.1 });
    const changes = findingChanges([clip, loud], [loud, dropout]);
    expect(changes.fixed).toEqual([clip]);
    expect(changes.new).toEqual([dropout]);
  });

  it("follows the music to where it went, and tells channels and rules apart", () => {
    const clip = finding({ check: "clipping", start: 12, end: 12.2, channel: 0 });
    // The edit moved everything two seconds later: the same click, not a fixed and a new one.
    const moved = finding({ check: "clipping", start: 14.1, end: 14.3, channel: 0 });
    expect(findingChanges([clip], [moved], (t) => t + 2)).toEqual({ fixed: [], new: [] });
    // Without the alignment, they are too far apart to be one.
    expect(findingChanges([clip], [moved]).fixed).toEqual([clip]);
    // The other channel is another problem.
    const right = { ...moved, channel: 1 };
    expect(findingChanges([clip], [right], (t) => t + 2).new).toEqual([right]);
    // A project's rules are told apart by name.
    const peak = finding({ check: "custom", details: { name: "Peaks below -1" } });
    const rate = finding({ check: "custom", details: { name: "96 kHz masters" } });
    expect(findingChanges([peak], [rate])).toEqual({ fixed: [peak], new: [rate] });
  });

  it("counts only warnings and failures as problems", () => {
    const pass = finding({ check: "phase", severity: "pass" });
    const note = finding({ check: "dc-offset", severity: "info" });
    expect(findingChanges([pass, note], [])).toEqual({ fixed: [], new: [] });
    expect(findingChanges([], [pass, note])).toEqual({ fixed: [], new: [] });
  });
});

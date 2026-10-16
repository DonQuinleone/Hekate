import type { QaFinding } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { findingLoop } from "./qa";

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

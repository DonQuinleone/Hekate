import { FIELD_BINS } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { describeField, fieldOutline, mostlyBeyond, readField } from "./stereo-field";

const shares = (entries: Record<number, number>) => {
  const out = new Float32Array(FIELD_BINS);
  for (const [bin, share] of Object.entries(entries)) out[Number(bin)] = share;
  return out;
};

describe("the stereo field", () => {
  it("reads where it leans and how much lies beyond the speakers", () => {
    expect(readField(shares({ 7: 1 }))).toEqual({ lean: "centre", beyond: 0 });
    expect(readField(shares({ 3: 0.6, 7: 0.4 })).lean).toBe("left");
    expect(readField(shares({ 11: 0.6, 7: 0.4 })).lean).toBe("right");
    // Out of phase on its own leans neither way.
    const flat = readField(shares({ 15: 0.25, 7: 0.75 }));
    expect(flat.lean).toBe("centre");
    expect(flat.beyond).toBeCloseTo(0.25, 5);
    expect(readField(shares({ 1: 0.5, 13: 0.5 })).beyond).toBeCloseTo(1, 5);
    // Out of phase is more than any wide mix puts there.
    expect(mostlyBeyond(readField(shares({ 15: 0.6, 7: 0.4 })))).toBe(true);
    expect(mostlyBeyond(readField(shares({ 7: 0.6, 13: 0.4 })))).toBe(false);
    expect(readField(new Float32Array(FIELD_BINS))).toEqual({ lean: null, beyond: 0 });
  });

  it("says it in words", () => {
    expect(describeField({ lean: null, beyond: 0 })).toBe("Silent");
    expect(describeField({ lean: "centre", beyond: 0.02 })).toBe("Centred");
    expect(describeField({ lean: "left", beyond: 0.124 })).toBe(
      "Leans left, 12% beyond the speakers",
    );
  });

  it("draws the trace's outline from left to right, the flat bin at both ends", () => {
    const outline = fieldOutline(shares({ 7: 1, 15: 0.25 }));
    expect(outline).toHaveLength(FIELD_BINS + 1);
    // Straight up at full size for mono, flat at half size either side for out of phase.
    expect(outline[8]?.x).toBeCloseTo(0, 5);
    expect(outline[8]?.y).toBeCloseTo(1, 5);
    expect(outline[0]?.x).toBeCloseTo(-0.5, 5);
    expect(outline[16]?.x).toBeCloseTo(0.5, 5);
    expect(outline[0]?.y).toBeCloseTo(0, 5);
    expect(fieldOutline(new Float32Array(FIELD_BINS))).toEqual([]);
  });
});

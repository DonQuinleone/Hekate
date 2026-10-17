import { describe, expect, it } from "vitest";
import { positionIn } from "./tracks";

describe("moving between versions at the same music (#15)", () => {
  const alignments = [
    {
      fileId: "v2",
      points: [
        [0, 0],
        [60, 62],
      ] as [number, number][],
    },
  ];

  it("follows the alignment to another version, and keeps the time where there is none", () => {
    expect(positionIn("v2", 30, alignments)).toBe(31);
    expect(positionIn("wet", 30.12345, alignments)).toBe(30.123);
  });

  it("never starts before the beginning", () => {
    expect(positionIn("v3", 5, [{ fileId: "v3", points: [[10, 0]] }])).toBe(0);
  });
});

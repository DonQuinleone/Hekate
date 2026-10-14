import { describe, expect, it } from "vitest";
import { createVersionInput, variationNameFrom, withPrimary } from "./tracks.ts";

const a = "0190a6f0-0000-7000-8000-00000000000a";
const b = "0190a6f0-0000-7000-8000-00000000000b";

describe("tracks", () => {
  it("needs at least one variation, one primary at most, and each file once", () => {
    expect(createVersionInput.safeParse({ variations: [] }).success).toBe(false);
    expect(
      createVersionInput.safeParse({
        variations: [
          { fileId: a, name: "Dry", primary: true },
          { fileId: b, name: "Wet", primary: true },
        ],
      }).success,
    ).toBe(false);
    expect(
      createVersionInput.safeParse({
        variations: [
          { fileId: a, name: "Dry" },
          { fileId: a, name: "Wet" },
        ],
      }).success,
    ).toBe(false);
  });

  it("makes exactly one variation primary, the first unless another is chosen", () => {
    type Input = { name: string; primary?: boolean };
    const plain: Input[] = [{ name: "Dry" }, { name: "Wet" }];
    const chosen: Input[] = [{ name: "Dry" }, { name: "Wet", primary: true }];
    expect(withPrimary(plain).map((v) => v.isPrimary)).toEqual([true, false]);
    expect(withPrimary(chosen).map((v) => [v.isPrimary, v.position])).toEqual([
      [false, 0],
      [true, 1],
    ]);
  });

  it("names a variation from its file, without the track's name", () => {
    expect(variationNameFrom("Maple Leaf Rag - Dry mix v3.wav", "Maple Leaf Rag")).toBe(
      "Dry mix v3",
    );
    expect(variationNameFrom("Wet.flac")).toBe("Wet");
    expect(variationNameFrom(".wav")).toBe("Main");
  });
});

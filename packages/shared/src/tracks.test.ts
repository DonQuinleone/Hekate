import { describe, expect, it } from "vitest";
import { createVersionInput, variationNameFrom, versionRefusals, withPrimary } from "./tracks.ts";

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

describe("version checks", () => {
  const off = { truePeak: false, edl: false };
  const hot = { name: "V3 dry.wav", channels: 2, truePeak: 0.2 };
  it("let everything in when the project asks nothing", () => {
    expect(versionRefusals(off, null, [hot], false)).toEqual([]);
  });
  it("refuse a true peak over the ceiling, saying by how much and against what", () => {
    const [refusal] = versionRefusals(
      { truePeak: true, edl: false },
      "apple-digital-masters",
      [hot, { name: "notes.pdf", channels: null, truePeak: null }],
      false,
    );
    expect(refusal).toMatchObject({ check: "true_peak", truePeak: 0.2, ceiling: -1 });
    expect(refusal?.message).toBe(
      "The upload workflow refused V3 dry.wav: true peak +0.2 dBTP is over the −1.0 dBTP ceiling of Apple Digital Masters. Fix the export and upload again, or ask a producer to let it through.",
    );
    expect(
      versionRefusals({ truePeak: true, edl: false }, null, [{ ...hot, truePeak: -1.5 }], false),
    ).toEqual([]);
  });
  it("wait for a file still being measured, and ask for an EDL where the project does", () => {
    expect(
      versionRefusals(
        { truePeak: true, edl: true },
        null,
        [{ ...hot, truePeak: undefined }],
        false,
      ).map((r) => r.check),
    ).toEqual(["measuring", "edl"]);
    // Not yet probed: its channels are unknown, so it is still being measured.
    expect(
      versionRefusals(
        { truePeak: true, edl: false },
        null,
        [{ ...hot, channels: undefined, truePeak: null }],
        false,
      ).map((r) => r.check),
    ).toEqual(["measuring"]);
    expect(versionRefusals({ truePeak: false, edl: true }, null, [hot], true)).toEqual([]);
  });
});

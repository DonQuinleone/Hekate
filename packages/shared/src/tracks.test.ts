import { describe, expect, it } from "vitest";
import { deliveryProfiles, suggestedProfile } from "./qa.ts";
import { createVersionInput, variantNameFrom, versionRefusals, withPrimary } from "./tracks.ts";

const a = "0190a6f0-0000-7000-8000-00000000000a";
const b = "0190a6f0-0000-7000-8000-00000000000b";

describe("tracks", () => {
  it("needs at least one variant, one primary at most, and each file once", () => {
    expect(createVersionInput.safeParse({ variants: [] }).success).toBe(false);
    expect(
      createVersionInput.safeParse({
        variants: [
          { fileId: a, name: "Dry", primary: true },
          { fileId: b, name: "Wet", primary: true },
        ],
      }).success,
    ).toBe(false);
    expect(
      createVersionInput.safeParse({
        variants: [
          { fileId: a, name: "Dry" },
          { fileId: a, name: "Wet" },
        ],
      }).success,
    ).toBe(false);
  });

  it("reads the variants under either name, and answers with the new one (decision 275)", () => {
    const sent = [{ fileId: a, name: "Dry" }];
    expect(createVersionInput.parse({ variants: sent })).toMatchObject({ variants: sent });
    const parsed = createVersionInput.parse({ variations: sent });
    expect(parsed).toMatchObject({ variants: sent });
    expect("variations" in parsed).toBe(false);
    expect(createVersionInput.safeParse({ notes: "No files" }).success).toBe(false);
  });

  it("makes exactly one variant primary, the first unless another is chosen", () => {
    type Input = { name: string; primary?: boolean };
    const plain: Input[] = [{ name: "Dry" }, { name: "Wet" }];
    const chosen: Input[] = [{ name: "Dry" }, { name: "Wet", primary: true }];
    expect(withPrimary(plain).map((v) => v.isPrimary)).toEqual([true, false]);
    expect(withPrimary(chosen).map((v) => [v.isPrimary, v.position])).toEqual([
      [false, 0],
      [true, 1],
    ]);
  });

  it("names a variant from its file, without the track's name", () => {
    expect(variantNameFrom("Maple Leaf Rag - Dry mix v3.wav", "Maple Leaf Rag")).toBe("Dry mix v3");
    expect(variantNameFrom("Wet.flac")).toBe("Wet");
    expect(variantNameFrom(".wav")).toBe("Main");
  });
});

describe("version checks", () => {
  const suggested = (f: { channels: number }) => deliveryProfiles[suggestedProfile(f.channels)];
  const off = { truePeak: false, edl: false };
  const hot = { name: "V3 dry.wav", channels: 2, truePeak: 0.2 };
  it("let everything in when the project asks nothing", () => {
    expect(versionRefusals(off, suggested, [hot], null)).toEqual([]);
  });
  it("refuse a true peak over the ceiling, saying by how much and against what", () => {
    const [refusal] = versionRefusals(
      { truePeak: true, edl: false },
      () => deliveryProfiles["apple-digital-masters"],
      [hot, { name: "notes.pdf", channels: null, truePeak: null }],
      null,
    );
    expect(refusal).toMatchObject({ check: "true_peak", truePeak: 0.2, ceiling: -1 });
    expect(refusal?.message).toBe(
      "The upload workflow refused V3 dry.wav: true peak +0.2 dBTP is over the −1.0 dBTP ceiling of Apple Digital Masters. Fix the export and upload again, or ask a producer to let it through.",
    );
    expect(
      versionRefusals(
        { truePeak: true, edl: false },
        suggested,
        [{ ...hot, truePeak: -1.5 }],
        null,
      ),
    ).toEqual([]);
  });
  it("wait for a file still being measured, and ask for an EDL where the project does", () => {
    expect(
      versionRefusals(
        { truePeak: true, edl: true },
        suggested,
        [{ ...hot, truePeak: undefined }],
        null,
      ).map((r) => r.check),
    ).toEqual(["measuring", "edl"]);
    // Not yet probed: its channels are unknown, so it is still being measured.
    expect(
      versionRefusals(
        { truePeak: true, edl: false },
        suggested,
        [{ ...hot, channels: undefined, truePeak: null }],
        null,
      ).map((r) => r.check),
    ).toEqual(["measuring"]);
    const list = { name: "V3.edl", edits: 12, end: 184.5 };
    expect(
      versionRefusals({ truePeak: false, edl: true }, suggested, [{ ...hot, duration: 185 }], list),
    ).toEqual([]);
  });
  it("read the list it asks for: edits it can read, ending within the version", () => {
    const rule = { truePeak: false, edl: true };
    const [empty] = versionRefusals(rule, suggested, [hot], { name: "V3.edl", edits: 0, end: 0 });
    expect(empty).toMatchObject({ check: "edl_unreadable", file: "V3.edl" });
    expect(empty?.message).toBe(
      "The upload workflow could not read any edits in V3.edl. Export it again as a CMX 3600 edit decision list, or ask a producer to let it through.",
    );
    const long = { name: "V2.edl", edits: 9, end: 212.4 };
    const [past] = versionRefusals(rule, suggested, [{ ...hot, duration: 185.2 }], long);
    expect(past).toMatchObject({ check: "edl_too_long", end: 212.4, duration: 185.2 });
    expect(past?.message).toBe(
      "The upload workflow refused V2.edl: its edits run to 3:32, past the end of this version at 3:05, so it may be another version's list. Attach this version's EDL, or ask a producer to let it through.",
    );
    // A tail under a second is an export's rounding; the longest variant counts; a version
    // not yet measured is not judged on its length.
    const near = { name: "V3.edl", edits: 9, end: 185.9 };
    expect(versionRefusals(rule, suggested, [{ ...hot, duration: 185.2 }], near)).toEqual([]);
    expect(
      versionRefusals(
        rule,
        suggested,
        [
          { ...hot, duration: 120 },
          { ...hot, name: "V3 wet.wav", duration: 213 },
        ],
        long,
      ),
    ).toEqual([]);
    expect(versionRefusals(rule, suggested, [hot], long)).toEqual([]);
    // Nor while one variant is still being probed: it may be the longer one.
    expect(
      versionRefusals(
        rule,
        suggested,
        [
          { ...hot, duration: 120 },
          { ...hot, name: "V3 wet.wav", duration: undefined },
        ],
        long,
      ),
    ).toEqual([]);
    // A file with no length (notes beside the mixes) does not hold it up.
    expect(
      versionRefusals(
        rule,
        suggested,
        [
          { ...hot, duration: 120 },
          { name: "notes.pdf", channels: null, truePeak: null, duration: null },
        ],
        long,
      ).map((r) => r.check),
    ).toEqual(["edl_too_long"]);
    // Without the rule, nothing about the list is checked.
    expect(versionRefusals(off, suggested, [{ ...hot, duration: 10 }], long)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  primaryOf,
  type StripVersion,
  variantChoices,
  variantNames,
  versionChoices,
} from "./versions";

const v1: StripVersion = {
  id: "v1",
  number: 1,
  variants: [
    { fileId: "v1-wet", name: "Wet", isPrimary: false, streamStatus: "ready" },
    { fileId: "v1-dry", name: "Dry", isPrimary: true, streamStatus: "ready" },
  ],
};
const v2: StripVersion = {
  id: "v2",
  number: 2,
  variants: [{ fileId: "v2-dry", name: "Dry", isPrimary: true, streamStatus: "ready" }],
};
const v3: StripVersion = {
  id: "v3",
  number: 3,
  variants: [
    { fileId: "v3-dry", name: "Dry", isPrimary: true, streamStatus: "pending" },
    { fileId: "v3-atmos", name: "Atmos", isPrimary: false, streamStatus: "failed" },
  ],
};

describe("the version menu above the player (#15)", () => {
  it("lists the newest first, marking the one heard and the latest", () => {
    const choices = versionChoices([v1, v2], { versionId: "v1", variantName: "Dry" });
    expect(choices.map((c) => [c.number, c.fileId, c.hint, c.current])).toEqual([
      [2, "v2-dry", "latest", false],
      [1, "v1-dry", undefined, true],
    ]);
  });

  it("opens the variant of the same name, else the primary", () => {
    const choices = versionChoices([v1, v2], { versionId: "v2", variantName: "Wet" });
    expect(choices.find((c) => c.number === 1)?.fileId).toBe("v1-wet");
    expect(choices.find((c) => c.number === 2)?.fileId).toBe("v2-dry");
  });

  it("says a version is still being prepared, before saying it is the latest", () => {
    const [newest] = versionChoices([v1, v2, v3], { versionId: "v2", variantName: "Dry" });
    expect(newest).toMatchObject({ number: 3, hint: "analysing", latest: true });
    const [failed] = versionChoices([v1, v3], { versionId: "v1", variantName: "Atmos" });
    expect(failed).toMatchObject({ fileId: "v3-atmos", hint: "failed" });
  });

  it("leaves out a version with nothing to open", () => {
    const empty: StripVersion = { id: "v4", number: 4, variants: [] };
    const choices = versionChoices([v1, empty], { versionId: "v1", variantName: "Dry" });
    expect(choices.map((c) => c.number)).toEqual([1]);
    // The latest is the newest version, even one with nothing yet to open.
    expect(choices[0]?.latest).toBe(false);
  });
});

describe("the variant switch (#15)", () => {
  it("keeps the version's order and says which are still being prepared", () => {
    expect(variantChoices(v3)).toEqual([
      { value: "v3-dry", label: "Dry", hint: "analysing" },
      { value: "v3-atmos", label: "Atmos", hint: "failed" },
    ]);
    expect(variantChoices(v1).map((c) => c.hint)).toEqual([undefined, undefined]);
  });
});

describe("the names suggested for a new variant (#486)", () => {
  const project = [
    {
      versions: [
        {
          createdAt: "2026-01-01T10:00:00Z",
          variants: [{ name: "Dry" }, { name: "Wet" }],
        },
        {
          createdAt: "2026-03-01T10:00:00Z",
          variants: [{ name: "dry" }, { name: "Instrumental" }],
        },
      ],
    },
    {
      versions: [{ createdAt: "2026-02-01T10:00:00Z", variants: [{ name: " Wet " }] }],
    },
  ];

  it("lists each name once, the most recently used first, as it was last spelt", () => {
    expect(variantNames(project)).toEqual(["dry", "Instrumental", "Wet"]);
  });

  it("leaves out the names the version already has, whatever their case", () => {
    expect(variantNames(project, ["DRY", "Wet"])).toEqual(["Instrumental"]);
  });

  it("stops at the limit and gives nothing for a project without versions", () => {
    expect(variantNames(project, [], 2)).toEqual(["dry", "Instrumental"]);
    expect(variantNames([{ versions: [] }])).toEqual([]);
  });
});

describe("the file a version opens with", () => {
  it("is its primary variant, else its first", () => {
    expect(primaryOf(v1)?.fileId).toBe("v1-dry");
    expect(primaryOf({ variants: [{ isPrimary: false, fileId: "x" }] })?.fileId).toBe("x");
    expect(primaryOf({ variants: [] })).toBeUndefined();
  });
});

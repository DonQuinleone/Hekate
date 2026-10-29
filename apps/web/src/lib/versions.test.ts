import { describe, expect, it } from "vitest";
import {
  primaryOf,
  type StripVersion,
  variationChoices,
  variationNames,
  versionChoices,
} from "./versions";

const v1: StripVersion = {
  id: "v1",
  number: 1,
  variations: [
    { fileId: "v1-wet", name: "Wet", isPrimary: false, streamStatus: "ready" },
    { fileId: "v1-dry", name: "Dry", isPrimary: true, streamStatus: "ready" },
  ],
};
const v2: StripVersion = {
  id: "v2",
  number: 2,
  variations: [{ fileId: "v2-dry", name: "Dry", isPrimary: true, streamStatus: "ready" }],
};
const v3: StripVersion = {
  id: "v3",
  number: 3,
  variations: [
    { fileId: "v3-dry", name: "Dry", isPrimary: true, streamStatus: "pending" },
    { fileId: "v3-atmos", name: "Atmos", isPrimary: false, streamStatus: "failed" },
  ],
};

describe("the version menu above the player (#15)", () => {
  it("lists the newest first, marking the one heard and the latest", () => {
    const choices = versionChoices([v1, v2], { versionId: "v1", variationName: "Dry" });
    expect(choices.map((c) => [c.number, c.fileId, c.hint, c.current])).toEqual([
      [2, "v2-dry", "latest", false],
      [1, "v1-dry", undefined, true],
    ]);
  });

  it("opens the variation of the same name, else the primary", () => {
    const choices = versionChoices([v1, v2], { versionId: "v2", variationName: "Wet" });
    expect(choices.find((c) => c.number === 1)?.fileId).toBe("v1-wet");
    expect(choices.find((c) => c.number === 2)?.fileId).toBe("v2-dry");
  });

  it("says a version is still being prepared, before saying it is the latest", () => {
    const [newest] = versionChoices([v1, v2, v3], { versionId: "v2", variationName: "Dry" });
    expect(newest).toMatchObject({ number: 3, hint: "analysing", latest: true });
    const [failed] = versionChoices([v1, v3], { versionId: "v1", variationName: "Atmos" });
    expect(failed).toMatchObject({ fileId: "v3-atmos", hint: "failed" });
  });

  it("leaves out a version with nothing to open", () => {
    const empty: StripVersion = { id: "v4", number: 4, variations: [] };
    const choices = versionChoices([v1, empty], { versionId: "v1", variationName: "Dry" });
    expect(choices.map((c) => c.number)).toEqual([1]);
    // The latest is the newest version, even one with nothing yet to open.
    expect(choices[0]?.latest).toBe(false);
  });
});

describe("the variation switch (#15)", () => {
  it("keeps the version's order and says which are still being prepared", () => {
    expect(variationChoices(v3)).toEqual([
      { value: "v3-dry", label: "Dry", hint: "analysing" },
      { value: "v3-atmos", label: "Atmos", hint: "failed" },
    ]);
    expect(variationChoices(v1).map((c) => c.hint)).toEqual([undefined, undefined]);
  });
});

describe("the names suggested for a new variation (#486)", () => {
  const project = [
    {
      versions: [
        {
          createdAt: "2026-01-01T10:00:00Z",
          variations: [{ name: "Dry" }, { name: "Wet" }],
        },
        {
          createdAt: "2026-03-01T10:00:00Z",
          variations: [{ name: "dry" }, { name: "Instrumental" }],
        },
      ],
    },
    {
      versions: [{ createdAt: "2026-02-01T10:00:00Z", variations: [{ name: " Wet " }] }],
    },
  ];

  it("lists each name once, the most recently used first, as it was last spelt", () => {
    expect(variationNames(project)).toEqual(["dry", "Instrumental", "Wet"]);
  });

  it("leaves out the names the version already has, whatever their case", () => {
    expect(variationNames(project, ["DRY", "Wet"])).toEqual(["Instrumental"]);
  });

  it("stops at the limit and gives nothing for a project without versions", () => {
    expect(variationNames(project, [], 2)).toEqual(["dry", "Instrumental"]);
    expect(variationNames([{ versions: [] }])).toEqual([]);
  });
});

describe("the file a version opens with", () => {
  it("is its primary variation, else its first", () => {
    expect(primaryOf(v1)?.fileId).toBe("v1-dry");
    expect(primaryOf({ variations: [{ isPrimary: false, fileId: "x" }] })?.fileId).toBe("x");
    expect(primaryOf({ variations: [] })).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { ensembleBlock, headCount, outstanding, personnelInput } from "./personnel.ts";

const strings = {
  kind: "ensemble" as const,
  agreement: false,
  headphones: false,
  sections: [
    {
      id: "s1",
      name: "Violin I",
      count: 4,
      divisi: "2 + 2",
      members: [
        { id: "m1", name: "Tomas Varga", agreement: true, headphones: true },
        { id: "m2", name: "Ines Arlow", agreement: false, headphones: false },
      ],
    },
    { id: "s2", name: "Cello", count: 2, divisi: "", members: [] },
  ],
};

describe("personnel", () => {
  it("counts an ensemble's players, named or not, and anyone else as one", () => {
    expect(headCount(strings)).toBe(6);
    expect(headCount({ kind: "artist", sections: [] })).toBe(1);
  });

  it("says who still owes an agreement and who needs headphones", () => {
    // One named player unsigned, and the four not yet named.
    expect(outstanding(strings)).toEqual({ unsigned: 5, headphones: 1 });
    expect(
      outstanding({ kind: "artist", agreement: false, headphones: true, sections: [] }),
    ).toEqual({ unsigned: 1, headphones: 1 });
    expect(
      outstanding({
        ...strings,
        agreement: true,
        sections: [{ id: "s2", name: "Cello", count: 2, divisi: "", members: [] }],
      }),
    ).toEqual({ unsigned: 0, headphones: 0 });
  });

  it("sizes an ensemble's block on the stage from its head-count", () => {
    expect(ensembleBlock(1)).toEqual({ w: 1, h: 1.2 });
    expect(ensembleBlock(12)).toEqual({ w: 5, h: 3.6 });
    expect(ensembleBlock(0)).toEqual({ w: 1, h: 1.2 });
  });

  it("takes sections only for an ensemble, and no more names than players", () => {
    const base = { name: "Endless Hall Strings", kind: "ensemble" };
    expect(
      personnelInput.parse({ ...base, sections: [{ name: "Viola", count: 2 }] }).sections,
    ).toEqual([{ name: "Viola", count: 2, divisi: "", members: [] }]);
    expect(
      personnelInput.safeParse({ ...base, kind: "artist", sections: [{ name: "Viola", count: 2 }] })
        .success,
    ).toBe(false);
    expect(
      personnelInput.safeParse({
        ...base,
        sections: [{ name: "Viola", count: 1, members: [{ name: "A" }, { name: "B" }] }],
      }).success,
    ).toBe(false);
    expect(
      personnelInput.safeParse({ ...base, link: { kind: "guest", guestId: "not-an-id" } }).success,
    ).toBe(false);
  });
});

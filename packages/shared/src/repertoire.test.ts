import { describe, expect, it } from "vitest";
import { alphabetical, pdfPages, venueInput, workInput, workLine } from "./repertoire.ts";

const track = (n: number) => `0192f3a0-0000-7000-8000-00000000000${n}`;

describe("repertoire", () => {
  it("shelves works by title, past a leading article, numbers in order", () => {
    const titles = ["The Entertainer", "Rags", "Suite No. 10", "Suite No. 2", "a Solace"];
    expect(alphabetical(titles.map((title) => ({ title }))).map((w) => w.title)).toEqual([
      "The Entertainer",
      "Rags",
      "a Solace",
      "Suite No. 2",
      "Suite No. 10",
    ]);
  });

  it("names a work in one line", () => {
    expect(workLine({ title: "Rags", composer: "Scott Joplin", abbreviation: "RAGS" })).toBe(
      "RAGS · Rags (Scott Joplin)",
    );
    expect(workLine({ title: "Rags", composer: "", abbreviation: "" })).toBe("Rags");
  });

  it("takes a work with its tracks numbered as typed, each once", () => {
    expect(
      workInput.parse({ title: " Rags ", tracks: [{ trackId: track(1), number: "I" }] }),
    ).toEqual({
      title: "Rags",
      composer: "",
      forces: "",
      abbreviation: "",
      notes: "",
      scoreFileId: null,
      pageOffset: 0,
      tracks: [{ trackId: track(1), number: "I", pageFrom: null, pageTo: null }],
    });
    expect(
      workInput.safeParse({
        title: "Rags",
        tracks: [{ trackId: track(1) }, { trackId: track(1) }],
      }).success,
    ).toBe(false);
    expect(workInput.safeParse({ title: " " }).success).toBe(false);
  });

  it("finds a track's PDF pages from its printed ones and the work's offset", () => {
    expect(pdfPages({ pageFrom: 8, pageTo: 14 }, 2)).toEqual({ from: 10, to: 16 });
    expect(pdfPages({ pageFrom: 3, pageTo: null }, 0)).toEqual({ from: 3, to: 3 });
    expect(pdfPages({ pageFrom: 1, pageTo: 2 }, -3)).toEqual({ from: 1, to: 1 });
    expect(pdfPages({ pageFrom: null, pageTo: null }, 2)).toBeNull();
    expect(
      workInput.safeParse({
        title: "Rags",
        tracks: [{ trackId: track(1), pageFrom: 9, pageTo: 8 }],
      }).success,
    ).toBe(false);
  });

  it("takes a venue with its address as lines", () => {
    expect(venueInput.parse({ name: "St John's", address: "Smith Square\nLondon" })).toEqual({
      name: "St John's",
      address: "Smith Square\nLondon",
      notes: "",
    });
  });
});

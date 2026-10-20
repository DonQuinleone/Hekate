import { describe, expect, it } from "vitest";
import { alphabetical, venueInput, workInput, workLine } from "./repertoire.ts";

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
      tracks: [{ trackId: track(1), number: "I" }],
    });
    expect(
      workInput.safeParse({
        title: "Rags",
        tracks: [{ trackId: track(1) }, { trackId: track(1) }],
      }).success,
    ).toBe(false);
    expect(workInput.safeParse({ title: " " }).success).toBe(false);
  });

  it("takes a venue with its address as lines", () => {
    expect(venueInput.parse({ name: "St John's", address: "Smith Square\nLondon" })).toEqual({
      name: "St John's",
      address: "Smith Square\nLondon",
      notes: "",
    });
  });
});

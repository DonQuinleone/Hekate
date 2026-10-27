import { describe, expect, it } from "vitest";
import {
  compact,
  describeSearch,
  draftOf,
  fieldChips,
  fieldsOf,
  formatDuration,
  formatSize,
  fromKindChoice,
  kindChoice,
} from "./search";

describe("the kind menu", () => {
  it("reads a file kind as files narrowed further", () => {
    expect(kindChoice({ kind: "files", fileKind: "audio" })).toBe("files:audio");
    expect(fromKindChoice("files:audio")).toEqual({ kind: "files", fileKind: "audio" });
  });

  it("reads a plain kind, and nothing as everything", () => {
    expect(kindChoice({ kind: "reviews" })).toBe("reviews");
    expect(kindChoice({})).toBe("");
    expect(fromKindChoice("reviews")).toEqual({ kind: "reviews", fileKind: undefined });
    expect(fromKindChoice("")).toEqual({ kind: undefined, fileKind: undefined });
  });
});

describe("describeSearch", () => {
  const names = (id: string) => ({ p: "Joplin Rags", u: "Mira Solberg" })[id];

  it("names a search by its words and what narrows it", () => {
    expect(
      describeSearch(
        {
          q: "maple",
          kind: "files",
          fileKind: "audio",
          projectId: "p",
          personId: "u",
          since: "month",
        },
        names,
      ),
    ).toBe("“maple”, Audio, Joplin Rags, Mira Solberg, past month");
  });

  it("leaves out what it cannot name, and keeps within a name's length", () => {
    expect(describeSearch({ q: "", projectId: "gone" }, names)).toBe("");
    expect(describeSearch({ q: "x".repeat(80) }, names)).toHaveLength(60);
  });
});

describe("compact", () => {
  it("keeps the words and only the filters that are set", () => {
    expect(compact({ q: "", kind: undefined, since: "week" })).toEqual({ q: "", since: "week" });
  });
});

describe("advanced search by field", () => {
  it("says durations and sizes as people do", () => {
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(90)).toBe("1.5 min");
    expect(formatDuration(5400)).toBe("1 h 30 min");
    expect(formatSize(250_000_000)).toBe("250 MB");
    expect(formatSize(1_500_000_000)).toBe("1.5 GB");
  });

  it("shows each field set as a chip that clears it", () => {
    expect(
      fieldChips({
        durationMin: 120,
        durationMax: 300,
        sizeMax: 1_000_000_000,
        frameRate: 23.976,
        commentText: "flicker",
      }),
    ).toEqual([
      { keys: ["durationMin", "durationMax"], label: "2 min to 5 min" },
      { keys: ["sizeMax"], label: "Under 1 GB" },
      { keys: ["frameRate"], label: "23.976 fps" },
      { keys: ["commentText"], label: "Comments say “flicker”" },
    ]);
    expect(fieldChips({ durationMin: 60 })).toEqual([
      { keys: ["durationMin"], label: "Longer than 1 min" },
    ]);
    expect(fieldChips({})).toEqual([]);
  });

  it("reads the form in minutes and megabytes, leaving out what does not read", () => {
    expect(
      fieldsOf({
        durationMin: "1,5",
        durationMax: "",
        sizeMin: "abc",
        sizeMax: "200",
        frameRate: "25",
        commentText: "  too loud ",
      }),
    ).toEqual({
      durationMin: 90,
      durationMax: undefined,
      sizeMin: undefined,
      sizeMax: 200_000_000,
      frameRate: 25,
      commentText: "too loud",
    });
    // A range the wrong way round is turned round.
    const turned = fieldsOf({ ...draftOf({}), durationMin: "5", durationMax: "2" });
    expect([turned.durationMin, turned.durationMax]).toEqual([120, 300]);
  });

  it("fills the form from a search, and back", () => {
    const search = { durationMin: 90, sizeMax: 250_000_000, frameRate: 29.97 };
    expect(draftOf(search)).toEqual({
      durationMin: "1.5",
      durationMax: "",
      sizeMin: "",
      sizeMax: "250",
      frameRate: "29.97",
      commentText: "",
    });
    expect(fieldsOf(draftOf(search))).toMatchObject(search);
  });

  it("names a saved search by its fields too", () => {
    expect(describeSearch({ q: "titles", frameRate: 25 }, () => undefined)).toBe(
      "“titles”, 25 fps",
    );
  });
});

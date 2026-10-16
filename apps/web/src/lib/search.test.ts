import { describe, expect, it } from "vitest";
import { compact, describeSearch, fromKindChoice, kindChoice } from "./search";

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

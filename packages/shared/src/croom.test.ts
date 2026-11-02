import { describe, expect, it } from "vitest";
import {
  croomChangeWords,
  croomConflictWords,
  croomCountLine,
  croomImportQuery,
  croomKinds,
  croomKindWords,
  croomReportEmpty,
} from "./croom.ts";

describe("ControlRoom import", () => {
  it("names every kind, one and many", () => {
    for (const kind of croomKinds) expect(croomKindWords[kind]).toHaveLength(2);
    expect(croomCountLine({ kind: "work", create: 1, merge: 0 })).toBe("1 Work");
    expect(croomCountLine({ kind: "take", create: 20, merge: 6 })).toBe("26 Takes");
  });

  it("merges into what is there unless asked otherwise", () => {
    expect(croomImportQuery.parse({})).toEqual({ conflicts: "merge" });
    expect(croomImportQuery.parse({ conflicts: "new" })).toEqual({ conflicts: "new" });
    expect(croomImportQuery.safeParse({ conflicts: "replace" }).success).toBe(false);
  });

  it("says whether a report has anything in it", () => {
    const empty = {
      unknownEvents: [],
      unknownFields: [],
      ignored: [],
      problems: [],
      support: [],
    };
    expect(croomReportEmpty(empty)).toBe(true);
    expect(croomReportEmpty({ ...empty, problems: ["A take of no piece"] })).toBe(false);
  });

  it("names what an event changes in words, never by its id", () => {
    expect(croomChangeWords("set_take_rating")).toBe("A change to a take's rating");
    expect(croomChangeWords("upsert_stage_element")).toBe("A change to an element of a stage plan");
    expect(croomChangeWords("update_venue.address")).toBe("A change to a venue");
    expect(croomChangeWords("add_movement")).toBe("A change to a track");
    expect(croomChangeWords("frobnicate_widget")).toBe("A change Hekate does not know");
  });

  it("names what is already in the project as a sentence would", () => {
    expect(croomConflictWords({ kind: "work", name: "Rags" })).toBe("the work “Rags”");
    expect(croomConflictWords({ kind: "personnel", name: "Mira Solberg" })).toBe(
      "Mira Solberg on the personnel",
    );
  });
});

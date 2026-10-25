import { describe, expect, it } from "vitest";
import {
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
    const empty = { unknownEvents: [], unknownFields: [], ignored: [], problems: [] };
    expect(croomReportEmpty(empty)).toBe(true);
    expect(croomReportEmpty({ ...empty, problems: ["A take of no piece"] })).toBe(false);
  });
});

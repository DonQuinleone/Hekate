import { describe, expect, it } from "vitest";
import { schemaProblem } from "./startup.ts";

describe("the schema at start-up", () => {
  it("says nothing when the database matches the code", () => {
    expect(schemaProblem({ fresh: false, pending: [], ahead: false })).toBeNull();
  });

  it("names the migrations a database is behind by, and how to apply them", () => {
    const problem = schemaProblem({
      fresh: false,
      pending: [{ tag: "0107_work_scores" }, { tag: "0108_schedule" }],
      ahead: false,
    });
    expect(problem).toContain("2 migrations behind this version (0107_work_scores, 0108_schedule)");
    expect(problem).toContain("MIGRATE_ON_START=true");
    expect(schemaProblem({ fresh: true, pending: [{ tag: "0000_init" }], ahead: false })).toMatch(
      /^The database is empty\./,
    );
  });

  it("refuses a database a newer version has used", () => {
    expect(schemaProblem({ fresh: false, pending: [], ahead: true })).toContain("newer version");
  });
});

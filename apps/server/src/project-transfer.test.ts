import { schema, tenantTables } from "@hekate/db";
import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { transferTables } from "./project-transfer.ts";

describe("transferTables", () => {
  it("places every tenant table, once, so a new one must be placed before it ships", () => {
    const placed = [
      ...transferTables.moved,
      ...transferTables.dropped,
      ...transferTables.workspace,
    ];
    expect(new Set(placed).size).toBe(placed.length);
    expect([...placed].sort()).toEqual(tenantTables.map((t) => getTableName(t)).sort());
  });

  it("moves the review decisions with the project, and keeps the access log where it is", () => {
    expect(transferTables.moved).toContain(getTableName(schema.reviewDecisionLog));
    expect(transferTables.workspace).toContain(getTableName(schema.accessEvents));
  });
});

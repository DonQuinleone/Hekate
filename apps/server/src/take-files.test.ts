import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { isListedFile, listedFile } from "./take-files.ts";

describe("a project's listed files (decision 274)", () => {
  it("leave out a take's file, and take back one that is no longer a take", () => {
    expect(isListedFile({ takeId: null })).toBe(true);
    expect(isListedFile({ takeId: "0199f000-0000-7000-8000-000000000001" })).toBe(false);
  });

  it("read the same mark in the database", () => {
    expect(new PgDialect().sqlToQuery(listedFile.getSQL()).sql).toBe('"files"."take_id" is null');
  });
});

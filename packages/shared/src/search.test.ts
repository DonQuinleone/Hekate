import { describe, expect, it } from "vitest";
import { narrowed, savedSearchInput, searchRequest, sinceDate } from "./search.ts";

describe("search requests", () => {
  it("takes words and known filters only", () => {
    expect(searchRequest.parse({ q: " maple ", kind: "files", fileKind: "audio" })).toEqual({
      q: "maple",
      kind: "files",
      fileKind: "audio",
    });
    expect(searchRequest.safeParse({ q: "x", kind: "tasks" }).success).toBe(false);
    expect(searchRequest.safeParse({ q: "x", colour: "red" }).success).toBe(false);
  });

  it("says when filters narrow it, and how far back", () => {
    expect(narrowed({})).toBe(false);
    expect(narrowed({ since: "week" })).toBe(true);
    const now = Date.UTC(2026, 9, 15);
    expect(sinceDate("week", now).toISOString()).toBe("2026-10-08T00:00:00.000Z");
  });

  it("keeps a saved search's name short and its search valid", () => {
    expect(savedSearchInput.safeParse({ name: "Masters", search: { q: "master" } }).success).toBe(
      true,
    );
    expect(savedSearchInput.safeParse({ name: " ", search: { q: "x" } }).success).toBe(false);
  });
});

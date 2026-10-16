import { describe, expect, it } from "vitest";
import { fileTagsInput, markInput, tagInput } from "./tags.ts";

const id = "0192f1a0-0000-7000-8000-000000000001";

describe("tags", () => {
  it("tidies a tag's name and refuses an empty or long one", () => {
    expect(tagInput.parse({ name: "  Final   masters " })).toEqual({ name: "Final masters" });
    expect(tagInput.safeParse({ name: "   " }).success).toBe(false);
    expect(tagInput.safeParse({ name: "x".repeat(41) }).success).toBe(false);
  });

  it("takes each tag once on a file", () => {
    expect(fileTagsInput.safeParse({ tagIds: [id] }).success).toBe(true);
    expect(fileTagsInput.safeParse({ tagIds: [id, id] }).success).toBe(false);
  });
});

describe("marks", () => {
  it("needs something to mark, and marks only files as seen", () => {
    const file = { kind: "file", id };
    expect(markInput.safeParse({ items: [file], pinned: true }).success).toBe(true);
    expect(markInput.safeParse({ items: [file] }).success).toBe(false);
    expect(markInput.safeParse({ items: [], pinned: true }).success).toBe(false);
    expect(markInput.safeParse({ items: [file], viewed: false }).success).toBe(true);
    expect(markInput.safeParse({ items: [{ kind: "track", id }], viewed: true }).success).toBe(
      false,
    );
  });
});

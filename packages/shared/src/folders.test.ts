import { describe, expect, it } from "vitest";
import {
  canMoveFolder,
  createFolderInput,
  descendantsOf,
  folderPath,
  updateFileInput,
  updateFolderInput,
} from "./folders.ts";

const folders = [
  { id: "mixes", parentId: null, name: "Mixes" },
  { id: "stems", parentId: "mixes", name: "Stems" },
  { id: "drums", parentId: "stems", name: "Drums" },
  { id: "artwork", parentId: null, name: "Artwork" },
];

describe("folders", () => {
  it("finds everything inside a folder", () => {
    expect([...descendantsOf(folders, "mixes")].sort()).toEqual(["drums", "mixes", "stems"]);
    expect([...descendantsOf(folders, "artwork")]).toEqual(["artwork"]);
  });

  it("never moves a folder into itself or below itself", () => {
    expect(canMoveFolder(folders, "mixes", "drums")).toBe(false);
    expect(canMoveFolder(folders, "mixes", "mixes")).toBe(false);
    expect(canMoveFolder(folders, "stems", "artwork")).toBe(true);
    expect(canMoveFolder(folders, "drums", null)).toBe(true);
  });

  it("builds the path from the top", () => {
    expect(folderPath(folders, "drums").map((f) => f.name)).toEqual(["Mixes", "Stems", "Drums"]);
    expect(folderPath(folders, null)).toEqual([]);
    // A loop in bad data ends the walk rather than spinning.
    const looped = [
      { id: "a", parentId: "b", name: "A" },
      { id: "b", parentId: "a", name: "B" },
    ];
    expect(folderPath(looped, "a").map((f) => f.name)).toEqual(["B", "A"]);
  });

  it("checks names and changes", () => {
    expect(createFolderInput.parse({ name: "  Stems " }).name).toBe("Stems");
    expect(createFolderInput.safeParse({ name: "a/b" }).success).toBe(false);
    expect(createFolderInput.safeParse({ name: ".." }).success).toBe(false);
    expect(createFolderInput.safeParse({ name: " " }).success).toBe(false);
    expect(updateFolderInput.safeParse({}).success).toBe(false);
    expect(updateFolderInput.safeParse({ parentId: null }).success).toBe(true);
    expect(updateFileInput.safeParse({ folderId: null }).success).toBe(true);
    expect(updateFileInput.safeParse({ name: "Mix v4.wav" }).success).toBe(true);
  });
});

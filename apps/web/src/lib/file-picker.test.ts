import { describe, expect, it } from "vitest";
import {
  filesMatching,
  folderChoices,
  folderPathOf,
  kindsAmong,
  type PickableFile,
  pickableFiles,
} from "./file-picker";
import type { Folder, ProjectFile, Track } from "./queries";

const folders: Folder[] = [
  { id: "sessions", parentId: null, name: "Sessions" },
  { id: "day2", parentId: "sessions", name: "Day 2" },
  { id: "day1", parentId: "sessions", name: "Day 1" },
  { id: "venue", parentId: null, name: "Venue" },
];

const file = (id: string, name: string, folderId: string | null, kind = "audio"): ProjectFile =>
  ({ id, name, folderId, kind }) as ProjectFile;

const files = [
  file("mix", "Mix v1.wav", null),
  file("dry", "Dry v2.wav", null),
  file("plan", "Floor plan.pdf", "venue", "document"),
  file("room", "Room tone.wav", "day2"),
  file("notes", "Notes.pdf", null, "document"),
];

const tracks = [
  {
    id: "maple",
    name: "Maple Leaf Rag",
    folderId: "sessions",
    versions: [
      { number: 1, variants: [{ fileId: "mix", name: "Mix" }] },
      { number: 2, variants: [{ fileId: "dry", name: "Dry" }] },
    ],
  },
] as unknown as Track[];

describe("the file picker (#527)", () => {
  it("names a folder by its path", () => {
    expect(folderPathOf(folders, "day2")).toEqual(["Sessions", "Day 2"]);
    expect(folderPathOf(folders, null)).toEqual([]);
    expect(folderChoices(folders).map((f) => f.label)).toEqual([
      "Sessions",
      "Sessions / Day 1",
      "Sessions / Day 2",
      "Venue",
    ]);
  });

  it("lists the project's files but the one commented on, each saying where it sits", () => {
    const rows = pickableFiles(folders, tracks, files, "dry");
    expect(rows.map((r) => [r.file.id, r.where, r.folderId])).toEqual([
      ["mix", "Maple Leaf Rag · V1 · Mix", "sessions"],
      ["room", "Sessions / Day 2", "day2"],
      ["notes", "Top of the project", null],
      ["plan", "Venue", "venue"],
    ]);
    // A video project names its versions its own way.
    expect(
      pickableFiles(folders, tracks, files, null, (n) => `Cut ${n}`).find(
        (r) => r.file.id === "dry",
      )?.where,
    ).toBe("Maple Leaf Rag · Cut 2 · Dry");
  });

  it("narrows by words, by a folder and everything beneath it, and by kind", () => {
    const rows = pickableFiles(folders, tracks, files, null);
    const ids = (found: PickableFile[]) => found.map((r) => r.file.id).sort();
    const none = { query: "", folderId: null, kind: null };
    expect(ids(filesMatching(rows, folders, none))).toEqual(ids(rows));
    expect(ids(filesMatching(rows, folders, { ...none, query: "  PLAN " }))).toEqual(["plan"]);
    // Where it sits is searched too: a track's name finds its files.
    expect(ids(filesMatching(rows, folders, { ...none, query: "maple" }))).toEqual(["dry", "mix"]);
    expect(ids(filesMatching(rows, folders, { ...none, folderId: "sessions" }))).toEqual([
      "dry",
      "mix",
      "room",
    ]);
    expect(ids(filesMatching(rows, folders, { ...none, folderId: "day1" }))).toEqual([]);
    expect(ids(filesMatching(rows, folders, { ...none, kind: "document" }))).toEqual([
      "notes",
      "plan",
    ]);
    expect(kindsAmong(rows)).toEqual(["audio", "document"]);
  });
});

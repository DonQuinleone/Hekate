import { describe, expect, it } from "vitest";
import {
  columnsFor,
  folderCount,
  itemsIn,
  latestFile,
  versionSummary,
  versionsOf,
} from "./browser";
import type { Folder, ProjectFile, Track } from "./queries";

const folder = (id: string, parentId: string | null): Folder =>
  ({ id, parentId, name: id }) as Folder;
const file = (id: string, folderId: string | null): ProjectFile =>
  ({ id, folderId, name: id, kind: "audio" }) as ProjectFile;
const track = (id: string, folderId: string | null, versions: [number, string[]][]): Track =>
  ({
    id,
    folderId,
    name: id,
    versions: versions.map(([number, fileIds]) => ({
      id: `${id}-v${number}`,
      number,
      variations: fileIds.map((fileId, i) => ({ fileId, isPrimary: i === 0, name: fileId })),
    })),
  }) as unknown as Track;

const folders = [folder("Mixes", null), folder("Stems", "Mixes")];
const tracks = [
  track("Maple Leaf Rag", null, [
    [1, ["mix1"]],
    [2, ["dry2", "wet2"]],
  ]),
];
const files = [
  file("mix1", null),
  file("dry2", null),
  file("wet2", null),
  file("Score.pdf", null),
  file("bass.wav", "Stems"),
];

describe("itemsIn", () => {
  it("lists folders, then tracks, then the files that are not a track's", () => {
    expect(itemsIn(folders, tracks, files, null).map((i) => `${i.kind}:${i.id}`)).toEqual([
      "folder:Mixes",
      "track:Maple Leaf Rag",
      "file:Score.pdf",
    ]);
    expect(itemsIn(folders, tracks, files, "Stems").map((i) => i.id)).toEqual(["bass.wav"]);
  });

  it("counts what a folder shows", () => {
    expect(folderCount(folders, tracks, files, "Mixes")).toBe("1 item");
    expect(folderCount(folders, tracks, files, "Stems")).toBe("1 item");
    expect(folderCount([...folders, folder("Empty", null)], tracks, files, "Empty")).toBe("Empty");
  });
});

describe("tracks", () => {
  const [maple] = tracks;
  it("sums up versions and finds the latest primary file", () => {
    if (!maple) throw new Error("no track");
    expect(versionSummary(maple)).toBe("V2 of 2 · 2 variations");
    expect(versionSummary(track("New", null, []))).toBe("—");
    expect(latestFile(maple)).toBe("dry2");
    expect(versionsOf(maple).map((i) => i.id)).toEqual(["Maple Leaf Rag-v2", "Maple Leaf Rag-v1"]);
  });
});

describe("columnsFor", () => {
  it("opens a column for each folder or track chosen, and stops at a file", () => {
    const root = itemsIn(folders, tracks, files, null);
    const open = (i: (typeof root)[number]) =>
      i.kind === "folder"
        ? itemsIn(folders, tracks, files, i.id)
        : i.kind === "track"
          ? versionsOf(i.track)
          : null;
    const mixes = root[0];
    if (!mixes) throw new Error("no folder");
    const cols = columnsFor(root, [mixes], open);
    expect(cols.map((c) => c.items.map((i) => i.id))).toEqual([
      ["Mixes", "Maple Leaf Rag", "Score.pdf"],
      ["Stems"],
    ]);
    expect(cols[0]?.selected?.id).toBe("Mixes");
    const score = root[2];
    if (!score) throw new Error("no file");
    expect(columnsFor(root, [score], open)).toHaveLength(1);
  });
});

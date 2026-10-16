import type { Mark } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import type { Item } from "./browser";
import {
  type BrowserFilters,
  columnsFor,
  filterProject,
  filtersFrom,
  filtersTo,
  folderCount,
  freshPath,
  indexMarks,
  itemsIn,
  latestFile,
  noFilters,
  pinnedFirst,
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

describe("freshPath", () => {
  const open = (item: Item) =>
    item.kind === "folder" ? itemsIn(folders, tracks, files, item.folder.id) : null;
  const root = itemsIn(folders, tracks, files, null);

  it("follows renamed items and stops where a choice has gone", () => {
    const mixes = root.find((i) => i.id === "Mixes") as Item;
    const stems = (open(mixes) ?? []).find((i) => i.id === "Stems") as Item;
    const stale = [{ ...mixes, folder: { ...folders[0], name: "Old name" } } as Item, stems];
    const fresh = freshPath(root, stale, open);
    expect(fresh.map((i) => i.id)).toEqual(["Mixes", "Stems"]);
    expect(fresh[0]).toBe(mixes);
    expect(freshPath(root, [{ ...stems }, mixes], open)).toEqual([]);
    expect(freshPath(root, [mixes, { ...stems, id: "Gone" }], open).map((i) => i.id)).toEqual([
      "Mixes",
    ]);
  });
});

describe("marks and filters", () => {
  const me = "me";
  const mine = { ...file("Mine.wav", null), uploadedById: me, tagIds: ["t1"] };
  const theirs = { ...file("Theirs.wav", "Mixes"), uploadedById: "them", openComments: 2 };
  const v1 = { ...file("Maple v1.wav", null), uploadedById: me };
  const v2 = { ...file("Maple v2.wav", null), uploadedById: "them", tagIds: ["t2"] };
  const maple = track("Maple", "Mixes", [
    [1, ["Maple v1.wav"]],
    [2, ["Maple v2.wav"]],
  ]);
  const all = [mine, theirs, v1, v2];
  const run = (show: BrowserFilters["show"], tags: string[] = [], marks: Mark[] = []) =>
    filterProject(folders, [maple], all, { show, tags }, me, indexMarks(marks)).map((i) => i.id);

  it("reads and writes filters in the address, dropping what it does not know", () => {
    const id = "0192f1a0-0000-7000-8000-000000000001";
    const f = filtersFrom({ show: "unviewed,fly,comments", tags: `${id},nope,${id}` });
    expect(f).toEqual({ show: ["comments", "unviewed"], tags: [id] });
    expect(filtersTo(f)).toEqual({ show: "comments,unviewed", tags: id });
    expect(filtersTo(noFilters)).toEqual({});
  });

  it("puts pinned things first", () => {
    const items = itemsIn(folders, [], [mine, theirs], null);
    const marks = indexMarks([
      { kind: "file", id: "Mine.wav", pinned: true, favourite: false, viewed: false },
    ]);
    expect(pinnedFirst(items, marks).map((i) => i.id)).toEqual(["Mine.wav", "Mixes"]);
  });

  it("finds what is unseen, with comments, mine, a favourite or tagged, anywhere", () => {
    // Nothing seen yet: what others uploaded, a track by its latest version.
    expect(run(["unviewed"])).toEqual(["Maple", "Theirs.wav"]);
    const seen: Mark[] = [
      { kind: "file", id: "Maple v2.wav", pinned: false, favourite: false, viewed: true },
    ];
    expect(run(["unviewed"], [], seen)).toEqual(["Theirs.wav"]);
    expect(run(["comments"])).toEqual(["Theirs.wav"]);
    // A track is someone's if they uploaded any of it.
    expect(run(["mine"])).toEqual(["Maple", "Mine.wav"]);
    expect(run(["mine", "unviewed"])).toEqual(["Maple"]);
    expect(run([], ["t2"])).toEqual(["Maple"]);
    expect(run([], ["t1", "t2"])).toEqual(["Maple", "Mine.wav"]);
    const favourite: Mark[] = [
      { kind: "folder", id: "Stems", pinned: false, favourite: true, viewed: false },
      { kind: "file", id: "Mine.wav", pinned: true, favourite: true, viewed: false },
    ];
    expect(run(["favourites"], [], favourite)).toEqual(["Mine.wav", "Stems"]);
  });
});

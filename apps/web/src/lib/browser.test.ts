import type { Mark } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import type { Item } from "./browser";
import {
  allHave,
  type BrowserFilters,
  bulkTags,
  columnsFor,
  filterProject,
  filtersFrom,
  filtersTo,
  fitColumns,
  folderCount,
  freshPath,
  gridTemplate,
  indexMarks,
  itemsIn,
  latestFile,
  listMinWidth,
  movableTo,
  moveColumn,
  noFilters,
  pinnedFirst,
  processingStage,
  rangeBetween,
  resizeColumn,
  toggleColumn,
  trackNext,
  variationNameFor,
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

  it("shows a version chain by its latest file (#149)", () => {
    const chained = [
      file("Booklet proof 1.pdf", null),
      { ...file("Booklet proof 2.pdf", null), previousFileId: "Booklet proof 1.pdf" },
      { ...file("Booklet proof 3.pdf", null), previousFileId: "Booklet proof 2.pdf" },
      file("Cover.png", null),
    ];
    expect(itemsIn([], [], chained, null).map((i) => i.id)).toEqual([
      "Booklet proof 3.pdf",
      "Cover.png",
    ]);
    const mine = chained.map((f) => ({ ...f, uploadedById: "me" }));
    const show = { ...noFilters, show: ["mine" as const] };
    expect(filterProject([], [], mine, show, "me", indexMarks([])).map((i) => i.id)).toEqual([
      "Booklet proof 3.pdf",
      "Cover.png",
    ]);
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

describe("columns", () => {
  const cols = [
    { id: "status", width: 150 },
    { id: "updated", width: 100 },
  ] as const;

  it("lays out the grid from the columns shown", () => {
    expect(gridTemplate([...cols])).toBe("20px minmax(0,1fr) 150px 100px 88px");
    // 20 + 240 + 250 + 88, four gaps of 12 and 24 of padding.
    expect(listMinWidth([...cols])).toBe(670);
    // What does not fit is left off from the end, never the page made wider.
    expect(fitColumns([...cols], 670)).toEqual(cols);
    expect(fitColumns([...cols], 600).map((c) => c.id)).toEqual(["status"]);
    expect(fitColumns([...cols], 100)).toEqual([]);
  });

  it("adds a column in its usual place, and takes it away", () => {
    expect(toggleColumn([...cols], "versions").map((c) => c.id)).toEqual([
      "status",
      "versions",
      "updated",
    ]);
    expect(toggleColumn([...cols], "tags").map((c) => c.id)).toEqual(["status", "updated", "tags"]);
    expect(toggleColumn([...cols], "status").map((c) => c.id)).toEqual(["updated"]);
  });

  it("moves within bounds and keeps widths readable", () => {
    expect(moveColumn([...cols], "updated", -1).map((c) => c.id)).toEqual(["updated", "status"]);
    expect(moveColumn([...cols], "updated", 1)).toEqual(cols);
    expect(resizeColumn([...cols], "status", 10)[0]?.width).toBe(64);
    expect(resizeColumn([...cols], "status", 9000)[0]?.width).toBe(480);
    expect(resizeColumn([...cols], "status", 200.4)[0]?.width).toBe(200);
  });
});

describe("selection", () => {
  const order = ["a", "b", "c", "d"];

  it("selects a range either way round", () => {
    expect(rangeBetween(order, "b", "d")).toEqual(["b", "c", "d"]);
    expect(rangeBetween(order, "d", "b")).toEqual(["b", "c", "d"]);
    expect(rangeBetween(order, null, "c")).toEqual(["c"]);
    expect(rangeBetween(order, "gone", "c")).toEqual(["c"]);
    expect(rangeBetween(order, "a", "gone")).toEqual([]);
  });

  it("says what to do to everything at once", () => {
    expect(allHave(["a", "b"], new Set(["a", "b", "c"]))).toBe(true);
    expect(allHave(["a", "d"], new Set(["a"]))).toBe(false);
    expect(allHave([], new Set(["a"]))).toBe(false);
  });

  it("keeps folders out of themselves", () => {
    const mixes = { kind: "folder", id: "Mixes", folder: folders[0] } as Item;
    expect(movableTo(folders, [mixes]).map((f) => f.id)).toEqual([]);
    const all = [...folders, folder("Elsewhere", null)];
    expect(movableTo(all, [mixes]).map((f) => f.id)).toEqual(["Elsewhere"]);
  });

  it("tags many files, keeping what each had", () => {
    // Masters was on both and stays chosen; Draft was on both and is taken off; Print is added.
    expect(
      bulkTags(["masters", "draft", "own"], ["masters", "draft"], ["masters", "print"]),
    ).toEqual(["masters", "own", "print"]);
  });
});

describe("processingStage", () => {
  const f = (over: Partial<ProjectFile>) =>
    ({
      ...file("x", null),
      mediaInfo: { duration: 1 },
      streamStatus: "ready",
      analysisStatus: "ready",
      ...over,
    }) as ProjectFile;

  it("names each stage a file goes through", () => {
    expect(processingStage(f({ mediaInfo: null, streamStatus: "pending" }))).toBe("Measuring");
    expect(processingStage(f({ streamStatus: "pending" }))).toBe("Preparing playback");
    expect(processingStage(f({ analysisStatus: "pending" }))).toBe("Analysing");
    expect(processingStage(f({ kind: "document", streamStatus: "pending" }))).toBe("Drawing pages");
    expect(processingStage(f({ analysisStatus: "failed" }))).toBe("Failed");
    expect(processingStage(f({}))).toBeNull();
  });
});

describe("variationNameFor", () => {
  it("names a variation from its file, without the track's name", () => {
    expect(variationNameFor("Maple Leaf Rag - Dry v3.wav", "Maple Leaf Rag")).toBe("Dry v3");
    expect(variationNameFor("Stems.zip", "Maple Leaf Rag")).toBe("Stems");
    expect(variationNameFor("Maple Leaf Rag.wav", "Maple Leaf Rag")).toBe("Maple Leaf Rag");
  });
});

describe("a track's next step", () => {
  const all = { upload: true, organise: true, download: true, requestReviews: true };
  const none = { upload: false, organise: false, download: false, requestReviews: false };
  const at = (state: Track["state"], streamStatus = "ready") => {
    const t = track("Maple Leaf Rag", null, [[1, ["mix1"]]]);
    for (const v of t.versions[0]?.variations ?? []) Object.assign(v, { streamStatus });
    return { ...t, state };
  };

  it("is its first version, for those who upload", () => {
    const empty = { ...track("Joplin Rags", null, []), state: "no_version" as const };
    expect(trackNext(empty, all)).toBe("add");
    expect(trackNext(empty, { ...all, upload: false })).toBeNull();
  });

  it("is a new file where its latest could not be read, for those who organise", () => {
    expect(trackNext(at("not_reviewed", "failed"), all)).toBe("replace");
    // Without that, what follows still applies.
    expect(trackNext(at("not_reviewed", "failed"), { ...all, organise: false })).toBe("review");
  });

  it("is delivering it once approved, for those who download", () => {
    expect(trackNext(at("approved"), all)).toBe("deliver");
    expect(trackNext(at("approved"), { ...all, download: false })).toBe("review");
  });

  it("is a review, unless one is under way or they may not ask", () => {
    expect(trackNext(at("not_reviewed"), all)).toBe("review");
    expect(trackNext(at("changes_requested"), all)).toBe("review");
    expect(trackNext(at("in_review"), all)).toBeNull();
    expect(trackNext(at("not_reviewed"), none)).toBeNull();
  });
});

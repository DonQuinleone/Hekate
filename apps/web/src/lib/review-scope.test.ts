import { describe, expect, it } from "vitest";
import type { Item } from "./browser";
import { coveredKeys, folderTick, keysBeneath, toggleScope, WORKSPACE_KEY } from "./review-scope";

// Mixes holds Stems (holding one file) and a track; Artwork holds a file.
const folder = (id: string, parentId: string | null): Item => ({
  kind: "folder",
  id,
  folder: { id, parentId, name: id } as Item extends { folder: infer F } ? F : never,
});
const file = (id: string): Item => ({ kind: "file", id, file: { id } as never });
const track = (id: string): Item => ({ kind: "track", id, track: { id } as never });
const tree: Record<string, Item[]> = {
  root: [folder("mixes", null), folder("artwork", null)],
  mixes: [folder("stems", "mixes"), track("rag")],
  stems: [file("piano")],
  artwork: [file("cover")],
};
const children = (folderId: string | null) => tree[folderId ?? "root"] ?? [];

describe("what a folder covers in a new review (#501)", () => {
  it("lists everything beneath a folder, however deep", () => {
    expect(keysBeneath(children, "mixes")).toEqual(["folder:stems", "file:piano", "track:rag"]);
    expect(keysBeneath(children, "artwork")).toEqual(["file:cover"]);
  });

  it("covers what is beneath chosen folders, and everything with the workspace", () => {
    expect([...(coveredKeys(new Set(["folder:stems"]), children) as Set<string>)]).toEqual([
      "file:piano",
    ]);
    expect(coveredKeys(new Set([WORKSPACE_KEY]), children)).toBe("all");
  });

  it("reads a folder's box as on, mixed or off", () => {
    const beneath = keysBeneath(children, "mixes");
    expect(folderTick("folder:mixes", new Set(["folder:mixes"]), new Set(), beneath)).toBe("on");
    expect(folderTick("folder:mixes", new Set(["file:piano"]), new Set(), beneath)).toBe("mixed");
    expect(folderTick("folder:mixes", new Set(["file:cover"]), new Set(), beneath)).toBe("off");
    expect(folderTick("folder:stems", new Set(), new Set(["folder:stems"]), beneath)).toBe("on");
    expect(folderTick("folder:mixes", new Set(), "all", beneath)).toBe("on");
  });

  it("lets a folder take over what was ticked beneath it, and the workspace everything", () => {
    const one = toggleScope(new Map([["file:piano", 1]]), "folder:mixes", 1, children);
    expect([...one.keys()]).toEqual(["folder:mixes"]);
    const all = toggleScope(one, WORKSPACE_KEY, 1, children);
    expect([...all.keys()]).toEqual([WORKSPACE_KEY]);
    // Something named beside it stands on its own again.
    const again = toggleScope(all, "file:cover", 1, children);
    expect([...again.keys()]).toEqual(["file:cover"]);
    expect(toggleScope(again, "file:cover", 1, children).size).toBe(0);
  });
});

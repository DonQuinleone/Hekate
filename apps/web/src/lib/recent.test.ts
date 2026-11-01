import { describe, expect, it } from "vitest";
import { type Opened, openedAt, recentShown, switcherOrder, withOpened } from "./recent";

const a = "0190a1b2-0000-7000-8000-00000000000a";
const b = "0190a1b2-0000-7000-8000-00000000000b";
const c = "0190a1b2-0000-7000-8000-00000000000c";

describe("Recent", () => {
  it("knows which pages it remembers", () => {
    expect(openedAt(`/files/${a}`)).toEqual({ kind: "file", id: a });
    expect(openedAt(`/tracks/${a}`)).toEqual({ kind: "track", id: a });
    expect(openedAt(`/reviews/${a}`)).toEqual({ kind: "review", id: a });
    expect(openedAt(`/projects/${a}/files`)).toEqual({ kind: "project", id: a });
    expect(openedAt(`/files/${a}/qa-report`)).toBeNull();
    expect(openedAt("/reviews/new")).toBeNull();
    expect(openedAt("/inbox")).toBeNull();
  });

  it("keeps each thing once, newest first", () => {
    let list: Opened[] = [];
    list = withOpened(list, { kind: "file", id: a, at: 1 });
    list = withOpened(list, { kind: "review", id: b, at: 2 });
    list = withOpened(list, { kind: "file", id: a, at: 3 });
    expect(list.map((o) => [o.kind, o.id])).toEqual([
      ["file", a],
      ["review", b],
    ]);
  });

  it("shows the last five things, never a project, nor the page open now", () => {
    const list: Opened[] = [
      { kind: "project", id: c, at: 9 },
      { kind: "file", id: a, at: 8 },
      { kind: "review", id: b, at: 7 },
      ...[6, 5, 4, 3, 2].map((at) => ({ kind: "track" as const, id: `${c}${at}`, at })),
    ];
    const shown = recentShown(list, { kind: "file", id: a });
    expect(shown).toHaveLength(5);
    expect(shown[0]).toMatchObject({ kind: "review", id: b });
    expect(shown.some((o) => o.kind === "project")).toBe(false);
  });

  it("orders the switcher: the open project, the last opened, then by name", () => {
    const projects = [
      { id: a, name: "Booklet" },
      { id: b, name: "Opening titles" },
      { id: c, name: "Joplin Rags" },
    ];
    const list: Opened[] = [{ kind: "project", id: b, at: 5 }];
    expect(switcherOrder(projects, c, list).map((p) => p.name)).toEqual([
      "Joplin Rags",
      "Opening titles",
      "Booklet",
    ]);
    // The same order every time, whatever order the projects arrive in.
    expect(switcherOrder([...projects].reverse(), c, list).map((p) => p.name)).toEqual([
      "Joplin Rags",
      "Opening titles",
      "Booklet",
    ]);
  });
});

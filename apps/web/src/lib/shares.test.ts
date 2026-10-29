import { describe, expect, it } from "vitest";
import type { Folder, ProjectFile, Track } from "./queries";
import {
  endOfDay,
  guestFromEmail,
  linkEnd,
  linkLifeWords,
  reviewerFromKey,
  shareLine,
  shareNote,
  shareRequest,
  targetItems,
  targetPath,
} from "./shares";

describe("a share's people (#138)", () => {
  const ago = () => "2 hours ago";
  it("says whether each opened it, and how much to those who run it", () => {
    expect(shareLine({ viewedAt: null, usage: null }, ago)).toBe("Not opened");
    expect(shareLine({ viewedAt: "2026-10-17T10:00:00Z", usage: null }, ago)).toBe(
      "Opened 2 hours ago",
    );
    expect(
      shareLine({ viewedAt: "2026-10-17T10:00:00Z", usage: { plays: 1, downloads: 0 } }, ago),
    ).toBe("Opened 2 hours ago · 1 play");
    expect(shareLine({ viewedAt: null, usage: { plays: 3, downloads: 2 } }, ago)).toBe(
      "Not opened · 3 plays · 2 downloads",
    );
  });

  it("closes at the end of the chosen day", () => {
    const end = new Date(endOfDay("2026-10-31"));
    expect([end.getFullYear(), end.getMonth(), end.getDate(), end.getHours()]).toEqual([
      2026, 9, 31, 23,
    ]);
  });

  it("tells the person it is shared with how often, until when, and what to keep", () => {
    const date = () => "31 October 2026";
    const at = "2026-10-31T22:59:59Z";
    expect(shareNote({ expiresAt: at, maxPlays: null, download: "none" }, date)).toBe(
      "Listen as often as you like until 31 October 2026.",
    );
    // A limit leads, never beside "as often as you like".
    expect(shareNote({ expiresAt: at, maxPlays: 1, download: "proxy" }, date)).toBe(
      "Up to 1 play of each file until 31 October 2026. You may download the proxy; each copy is marked for you.",
    );
    expect(shareNote({ expiresAt: null, maxPlays: 3, download: "none" }, date)).toBe(
      "Up to 3 plays of each file until it is withdrawn.",
    );
  });
});

describe("sharing one item (#489)", () => {
  const now = new Date("2026-10-20T10:00:00Z");

  it("names the link's life in words, and ends it from now", () => {
    expect(linkLifeWords(7)).toBe("Link works for 7 days");
    expect(linkLifeWords(null)).toBe("Link works until withdrawn");
    expect(linkEnd(7, now)).toBe("2026-10-27T10:00:00.000Z");
    expect(linkEnd(null, now)).toBeNull();
  });

  it("names a guest from their address", () => {
    expect(guestFromEmail(" Anna.Berg@Example.com ")).toEqual({
      name: "Anna Berg",
      email: "anna.berg@example.com",
    });
    expect(guestFromEmail("jb_2@example.com").name).toBe("Jb");
    expect(guestFromEmail("42@example.com").name).toBe("42@example.com");
  });

  it("turns a key into what the reviews API asks for", () => {
    const known = new Map([["mira@example.com", { name: "Mira", email: "mira@example.com" }]]);
    expect(reviewerFromKey("member:u1", known)).toBe("u1");
    expect(reviewerFromKey("group:g1", known)).toEqual({ groupId: "g1" });
    expect(reviewerFromKey("guest:mira@example.com", known)).toEqual({
      name: "Mira",
      email: "mira@example.com",
    });
    expect(reviewerFromKey("guest:new.one@example.com", known)).toEqual({
      name: "New One",
      email: "new.one@example.com",
    });
  });

  it("viewing is a share; commenting and downloading are a feedback review", () => {
    const base = { life: 7 as const, items: [{ fileId: "f1" }], reviewers: ["u1"], now };
    expect(shareRequest({ ...base, access: "view" })).toEqual({
      kind: "share",
      items: [{ fileId: "f1" }],
      reviewers: ["u1"],
      permissions: { download: "none", expiresAt: "2026-10-27T10:00:00.000Z" },
    });
    expect(shareRequest({ ...base, access: "comment" }).kind).toBe("feedback");
    expect(shareRequest({ ...base, access: "comment" }).permissions).toMatchObject({
      comment: true,
      download: "none",
    });
    expect(shareRequest({ ...base, access: "download", life: null }).permissions).toEqual({
      comment: true,
      download: "original",
      expiresAt: null,
    });
  });

  it("shares a folder as everything in it, at every depth, leaving out tracks without a version", () => {
    const folders: Folder[] = [
      { id: "top", parentId: null, name: "Top" },
      { id: "inner", parentId: "top", name: "Inner" },
      { id: "other", parentId: null, name: "Other" },
    ];
    const track = (id: string, folderId: string, versions: number): Track =>
      ({
        id,
        folderId,
        name: id,
        versions: Array.from({ length: versions }, (_, i) => ({
          id: `${id}-v${i + 1}`,
          number: i + 1,
          variants: [],
        })),
      }) as unknown as Track;
    const file = (id: string, folderId: string): ProjectFile =>
      ({ id, folderId, name: id, kind: "audio" }) as unknown as ProjectFile;
    const within = {
      folders,
      tracks: [track("t1", "top", 2), track("t2", "inner", 0), track("t3", "other", 1)],
      files: [file("f1", "inner"), file("f2", "other")],
    };
    // Folders first, as the browser lists them: the inner file before the track beside it.
    expect(targetItems({ kind: "folder", id: "top", name: "Top" }, within)).toEqual([
      { fileId: "f1" },
      { trackId: "t1" },
    ]);
    expect(targetItems({ kind: "track", id: "t1", name: "t1" }, within)).toEqual([
      { trackId: "t1" },
    ]);
    expect(
      targetItems({ kind: "version", id: "t1-v2", trackId: "t1", name: "t1 V2" }, within),
    ).toEqual([{ trackId: "t1", versionId: "t1-v2" }]);
  });

  it("offers the item's own address in the app", () => {
    expect(targetPath({ kind: "file", id: "f1", name: "" }, "p1")).toBe("/files/f1");
    expect(targetPath({ kind: "track", id: "t1", name: "" }, "p1")).toBe("/tracks/t1");
    expect(targetPath({ kind: "version", id: "v1", trackId: "t1", name: "" }, "p1")).toBe(
      "/tracks/t1?view=versions",
    );
    expect(targetPath({ kind: "folder", id: "d1", name: "" }, "p1")).toBe(
      "/projects/p1/files?folder=d1",
    );
  });
});

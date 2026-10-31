import { describe, expect, it } from "vitest";
import {
  defaultReviewerPermissions as all,
  applyPermissions,
  invitedGrant,
  linkedFileGrant,
  mergeGrants,
  readGrant,
  seesComment,
  standingGrant,
  visibleComments,
  withinWindow,
} from "./reviewer-permissions.ts";

describe("reviewer permissions", () => {
  it("changes some permissions and checks the whole", () => {
    const changed = applyPermissions(all, { comment: false, tools: ["meters", "meters"] });
    expect(changed.success && changed.data).toMatchObject({ comment: false, tools: ["meters"] });
    expect(
      applyPermissions(all, {
        startsAt: "2026-10-20T09:00:00Z",
        expiresAt: "2026-10-19T09:00:00Z",
      }).success,
    ).toBe(false);
  });

  it("opens and closes with the access window", () => {
    const window = { startsAt: "2026-10-20T09:00:00Z", expiresAt: "2026-10-21T09:00:00Z" };
    expect(withinWindow(window, new Date("2026-10-20T08:59:59Z"))).toBe(false);
    expect(withinWindow(window, new Date("2026-10-20T12:00:00Z"))).toBe(true);
    expect(withinWindow(window, new Date("2026-10-21T09:00:00Z"))).toBe(false);
    expect(withinWindow(all, new Date())).toBe(true);
  });

  it("gives what any of several reviews allows", () => {
    expect(mergeGrants([])).toBeNull();
    expect(
      mergeGrants([
        { ...all, comment: false, comments: "own", tools: ["meters"], download: "proxy" },
        { ...all, comment: true, comments: "own_and_replies", tools: ["loops"] },
      ]),
    ).toEqual({
      comment: true,
      comments: "own_and_replies",
      tools: ["meters", "loops"],
      download: "proxy",
      maxPlays: null,
    });
    // Plays: the most any review allows, and without limit if any review sets none.
    expect(
      mergeGrants([
        { ...all, maxPlays: 2 },
        { ...all, maxPlays: 5 },
      ])?.maxPlays,
    ).toBe(5);
    expect(
      mergeGrants([
        { ...all, maxPlays: 2 },
        { ...all, maxPlays: null },
      ])?.maxPlays,
    ).toBeNull();
    // A grant made before downloads existed allows none.
    const { download: _, ...older } = all;
    expect(mergeGrants([older])?.download).toBe("none");
  });

  it("shows a reviewer only the comments their scope allows", () => {
    const comments = [
      { id: "a", parentId: null, author: "me" },
      { id: "a1", parentId: "a", author: "them" },
      { id: "b", parentId: null, author: "them" },
      { id: "b1", parentId: "b", author: "me" },
      { id: "c", parentId: null, author: null },
    ];
    const ids = (scope: "all" | "own" | "own_and_replies") =>
      visibleComments(comments, scope, "me").map((c) => c.id);
    expect(ids("all")).toEqual(["a", "a1", "b", "b1", "c"]);
    expect(ids("own_and_replies")).toEqual(["a", "a1", "b1"]);
    expect(ids("own")).toEqual(["a", "b1"]);
  });

  it("decides one comment as the list does (#527)", () => {
    const comments = [
      { id: "a", parentId: null, author: "me" },
      { id: "a1", parentId: "a", author: "them" },
      { id: "b", parentId: null, author: "them" },
      { id: "b1", parentId: "b", author: "me" },
      { id: "b2", parentId: "b", author: "them" },
      { id: "c", parentId: null, author: null },
    ];
    const threadAuthor = (c: { id: string; parentId: string | null; author: string | null }) =>
      comments.find((t) => t.id === (c.parentId ?? c.id))?.author ?? null;
    for (const scope of ["all", "own_and_replies", "own"] as const)
      expect(
        comments.filter((c) => seesComment(scope, "me", c, threadAuthor(c))).map((c) => c.id),
      ).toEqual(visibleComments(comments, scope, "me").map((c) => c.id));
  });

  it("lets a guest look at a linked file as their review allows, and do nothing else (#527)", () => {
    const grant = linkedFileGrant({
      ...all,
      invite: true,
      download: "proxy",
      maxPlays: 3,
      items: ["01890000-0000-7000-8000-000000000000"],
      tools: ["loops"],
    });
    expect(grant).toMatchObject({
      comment: false,
      decide: false,
      invite: false,
      comments: "own",
      items: null,
      // What the review gives them to look and download with stays theirs.
      download: "proxy",
      maxPlays: 3,
      tools: ["loops"],
    });
    expect(linkedFileGrant(all).download).toBe("none");
  });

  it("gives those a reviewer invites what the reviewer has, but no decision or inviting", () => {
    const inviter = { ...all, invite: true, download: "proxy" as const };
    expect(invitedGrant(inviter)).toEqual({
      ...inviter,
      decide: false,
      invite: false,
    });
    // A grant stored before inviting existed lets no one invite.
    const { invite: _, ...stored } = all;
    expect(readGrant(stored).invite).toBe(false);
  });

  it("keeps what a project says for one person to what holds across its reviews (#55)", () => {
    expect(standingGrant.safeParse({ download: "proxy", tools: ["score"] }).success).toBe(true);
    // Nothing to set, and nothing that belongs to one review: its dates and its items.
    expect(standingGrant.safeParse({}).success).toBe(false);
    expect(standingGrant.safeParse({ expiresAt: "2030-01-01T00:00:00Z" }).success).toBe(false);
    expect(standingGrant.safeParse({ items: null }).success).toBe(false);
  });
});

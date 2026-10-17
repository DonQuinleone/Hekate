import { describe, expect, it } from "vitest";
import {
  defaultReviewerPermissions as all,
  applyPermissions,
  invitedGrant,
  mergeGrants,
  readGrant,
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
});

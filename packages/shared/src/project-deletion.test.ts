import { describe, expect, it } from "vitest";
import { confirmableAt, deletionProblem, SOLE_OWNER_WAIT_MS } from "./project-deletion.ts";

const asked = new Date("2026-10-17T10:00:00Z");
const request = { requestedBy: "mira", requestedAt: asked };
const later = (ms: number) => new Date(asked.getTime() + ms);

describe("deleting a project", () => {
  it("takes a second owner", () => {
    expect(deletionProblem(request, { userId: "tomas", role: "owner" }, 2, asked)).toBeNull();
    expect(deletionProblem(request, { userId: "mira", role: "owner" }, 2, later(1e10))).toMatch(
      /Another owner/,
    );
    expect(deletionProblem(request, { userId: "ines", role: "admin" }, 2, asked)).toMatch(
      /Only a workspace owner/,
    );
  });

  it("lets a sole owner confirm their own request a day after asking", () => {
    const sole = { userId: "mira", role: "owner" } as const;
    expect(deletionProblem(request, sole, 1, later(SOLE_OWNER_WAIT_MS - 1))).toMatch(/a day/);
    expect(deletionProblem(request, sole, 1, later(SOLE_OWNER_WAIT_MS))).toBeNull();
    expect(confirmableAt(request, sole, 1)).toEqual(later(SOLE_OWNER_WAIT_MS));
    expect(confirmableAt(request, { userId: "tomas", role: "owner" }, 2)).toBeNull();
  });

  it("confirms nothing no one asked for", () => {
    expect(
      deletionProblem(
        { requestedBy: null, requestedAt: null },
        { userId: "tomas", role: "owner" },
        2,
        asked,
      ),
    ).toMatch(/No one has asked/);
  });
});

describe("deleting a workspace (#186)", () => {
  it("takes the same two owners, in its own words", () => {
    const none = { requestedBy: null, requestedAt: null };
    expect(deletionProblem(none, { userId: "tomas", role: "owner" }, 2, asked, "workspace")).toBe(
      "No one has asked to delete this workspace",
    );
    expect(
      deletionProblem(request, { userId: "tomas", role: "owner" }, 2, asked, "workspace"),
    ).toBeNull();
  });
});

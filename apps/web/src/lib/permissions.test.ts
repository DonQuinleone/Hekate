import { defaultReviewerPermissions as all, reviewerTools } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { setLocale } from "./locale";
import {
  accessNote,
  fromLocalInput,
  permissionSummary,
  standingChange,
  toLocalInput,
} from "./permissions";

// Dates as a British member reads them, whatever the machine running the tests.
setLocale("en-GB");

describe("reviewer permissions in words", () => {
  it("names only what departs from the defaults", () => {
    expect(permissionSummary(all, "approval")).toEqual([]);
    expect(
      permissionSummary(
        { ...all, comments: "own", decide: false, tools: ["loops"], comment: false },
        "approval",
      ),
    ).toEqual([
      "Sees only own comments",
      "Cannot comment",
      "No decision",
      "No spectrogram, meters, compare, QA, score",
    ]);
    // A member's comments and tools follow their role; only the review's own rules show.
    expect(
      permissionSummary({ ...all, comments: "own", tools: [], decide: false }, "approval", false),
    ).toEqual(["No decision"]);
    // Feedback reviews ask for no decision, so saying so would be noise.
    expect(permissionSummary({ ...all, decide: false }, "feedback")).toEqual([]);
    expect(permissionSummary({ ...all, expiresAt: "2026-11-03T17:00:00Z" }, "feedback")[0]).toMatch(
      /^Until 2026-11-03/,
    );
  });

  it("tells a guest when a review opens or closes to them", () => {
    const now = new Date("2026-10-20T12:00:00Z");
    expect(accessNote({ opensAt: null, closesAt: null, accessOpen: true }, now)).toBeNull();
    expect(
      accessNote({ opensAt: "2026-10-21T09:00:00Z", closesAt: null, accessOpen: false }, now),
    ).toMatch(/^opens 2026-10-21/);
    expect(
      accessNote({ opensAt: null, closesAt: "2026-10-19T09:00:00Z", accessOpen: false }, now),
    ).toMatch(/^closed 2026-10-19/);
  });

  it("round-trips a moment through a local date and time field", () => {
    const iso = "2026-10-21T09:30:00.000Z";
    expect(fromLocalInput(toLocalInput(iso))).toBe(iso);
    expect(toLocalInput(null)).toBe("");
    expect(fromLocalInput("")).toBeNull();
  });
});

describe("what a project keeps for one person (#55)", () => {
  const defaults = { ...all, download: "none" as const };

  it("keeps only where they depart from the workspace's defaults", () => {
    expect(
      standingChange(defaults, {
        comment: true,
        decide: false,
        comments: "all",
        tools: [...reviewerTools].reverse(),
        download: "proxy",
        maxPlays: null,
      }),
    ).toEqual({ decide: false, download: "proxy" });
    expect(standingChange(defaults, { tools: ["score", "loops"] })).toEqual({
      tools: ["loops", "score"],
    });
  });

  it("keeps nothing where nothing departs", () => {
    expect(standingChange(defaults, { comment: true, decide: true, history: false })).toBeNull();
  });
});

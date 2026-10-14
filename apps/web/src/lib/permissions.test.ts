import { defaultReviewerPermissions as all } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { accessNote, fromLocalInput, permissionSummary, toLocalInput } from "./permissions";

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
      "No spectrogram, meters",
    ]);
    // Feedback reviews ask for no decision, so saying so would be noise.
    expect(permissionSummary({ ...all, decide: false }, "feedback")).toEqual([]);
    expect(permissionSummary({ ...all, expiresAt: "2026-11-03T17:00:00Z" }, "feedback")[0]).toMatch(
      /^Until 3 Nov/,
    );
  });

  it("tells a guest when a review opens or closes to them", () => {
    const now = new Date("2026-10-20T12:00:00Z");
    expect(accessNote({ opensAt: null, closesAt: null, accessOpen: true }, now)).toBeNull();
    expect(
      accessNote({ opensAt: "2026-10-21T09:00:00Z", closesAt: null, accessOpen: false }, now),
    ).toMatch(/^opens 21 Oct/);
    expect(
      accessNote({ opensAt: null, closesAt: "2026-10-19T09:00:00Z", accessOpen: false }, now),
    ).toMatch(/^closed 19 Oct/);
  });

  it("round-trips a moment through a local date and time field", () => {
    const iso = "2026-10-21T09:30:00.000Z";
    expect(fromLocalInput(toLocalInput(iso))).toBe(iso);
    expect(toLocalInput(null)).toBe("");
    expect(fromLocalInput("")).toBeNull();
  });
});

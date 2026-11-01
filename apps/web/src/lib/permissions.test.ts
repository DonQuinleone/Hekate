import { defaultReviewerPermissions as all, reviewerTools } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { setLocale } from "./locale";
import {
  accessNote,
  fromLocalInput,
  guestRow,
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
    ).toMatch(/^closed on 2026-10-19$/);
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

describe("a guest's home", () => {
  it("says what each row asks of the guest (#667)", () => {
    const now = new Date("2026-10-14T12:00:00Z");
    const base = {
      status: "open" as const,
      dueAt: "2026-10-31T09:00:00Z",
      submittedAt: null,
      opensAt: null,
      closesAt: null,
      accessOpen: true,
    };
    const asked = guestRow({ ...base, kind: "approval" }, now);
    expect(asked.waits).toBe(true);
    expect(asked.line).toBe("Approval · due in 17 days");
    expect(asked.shareBadge).toBeNull();
    const answered = guestRow(
      { ...base, kind: "feedback", submittedAt: "2026-10-13T09:00:00Z" },
      now,
    );
    expect(answered.waits).toBe(false);
    expect(answered.line).toBe("Feedback · you have responded");
    // A share asks nothing, so nothing waits; closed to them, its badge says when.
    const shared = guestRow({ ...base, kind: "share", dueAt: null }, now);
    expect(shared).toEqual({ waits: false, line: "Shared with you", shareBadge: "Shared" });
    const lapsed = guestRow(
      { ...base, kind: "share", dueAt: null, closesAt: "2026-10-12T21:59:00Z", accessOpen: false },
      now,
    );
    expect(lapsed.line).toBe("Shared with you");
    expect(lapsed.shareBadge).toMatch(/^Closed on 2026-10-12$/);
    expect(guestRow({ ...base, kind: "share", status: "cancelled" }, now).shareBadge).toBe(
      "No longer shared",
    );
  });
});

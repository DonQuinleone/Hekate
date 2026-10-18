import { describe, expect, it } from "vitest";
import { overviewLayoutInput, type TrackReviewItem, trackState } from "./overview.ts";

const latest = { id: "v2", createdAt: "2026-10-10T10:00:00.000Z" };
const item = (over: Partial<TrackReviewItem>): TrackReviewItem => ({
  versionId: null,
  kind: "approval",
  status: "completed",
  outcome: "approved",
  completedAt: "2026-10-11T10:00:00.000Z",
  ...over,
});

describe("trackState", () => {
  it("has nothing to judge without a version", () => {
    expect(trackState(null, [item({})])).toBe("no_version");
  });

  it("is in review while an open review covers the latest", () => {
    expect(trackState(latest, [item({ status: "open", outcome: null, completedAt: null })])).toBe(
      "in_review",
    );
    expect(trackState(latest, [item({ status: "open", versionId: "v1", completedAt: null })])).toBe(
      "not_reviewed",
    ); // A share asks nothing of the track, so it never puts it in review (#138).
    expect(
      trackState(latest, [
        item({ kind: "share", status: "open", outcome: null, completedAt: null }),
      ]),
    ).toBe("not_reviewed");
  });

  it("takes the last approval to settle on the latest", () => {
    expect(
      trackState(latest, [
        item({ outcome: "changes_requested", completedAt: "2026-10-11T09:00:00.000Z" }),
        item({ outcome: "approved", completedAt: "2026-10-12T09:00:00.000Z" }),
      ]),
    ).toBe("approved");
    expect(trackState(latest, [item({ versionId: "v2", outcome: "changes_requested" })])).toBe(
      "changes_requested",
    );
  });

  it("does not count an approval that settled before the latest arrived, or feedback", () => {
    expect(trackState(latest, [item({ completedAt: "2026-10-09T10:00:00.000Z" })])).toBe(
      "not_reviewed",
    );
    expect(trackState(latest, [item({ kind: "feedback", outcome: "submitted" })])).toBe(
      "not_reviewed",
    );
  });
});

describe("overviewLayoutInput", () => {
  it("takes known sections once each", () => {
    expect(overviewLayoutInput.safeParse({ sections: ["stats", "attention"] }).success).toBe(true);
    expect(overviewLayoutInput.safeParse({ sections: ["stats", "stats"] }).success).toBe(false);
    expect(overviewLayoutInput.safeParse({ sections: ["tasks"] }).success).toBe(false);
  });
});

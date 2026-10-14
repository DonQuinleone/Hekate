import { describe, expect, it } from "vitest";
import { reviewState } from "./reviews";

describe("review status", () => {
  it("shows open, settled, feedback-in and cancelled reviews apart", () => {
    expect(reviewState({ status: "open", outcome: null })).toBe("in_review");
    expect(reviewState({ status: "completed", outcome: "approved" })).toBe("approved");
    expect(reviewState({ status: "completed", outcome: "changes_requested" })).toBe(
      "changes_requested",
    );
    expect(reviewState({ status: "completed", outcome: "submitted" })).toBe("submitted");
    expect(reviewState({ status: "cancelled", outcome: null })).toBe("cancelled");
  });
});

import { describe, expect, it } from "vitest";
import type { ReviewDetail } from "~/lib/queries";
import { stripState } from "./decision-strip";

type Me = Partial<ReviewDetail["reviewers"][number]>;

const review = (
  kind: "approval" | "feedback",
  me: Me | null,
  you: Partial<ReviewDetail["you"]> = {},
  status = "open",
) =>
  ({
    kind,
    status,
    reviewers: me ? [{ id: "me", state: "invited", decision: null, submittedAt: null, ...me }] : [],
    you: { reviewerId: me ? "me" : null, canDecide: true, canSubmit: true, ...you },
  }) as unknown as ReviewDetail;

describe("the decision strip on a file (#15)", () => {
  it("offers the decision to a reviewer whose turn it is", () => {
    expect(stripState(review("approval", {}))).toEqual({ kind: "decide" });
    expect(stripState(review("feedback", {}))).toEqual({ kind: "submit" });
  });

  it("says what they answered, and why someone cannot answer yet", () => {
    expect(stripState(review("approval", { decision: "approved" }))).toEqual({
      kind: "answered",
      decision: "approved",
    });
    expect(stripState(review("feedback", { submittedAt: "2026-10-17T12:00:00Z" }))).toEqual({
      kind: "answered",
      decision: "submitted",
    });
    expect(stripState(review("approval", { state: "observing" }))).toEqual({ kind: "observing" });
    expect(stripState(review("approval", { state: "waiting" }))).toEqual({ kind: "waiting" });
  });

  it("shows nothing to someone not asked, or once the review has closed", () => {
    expect(stripState(review("approval", null))).toBeNull();
    expect(stripState(review("approval", {}, {}, "completed"))).toBeNull();
    // Their access has not opened, say: the review page explains.
    expect(stripState(review("approval", {}, { canDecide: false }))).toBeNull();
  });
});

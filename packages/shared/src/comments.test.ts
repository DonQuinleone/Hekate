import { describe, expect, it } from "vitest";
import { anchorProblem, createCommentInput } from "./comments.ts";

describe("comments", () => {
  it("validates new comments and keeps replies on their thread's anchor", () => {
    expect(createCommentInput.parse({ body: "  Lovely  " })).toEqual({ body: "Lovely" });
    expect(createCommentInput.safeParse({ body: "   " }).success).toBe(false);
    expect(
      createCommentInput.safeParse({
        body: "Here",
        anchor: { kind: "time", start: 1, end: 1 },
        parentId: "0190a6f0-0000-7000-8000-000000000000",
      }).success,
    ).toBe(false);
  });

  it("only lets anchors point where a file has such a place", () => {
    const time = { kind: "time" as const, start: 10, end: 12 };
    expect(anchorProblem(time, { kind: "audio", duration: 60 })).toBeNull();
    expect(anchorProblem(time, { kind: "audio", duration: 11 })).toMatch(/past the end/);
    expect(anchorProblem(time, { kind: "document" })).toMatch(/timeline/);
    const region = { kind: "region" as const, page: 2, x: 0, y: 0, width: 0.5, height: 0.5 };
    expect(anchorProblem(region, { kind: "document" })).toBeNull();
    expect(anchorProblem(region, { kind: "audio" })).toMatch(/page or a frame/);
    expect(anchorProblem(region, { kind: "video" })).toMatch(/Only documents have pages/);
    const nowhere = { kind: "region" as const, x: 0, y: 0, width: 0.5, height: 0.5 };
    expect(anchorProblem(nowhere, { kind: "document" })).toMatch(/which page/);
    expect(anchorProblem(nowhere, { kind: "video" })).toMatch(/which frame/);
    expect(anchorProblem({ ...nowhere, at: 4 }, { kind: "video" })).toBeNull();
    expect(anchorProblem(nowhere, { kind: "image" })).toBeNull();
    const bar = { kind: "bar" as const, from: { bar: 72, beat: 1 } };
    expect(anchorProblem(bar, { kind: "audio" })).toBeNull();
    expect(anchorProblem(bar, { kind: "image" })).toMatch(/recording or a score/);
  });
});

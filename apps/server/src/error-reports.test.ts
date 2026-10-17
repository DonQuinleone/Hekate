import { describe, expect, it } from "vitest";
import { failureContext } from "./error-reports.ts";

const id = "0199e3a6-8f1c-7a02-8e44-2b7d0c9f3a15";
const other = "0199e3a1-7c2f-7b40-9a51-4f2d8c1e09aa";

describe("what a failed request was about", () => {
  it("names the resource its path begins with, and any id it was given", () => {
    expect(failureContext("/api/files/:id/comments", { id })).toEqual({ fileId: id });
    expect(failureContext("/api/reviews/:id", { id })).toEqual({ reviewId: id });
    expect(
      failureContext("/api/instance/workspaces/:id/members/:userId/:action", {
        id,
        userId: "abc",
        action: "sessions",
      }),
    ).toBeUndefined();
    expect(
      failureContext("/api/tracks/:trackId/versions/:versionId", { trackId: id, versionId: other }),
    ).toEqual({
      trackId: id,
      versionId: other,
    });
  });

  it("keeps identifiers only", () => {
    expect(failureContext("/api/files/:id", { id: "Solace - Score.pdf" })).toBeUndefined();
    expect(failureContext("/api/me", {})).toBeUndefined();
  });
});

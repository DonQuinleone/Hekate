import { describe, expect, it } from "vitest";
import { swappedSummary } from "./score-swap";

describe("swappedSummary", () => {
  it("says what followed its bars, and what stayed", () => {
    expect(swappedSummary({ marks: 12, takes: 2, stayed: 3 })).toBe(
      "Moved to their bars in the new score: 12 marks and 2 takes. 3 marks stayed where they were, with no bar to find them by.",
    );
    expect(swappedSummary({ marks: 1, takes: 0, stayed: 0 })).toBe(
      "Moved to their bars in the new score: 1 mark.",
    );
  });

  it("says when nothing could move, and nothing when nothing was there", () => {
    expect(swappedSummary({ marks: 0, takes: 0, stayed: 1 })).toBe(
      "1 mark stayed where it was, with no bar to find it by.",
    );
    expect(swappedSummary({ marks: 0, takes: 0, stayed: 0 })).toBeNull();
  });

  it("says the marks wait for a score still being drawn", () => {
    expect(swappedSummary({ marks: 0, takes: 0, stayed: 0, waiting: true })).toBe(
      "The marks follow their bars once the new score is drawn.",
    );
  });
});

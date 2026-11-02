import { describe, expect, it } from "vitest";
import { setByWords } from "./workflow-statuses";

describe("setByWords", () => {
  it("says a status no step sets is unused, and counts only where more than one sets it", () => {
    expect(setByWords(0)).toBe("Unused: no step sets it");
    expect(setByWords(1)).toBeNull();
    expect(setByWords(3)).toBe("Set by 3 steps");
  });
});

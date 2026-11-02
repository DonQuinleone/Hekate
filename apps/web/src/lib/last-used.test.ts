import { describe, expect, it } from "vitest";
import { lastUsed, sentence } from "./last-used";

const now = Date.parse("2026-10-14T12:00:00Z");

describe("when something was last used (#707)", () => {
  it("says how long ago while that reads well, and the day once it does not", () => {
    expect(lastUsed("2026-10-14T10:00:00Z", now)).toBe("last used 2 hours ago");
    expect(lastUsed("2026-10-13T12:00:00Z", now)).toBe("last used yesterday");
    const older = lastUsed("2026-09-10T12:00:00Z", now);
    expect(older).toMatch(/^last used on /);
    expect(older).not.toMatch(/last month/);
  });

  it("starts a line with a capital", () => {
    expect(sentence("last used yesterday")).toBe("Last used yesterday");
    expect(sentence("")).toBe("");
  });
});

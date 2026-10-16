import { describe, expect, it } from "vitest";
import { passwordStrength } from "./password";

describe("password strength", () => {
  it("refuses anything under twelve characters", () => {
    expect(passwordStrength("short one").score).toBe(0);
  });
  it("prefers length, and a passphrase of a few words, above all", () => {
    expect(passwordStrength("abcdefghijkl").label).toBe("weak");
    expect(passwordStrength("maple leaf rag trio").score).toBeGreaterThanOrEqual(2);
    expect(passwordStrength("maple leaf rag trio, bar 17").label).toBe("strong");
  });
  it("marks down a long run of one character", () => {
    expect(passwordStrength("aaaaaaaaaaaaaaaaaa").score).toBeLessThan(
      passwordStrength("abcdefghijklmnopqr").score,
    );
  });
});

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openSecret, sealSecret } from "./secrets.ts";

describe("sealed secrets", () => {
  const key = randomBytes(32);
  it("opens what it sealed, and nothing else", () => {
    const sealed = sealSecret(key, "bind-secret", "directory:one");
    expect(sealed).not.toContain("bind-secret");
    expect(openSecret(key, sealed, "directory:one")).toBe("bind-secret");
    expect(() => openSecret(key, sealed, "directory:two")).toThrow();
    expect(() => openSecret(randomBytes(32), sealed, "directory:one")).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { excerpt, prefixQuery } from "./search.ts";

describe("prefixQuery", () => {
  it("turns words into prefixes that must all match", () => {
    expect(prefixQuery("Map le")).toBe("map:* & le:*");
    expect(prefixQuery("Dry v2.wav")).toBe("dry:* & v2:* & wav:*");
  });

  it("keeps query syntax out and gives up on nothing", () => {
    expect(prefixQuery("a & !b | c:*")).toBe("a:* & b:* & c:*");
    expect(prefixQuery("  ' & ! ")).toBeNull();
    expect(prefixQuery("Größe Élan")).toBe("größe:* & élan:*");
  });
});

describe("excerpt", () => {
  it("shortens long text on one line", () => {
    expect(excerpt("Pedal noise\n on the left", 80)).toBe("Pedal noise on the left");
    expect(excerpt("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

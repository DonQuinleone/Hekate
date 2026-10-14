import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateKey, KeyUnwrapError, keyId, unwrapKey, wrapKey } from "./wrap.ts";

describe("key wrapping", () => {
  const kek = generateKey();
  const key = generateKey();

  it("wraps and unwraps a key in its context", () => {
    const wrapped = wrapKey(kek, key, "blob:1");
    expect(unwrapKey(kek, wrapped, "blob:1").equals(key)).toBe(true);
    expect(wrapped).not.toContain(key.toString("base64"));
  });

  it("refuses the wrong key, the wrong context and altered records", () => {
    const wrapped = wrapKey(kek, key, "blob:1");
    expect(() => unwrapKey(generateKey(), wrapped, "blob:1")).toThrow(KeyUnwrapError);
    expect(() => unwrapKey(kek, wrapped, "blob:2")).toThrow(KeyUnwrapError);
    const bytes = Buffer.from(wrapped, "base64");
    bytes[20] = (bytes[20] ?? 0) ^ 1;
    expect(() => unwrapKey(kek, bytes.toString("base64"), "blob:1")).toThrow(KeyUnwrapError);
    expect(() => unwrapKey(kek, "bm90IGEga2V5", "blob:1")).toThrow(/Malformed/);
  });

  it("never wraps the same way twice", () => {
    expect(wrapKey(kek, key, "x")).not.toBe(wrapKey(kek, key, "x"));
  });

  it("identifies master keys without revealing them", () => {
    expect(keyId(kek)).toBe(keyId(Buffer.from(kek)));
    expect(keyId(kek)).not.toBe(keyId(randomBytes(32)));
    expect(keyId(kek)).toMatch(/^[0-9a-f]{16}$/);
  });
});

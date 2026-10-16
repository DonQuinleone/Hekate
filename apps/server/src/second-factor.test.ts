import { describe, expect, it } from "vitest";
import {
  hashedRecoveryCodes,
  hashRecoveryCode,
  newRecoveryCodes,
  normaliseRecoveryCode,
  recoveryCodesLeft,
} from "./second-factor.ts";

const secret = "a test secret that is long enough to use";

describe("recovery codes", () => {
  it("makes ten readable codes, all different", () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
  });

  it("reads a code however it is typed", () => {
    expect(normaliseRecoveryCode(" K7M2P x9q4t ")).toBe("k7m2px9q4t");
    expect(hashRecoveryCode(secret, "K7M2P-X9Q4T")).toBe(hashRecoveryCode(secret, "k7m2px9q4t"));
  });

  it("stores only hashes, and stores them again unchanged", async () => {
    const store = hashedRecoveryCodes(secret);
    const codes = ["k7m2p-x9q4t", "abcde-23456"];
    const stored = await store.encrypt(JSON.stringify(codes));
    expect(stored).not.toContain("k7m2p");
    const hashes = JSON.parse(await store.decrypt(stored)) as string[];
    expect(hashes).toContain(hashRecoveryCode(secret, "K7M2P X9Q4T"));
    // Better Auth writes the list back without the code used: the rest stay as they were.
    const left = await store.encrypt(JSON.stringify(hashes.slice(1)));
    expect(JSON.parse(left)).toEqual(hashes.slice(1));
    expect(recoveryCodesLeft(left)).toBe(1);
  });

  it("never takes a stored hash as a code", async () => {
    const store = hashedRecoveryCodes(secret);
    const stored = JSON.parse(await store.encrypt(JSON.stringify(["k7m2p-x9q4t"]))) as string[];
    const [hash] = stored;
    // Typed in, a stored hash is hashed again, and is not in the list.
    expect(stored).not.toContain(hashRecoveryCode(secret, hash ?? ""));
    expect(stored).toContain(hashRecoveryCode(secret, "k7m2p-x9q4t"));
  });

  it("depends on the secret", () => {
    expect(hashRecoveryCode(secret, "k7m2p-x9q4t")).not.toBe(
      hashRecoveryCode(`${secret}!`, "k7m2p-x9q4t"),
    );
  });

  it("counts nothing when nothing is stored", () => {
    expect(recoveryCodesLeft(null)).toBe(0);
    expect(recoveryCodesLeft("not json")).toBe(0);
  });
});

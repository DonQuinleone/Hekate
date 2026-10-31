import { describe, expect, it } from "vitest";
import { encryptionWords } from "./workspace-operations.ts";

describe("encryptionWords", () => {
  const day = (iso: string) => iso.slice(0, 10);

  it("says when nothing is stored yet", () => {
    expect(encryptionWords({ keyVersion: null, keySince: null, behind: 0 }, day)).toBe(
      "Nothing stored yet: its key is made with the first file",
    );
  });

  it("says since when, without the key's version", () => {
    const words = encryptionWords(
      { keyVersion: 3, keySince: "2026-10-02T09:00:00Z", behind: 0 },
      day,
    );
    expect(words).toBe("Encrypted, on a key from 2026-10-02");
    expect(words).not.toMatch(/v3|version/i);
  });

  it("says a change of key is under way, and how much is left", () => {
    expect(
      encryptionWords({ keyVersion: 4, keySince: "2026-10-29T09:00:00Z", behind: 41 }, day),
    ).toBe("Encrypted, moving to a new key: 41 to go");
  });
});

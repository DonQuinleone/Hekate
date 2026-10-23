import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { describe, expect, it } from "vitest";
import {
  ageDecrypt,
  ageEncryptor,
  bech32Decode,
  bech32Encode,
  generateIdentity,
  parseRecipient,
  recipientOf,
} from "./age.ts";

const encrypt = async (plain: Buffer, recipients: string[], pieces = 3) => {
  const step = Math.max(1, Math.ceil(plain.length / pieces));
  const parts: Buffer[] = [];
  for (let at = 0; at < plain.length; at += step) parts.push(plain.subarray(at, at + step));
  return buffer(Readable.from(parts).pipe(ageEncryptor(recipients)));
};

/** The age command, where it is installed, to show the files open with the real thing. */
const age = spawnSync("age", ["--version"]).status === 0;

const sizes = [0, 5, 65_536, 65_537, 131_072, 300_000];

describe("age", () => {
  it("writes Bech32 as BIP 173 has it, and refuses a wrong checksum", () => {
    // BIP 173's own valid example.
    expect(bech32Decode("A12UEL5L").hrp).toBe("a");
    const encoded = bech32Encode("age", Buffer.alloc(32, 7));
    expect(bech32Decode(encoded).data).toEqual(Buffer.alloc(32, 7));
    const wrong = `${encoded.slice(0, -1)}${encoded.endsWith("q") ? "p" : "q"}`;
    expect(() => bech32Decode(wrong)).toThrow();
  });

  it("makes a key pair whose secret names its recipient", () => {
    const { secretKey, recipient } = generateIdentity();
    expect(secretKey).toMatch(/^AGE-SECRET-KEY-1[0-9A-Z]{58}$/);
    expect(recipient).toMatch(/^age1[02-9ac-hj-np-z]{58}$/);
    expect(recipientOf(secretKey)).toBe(recipient);
    expect(parseRecipient(recipient)).toHaveLength(32);
  });

  it("opens what it seals, at every size around a chunk, for each recipient", async () => {
    const one = generateIdentity();
    const two = generateIdentity();
    for (const n of sizes) {
      const plain = randomBytes(n);
      const file = await encrypt(plain, [one.recipient, two.recipient]);
      expect(ageDecrypt(one.secretKey, file)).toEqual(plain);
      expect(ageDecrypt(two.secretKey, file)).toEqual(plain);
    }
    expect(() =>
      ageDecrypt(generateIdentity().secretKey, Buffer.from("age-encryption.org/v1\n--- x\n")),
    ).toThrow();
  });

  it("refuses a file altered, cut short or opened with another key", async () => {
    const { secretKey, recipient } = generateIdentity();
    const plain = randomBytes(140_000);
    const file = await encrypt(plain, [recipient]);
    const flipped = Buffer.from(file);
    flipped[flipped.length - 100] = (flipped[flipped.length - 100] ?? 0) ^ 1;
    expect(() => ageDecrypt(secretKey, flipped)).toThrow();
    // Whole chunks dropped from the end: the one now last was not sealed as last.
    expect(() => ageDecrypt(secretKey, file.subarray(0, file.length - 8_000))).toThrow();
    expect(() => ageDecrypt(generateIdentity().secretKey, file)).toThrow(/No recipient/);
  });

  it.skipIf(!age)("is opened by the age command, and opens what it writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hekate-age-"));
    try {
      const { secretKey, recipient } = generateIdentity();
      const keyFile = join(dir, "key.txt");
      writeFileSync(keyFile, `${secretKey}\n`);
      for (const n of sizes) {
        const plain = randomBytes(n);
        const path = join(dir, `${n}.age`);
        writeFileSync(path, await encrypt(plain, [recipient]));
        expect(execFileSync("age", ["-d", "-i", keyFile, path])).toEqual(plain);
      }
      const plain = randomBytes(70_000);
      const theirs = execFileSync("age", ["-r", recipient], { input: plain });
      expect(ageDecrypt(secretKey, theirs)).toEqual(plain);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

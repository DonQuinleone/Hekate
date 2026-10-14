import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { describe, expect, it } from "vitest";
import {
  DecryptionError,
  decryptor,
  encryptedSize,
  encryptor,
  HEADER_SIZE,
  planRead,
  SEGMENT_SIZE,
  TAG_SIZE,
} from "./cipher.ts";
import { RangeNotSatisfiableError } from "./errors.ts";
import type { ByteRange } from "./types.ts";

const key = randomBytes(32);
const aad = Buffer.from("01999999-0000-7000-8000-000000000001");

/** Encrypt in uneven chunks, as a network upload would arrive. */
async function encrypt(plain: Buffer, withKey = key, withAad = aad): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for (let i = 0; i < plain.length; i += 7919) chunks.push(plain.subarray(i, i + 7919));
  return buffer(Readable.from(chunks).pipe(encryptor(withKey, withAad)));
}

/** Read a plaintext range the way storage does: fetch only the planned bytes. */
async function read(
  stored: Buffer,
  plainSize: number,
  range?: ByteRange,
  options: { key?: Buffer; aad?: Buffer } = {},
): Promise<Buffer> {
  const plan = planRead(plainSize, range);
  const fetched = stored.subarray(plan.cipher.start, plan.cipher.end + 1);
  const header = plan.cipher.start === 0 ? undefined : stored.subarray(0, HEADER_SIZE);
  const decrypt = decryptor({
    key: options.key ?? key,
    aad: options.aad ?? aad,
    plainSize,
    plan,
    ...(header ? { header } : {}),
  });
  // Feed in odd-sized chunks to exercise segment reassembly.
  const chunks: Buffer[] = [];
  for (let i = 0; i < fetched.length; i += 5003) chunks.push(fetched.subarray(i, i + 5003));
  return buffer(Readable.from(chunks).pipe(decrypt));
}

describe("segmented encryption", () => {
  const sizes = [0, 1, SEGMENT_SIZE - 1, SEGMENT_SIZE, SEGMENT_SIZE + 1, 3 * SEGMENT_SIZE + 12345];

  it.each(sizes)("round-trips %i bytes and predicts the stored size", async (size) => {
    const plain = randomBytes(size);
    const stored = await encrypt(plain);
    expect(stored.length).toBe(encryptedSize(size));
    expect((await read(stored, size)).equals(plain)).toBe(true);
  });

  it("never stores plaintext", async () => {
    const plain = Buffer.from("RIFF....WAVEfmt the unreleased master ".repeat(4000));
    const stored = await encrypt(plain);
    expect(stored.includes(Buffer.from("unreleased master"))).toBe(false);
  });

  it("uses a fresh nonce prefix for every object", async () => {
    const plain = Buffer.alloc(100, 1);
    const a = await encrypt(plain);
    const b = await encrypt(plain);
    expect(a.subarray(0, HEADER_SIZE).equals(b.subarray(0, HEADER_SIZE))).toBe(false);
    expect(a.equals(b)).toBe(false);
  });

  it("reads any range, fetching only the segments it touches", async () => {
    const size = 4 * SEGMENT_SIZE + 999;
    const plain = randomBytes(size);
    const stored = await encrypt(plain);
    const ranges: ByteRange[] = [
      { start: 0, end: 0 },
      { start: 0, end: SEGMENT_SIZE - 1 },
      { start: SEGMENT_SIZE - 1, end: SEGMENT_SIZE },
      { start: SEGMENT_SIZE },
      { start: 2 * SEGMENT_SIZE + 17, end: 3 * SEGMENT_SIZE + 5 },
      { start: size - 1 },
      { start: 5, end: size + 1000 },
      { start: 4 * SEGMENT_SIZE, end: size - 1 },
    ];
    for (const range of ranges) {
      const end = Math.min(range.end ?? size - 1, size - 1);
      const got = await read(stored, size, range);
      expect(got.equals(plain.subarray(range.start, end + 1)), JSON.stringify(range)).toBe(true);
    }
    // A one-byte read in the middle fetches one sealed segment, not the object.
    const plan = planRead(size, { start: 2 * SEGMENT_SIZE + 10, end: 2 * SEGMENT_SIZE + 10 });
    expect(plan.cipher.end - plan.cipher.start + 1).toBe(SEGMENT_SIZE + TAG_SIZE);
  });

  it("refuses ranges outside the object", () => {
    expect(() => planRead(10, { start: 10 })).toThrow(RangeNotSatisfiableError);
    expect(() => planRead(0, { start: 0 })).toThrow(RangeNotSatisfiableError);
    expect(() => planRead(10, { start: 5, end: 4 })).toThrow(RangeNotSatisfiableError);
  });

  describe("detects tampering", () => {
    const size = 3 * SEGMENT_SIZE + 100;
    const plain = randomBytes(size);
    const sealed = SEGMENT_SIZE + TAG_SIZE;

    it("a flipped bit in any segment", async () => {
      const stored = await encrypt(plain);
      for (const at of [
        HEADER_SIZE + 5,
        HEADER_SIZE + sealed + 70000 - sealed,
        stored.length - 1,
      ]) {
        const altered = Buffer.from(stored);
        altered[at] = (altered[at] ?? 0) ^ 1;
        await expect(read(altered, size), `byte ${at}`).rejects.toBeInstanceOf(DecryptionError);
      }
    });

    it("a changed header", async () => {
      const stored = Buffer.from(await encrypt(plain));
      stored[HEADER_SIZE - 1] = (stored[HEADER_SIZE - 1] ?? 0) ^ 1;
      await expect(read(stored, size)).rejects.toBeInstanceOf(DecryptionError);
      const wrongMagic = Buffer.from(stored);
      wrongMagic[0] = 0;
      await expect(read(wrongMagic, size)).rejects.toThrow(/Not an encrypted Hekate object/);
    });

    it("reordered segments", async () => {
      const stored = await encrypt(plain);
      const segment = (i: number) =>
        stored.subarray(HEADER_SIZE + i * sealed, HEADER_SIZE + (i + 1) * sealed);
      const swapped = Buffer.concat([
        stored.subarray(0, HEADER_SIZE),
        segment(1),
        segment(0),
        stored.subarray(HEADER_SIZE + 2 * sealed),
      ]);
      await expect(read(swapped, size)).rejects.toBeInstanceOf(DecryptionError);
    });

    it("truncation at a segment boundary", async () => {
      const stored = await encrypt(plain);
      // Drop the final segment and claim the object ends a segment earlier.
      const truncated = stored.subarray(0, HEADER_SIZE + 3 * sealed);
      await expect(read(truncated, 3 * SEGMENT_SIZE)).rejects.toBeInstanceOf(DecryptionError);
      // Or keep the claimed size and cut bytes off the end.
      await expect(read(stored.subarray(0, stored.length - 10), size)).rejects.toBeInstanceOf(
        DecryptionError,
      );
    });

    it("ciphertext moved to another object", async () => {
      const stored = await encrypt(plain);
      await expect(
        read(stored, size, undefined, { aad: Buffer.from("another-object") }),
      ).rejects.toBeInstanceOf(DecryptionError);
    });

    it("the wrong key", async () => {
      const stored = await encrypt(plain);
      await expect(read(stored, size, undefined, { key: randomBytes(32) })).rejects.toBeInstanceOf(
        DecryptionError,
      );
    });
  });

  it("refuses keys of the wrong length", () => {
    expect(() => encryptor(randomBytes(16), aad)).toThrow(/32 bytes/);
  });
});

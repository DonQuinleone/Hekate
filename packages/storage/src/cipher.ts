import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";
import { RangeNotSatisfiableError, StorageError } from "./errors.ts";
import { assertValidRange } from "./keys.ts";
import type { ByteRange } from "./types.ts";

/**
 * Segmented authenticated encryption for stored objects (docs/security.md).
 *
 * Plaintext is cut into 64 KiB segments, each sealed with AES-256-GCM under the
 * object's own data key, so any byte range can be read by fetching and opening
 * only the segments it touches. The construction follows the STREAM design used
 * by Tink and age: each nonce is a random per-object prefix, the segment index
 * and a final-segment flag, so segments cannot be reordered, dropped, duplicated
 * or truncated without failing authentication. The object's id is bound in as
 * associated data, so ciphertext cannot be swapped between objects.
 *
 * Layout: header (magic "HKE", version 1, 7-byte nonce prefix), then segments of
 * ciphertext followed by a 16-byte tag. The last segment holds 0 to 64 KiB.
 */

const MAGIC = Buffer.from("HKE");
const VERSION = 1;
const PREFIX_SIZE = 7;
export const HEADER_SIZE = MAGIC.length + 1 + PREFIX_SIZE;
export const SEGMENT_SIZE = 64 * 1024;
export const TAG_SIZE = 16;
export const KEY_SIZE = 32;
const SEALED_SEGMENT = SEGMENT_SIZE + TAG_SIZE;
/** The nonce carries a 32-bit segment index. */
const MAX_SEGMENTS = 2 ** 32;

export class DecryptionError extends StorageError {
  override name = "DecryptionError";
}

function nonce(prefix: Buffer, index: number, last: boolean): Buffer {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeUInt32BE(index, PREFIX_SIZE);
  n[11] = last ? 1 : 0;
  return n;
}

function assertKey(key: Uint8Array) {
  if (key.length !== KEY_SIZE) throw new StorageError(`Data keys are ${KEY_SIZE} bytes`);
}

/** Number of segments for a plaintext of this size. An empty object still has one, empty, segment. */
export function segmentCount(plainSize: number): number {
  return Math.max(1, Math.ceil(plainSize / SEGMENT_SIZE));
}

/** Size of the stored ciphertext for a plaintext of this size. */
export function encryptedSize(plainSize: number): number {
  return HEADER_SIZE + plainSize + segmentCount(plainSize) * TAG_SIZE;
}

function sealSegment(
  key: Uint8Array,
  aad: Uint8Array,
  prefix: Buffer,
  index: number,
  last: boolean,
  plain: Buffer,
) {
  if (index >= MAX_SEGMENTS) throw new StorageError("Object too large to encrypt");
  const cipher = createCipheriv("aes-256-gcm", key, nonce(prefix, index, last));
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

const headerFor = (prefix: Buffer) => Buffer.concat([MAGIC, Buffer.from([VERSION]), prefix]);

/** A fresh random nonce prefix for one object. */
export function newNoncePrefix(): Buffer {
  return randomBytes(PREFIX_SIZE);
}

/**
 * Uploads arrive in chunks of 128 segments (8 MiB of plaintext). Each chunk is
 * encrypted on its own, in any order, and the encrypted chunks joined in order
 * are exactly what `encryptor` would have produced for the whole object.
 */
export const CHUNK_SEGMENTS = 128;
export const CHUNK_SIZE = CHUNK_SEGMENTS * SEGMENT_SIZE;

/** How many upload chunks an object of this size has. An empty object has one, empty, chunk. */
export function chunkCount(plainSize: number): number {
  return Math.max(1, Math.ceil(plainSize / CHUNK_SIZE));
}

/** The plaintext length chunk `index` must have. */
export function chunkLength(plainSize: number, index: number): number {
  const count = chunkCount(plainSize);
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new StorageError(`Chunk ${index} is outside an object of ${plainSize} bytes`);
  }
  return index < count - 1 ? CHUNK_SIZE : plainSize - index * CHUNK_SIZE;
}

/** Encrypt one upload chunk. Chunk 0 also carries the object's header. */
export function encryptChunk(options: {
  key: Uint8Array;
  aad: Uint8Array;
  prefix: Uint8Array;
  /** Plaintext size of the whole object. */
  plainSize: number;
  index: number;
  plain: Uint8Array;
}): Buffer {
  assertKey(options.key);
  const prefix = Buffer.from(options.prefix);
  if (prefix.length !== PREFIX_SIZE)
    throw new StorageError(`Nonce prefixes are ${PREFIX_SIZE} bytes`);
  const expected = chunkLength(options.plainSize, options.index);
  const plain = Buffer.from(
    options.plain.buffer,
    options.plain.byteOffset,
    options.plain.byteLength,
  );
  if (plain.length !== expected) {
    throw new StorageError(`Chunk ${options.index} must be ${expected} bytes, not ${plain.length}`);
  }
  const lastSegment = segmentCount(options.plainSize) - 1;
  const first = options.index * CHUNK_SEGMENTS;
  const out: Buffer[] = options.index === 0 ? [headerFor(prefix)] : [];
  // An empty object is one empty segment.
  const segments = Math.max(1, Math.ceil(plain.length / SEGMENT_SIZE));
  for (let s = 0; s < segments; s++) {
    const i = first + s;
    out.push(
      sealSegment(
        options.key,
        options.aad,
        prefix,
        i,
        i === lastSegment,
        plain.subarray(s * SEGMENT_SIZE, (s + 1) * SEGMENT_SIZE),
      ),
    );
  }
  return Buffer.concat(out);
}

/** A transform that encrypts a plaintext stream into the stored format. */
export function encryptor(key: Uint8Array, aad: Uint8Array): Transform {
  assertKey(key);
  const prefix = newNoncePrefix();
  const header = headerFor(prefix);
  let index = 0;
  let pending: Buffer[] = [];
  let pendingSize = 0;

  const seal = (plain: Buffer, last: boolean) => {
    const sealed = sealSegment(key, aad, prefix, index, last, plain);
    index += 1;
    return sealed;
  };

  let headerSent = false;
  const sendHeader = (stream: Transform) => {
    if (headerSent) return;
    stream.push(header);
    headerSent = true;
  };

  return new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      sendHeader(this);
      pending.push(chunk);
      pendingSize += chunk.length;
      try {
        // Hold back at least one byte: only the flush knows which segment is last.
        if (pendingSize > SEGMENT_SIZE) {
          let buffered = Buffer.concat(pending, pendingSize);
          while (buffered.length > SEGMENT_SIZE) {
            this.push(seal(buffered.subarray(0, SEGMENT_SIZE), false));
            buffered = buffered.subarray(SEGMENT_SIZE);
          }
          pending = [Buffer.from(buffered)];
          pendingSize = buffered.length;
        }
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback: TransformCallback) {
      try {
        sendHeader(this);
        this.push(seal(Buffer.concat(pending, pendingSize), true));
        pending = [];
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

/** Which stored bytes a plaintext read needs, and how to trim the result. */
export interface ReadPlan {
  /** Inclusive byte range of the stored object to fetch. */
  cipher: { start: number; end: number };
  firstSegment: number;
  /** Index of the last segment fetched. */
  lastSegment: number;
  /** Plaintext bytes to drop from the first fetched segment. */
  skip: number;
  /** Plaintext bytes to return. */
  length: number;
}

/** Map a plaintext range (or the whole object) onto the stored ciphertext. */
export function planRead(plainSize: number, range?: ByteRange): ReadPlan {
  if (!range) {
    return {
      cipher: { start: 0, end: encryptedSize(plainSize) - 1 },
      firstSegment: 0,
      lastSegment: segmentCount(plainSize) - 1,
      skip: 0,
      length: plainSize,
    };
  }
  assertValidRange(range);
  if (range.start >= plainSize) {
    throw new RangeNotSatisfiableError(
      `Range starts at ${range.start}; the object has ${plainSize} bytes`,
    );
  }
  const end = Math.min(range.end ?? plainSize - 1, plainSize - 1);
  const firstSegment = Math.floor(range.start / SEGMENT_SIZE);
  const lastSegment = Math.floor(end / SEGMENT_SIZE);
  return {
    cipher: {
      start: firstSegment === 0 ? 0 : HEADER_SIZE + firstSegment * SEALED_SEGMENT,
      end: Math.min(HEADER_SIZE + (lastSegment + 1) * SEALED_SEGMENT, encryptedSize(plainSize)) - 1,
    },
    firstSegment,
    lastSegment,
    skip: range.start - firstSegment * SEGMENT_SIZE,
    length: end - range.start + 1,
  };
}

/** The nonce prefix from a stored object's header. */
export function parseHeader(header: Uint8Array): Buffer {
  const bytes = Buffer.from(header);
  if (
    bytes.length < HEADER_SIZE ||
    !bytes.subarray(0, MAGIC.length).equals(MAGIC) ||
    bytes[MAGIC.length] !== VERSION
  ) {
    throw new DecryptionError("Not an encrypted Hekate object, or an unknown format version");
  }
  return Buffer.from(bytes.subarray(MAGIC.length + 1, HEADER_SIZE));
}

export interface DecryptOptions {
  key: Uint8Array;
  aad: Uint8Array;
  /** Plaintext size of the whole object, from its record. */
  plainSize: number;
  plan: ReadPlan;
  /** The object's header, when the plan does not start at byte 0. */
  header?: Uint8Array;
}

/**
 * A transform that turns the ciphertext bytes named by `plan` into plaintext.
 * Fails if any segment is altered, missing, out of order or truncated.
 */
export function decryptor(options: DecryptOptions): Transform {
  assertKey(options.key);
  const { key, aad, plainSize, plan } = options;
  const lastIndex = segmentCount(plainSize) - 1;
  const lastPlain = plainSize - lastIndex * SEGMENT_SIZE;
  const inlineHeader = plan.cipher.start === 0;
  if (!inlineHeader && !options.header) {
    throw new StorageError("Reading from the middle of an object needs its header");
  }
  let prefix: Buffer | null = inlineHeader ? null : parseHeader(options.header as Uint8Array);
  let index = plan.firstSegment;
  let buffered: Buffer = Buffer.alloc(0);
  let toSkip = plan.skip;
  let remaining = plan.length;

  const sealedSize = (i: number) => (i === lastIndex ? lastPlain + TAG_SIZE : SEALED_SEGMENT);

  const open = (sealed: Buffer, i: number): Buffer => {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      nonce(prefix as Buffer, i, i === lastIndex),
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_SIZE));
    try {
      return Buffer.concat([
        decipher.update(sealed.subarray(0, sealed.length - TAG_SIZE)),
        decipher.final(),
      ]);
    } catch {
      throw new DecryptionError(
        `Segment ${i} failed authentication: the object is corrupt or was altered`,
      );
    }
  };

  const drain = (stream: Transform) => {
    if (prefix === null) {
      if (buffered.length < HEADER_SIZE) return;
      prefix = parseHeader(buffered.subarray(0, HEADER_SIZE));
      buffered = buffered.subarray(HEADER_SIZE);
    }
    while (index <= plan.lastSegment && buffered.length >= sealedSize(index)) {
      const size = sealedSize(index);
      let plain = open(buffered.subarray(0, size), index);
      buffered = buffered.subarray(size);
      index += 1;
      if (toSkip > 0) {
        plain = plain.subarray(toSkip);
        toSkip = 0;
      }
      if (plain.length > remaining) plain = plain.subarray(0, remaining);
      remaining -= plain.length;
      if (plain.length > 0) stream.push(plain);
    }
  };

  return new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      try {
        drain(this);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback: TransformCallback) {
      try {
        drain(this);
        if (index <= plan.lastSegment || remaining !== 0 || buffered.length !== 0) {
          throw new DecryptionError("The stored object is truncated or has trailing bytes");
        }
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

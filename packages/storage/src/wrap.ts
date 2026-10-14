import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { KEY_SIZE } from "./cipher.ts";
import { StorageError } from "./errors.ts";

/**
 * Key wrapping for the envelope hierarchy (docs/security.md): data keys are
 * wrapped by an organisation key, organisation keys by an instance master key.
 *
 * Format, base64 encoded: version (1 byte), 12-byte nonce, wrapped key, 16-byte tag.
 * The context (for example "blob:<id>") is bound as associated data, so a wrapped
 * key cannot be moved to another record.
 */

const VERSION = 1;

export class KeyUnwrapError extends StorageError {
  override name = "KeyUnwrapError";
}

export function generateKey(): Buffer {
  return randomBytes(KEY_SIZE);
}

/** Keys that can be wrapped: 32-byte AES-256 keys, and 16-byte AES-128 HLS content keys. */
const WRAPPABLE = new Set([16, KEY_SIZE]);

export function wrapKey(kek: Uint8Array, key: Uint8Array, context: string): string {
  if (kek.length !== KEY_SIZE || !WRAPPABLE.has(key.length)) {
    throw new StorageError(
      `Wrapping keys are ${KEY_SIZE} bytes; wrapped keys are 16 or ${KEY_SIZE}`,
    );
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", kek, nonce);
  cipher.setAAD(Buffer.from(context));
  const wrapped = Buffer.concat([cipher.update(key), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), nonce, wrapped, cipher.getAuthTag()]).toString(
    "base64",
  );
}

export function unwrapKey(kek: Uint8Array, wrapped: string, context: string): Buffer {
  const bytes = Buffer.from(wrapped, "base64");
  const keyLength = bytes.length - (1 + 12 + 16);
  if (!WRAPPABLE.has(keyLength) || bytes[0] !== VERSION) {
    throw new KeyUnwrapError("Malformed wrapped key");
  }
  const decipher = createDecipheriv("aes-256-gcm", kek, bytes.subarray(1, 13));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  try {
    return Buffer.concat([decipher.update(bytes.subarray(13, 13 + keyLength)), decipher.final()]);
  } catch {
    throw new KeyUnwrapError(`Cannot unwrap the key for ${context}: wrong key or altered record`);
  }
}

/**
 * A stable, non-secret identifier for a master key, stored beside everything it
 * wraps so rotation knows which key to use. Derived one-way; reveals nothing.
 */
export function keyId(key: Uint8Array): string {
  return createHash("sha256")
    .update("hekate master key id\0")
    .update(key)
    .digest("hex")
    .slice(0, 16);
}

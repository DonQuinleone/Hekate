import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Small secrets a workspace gives Hekate to use on its behalf (a directory's bind password),
 * sealed with the workspace's key: AES-256-GCM, a fresh nonce each time, and a context that
 * binds the sealed value to what it is for, so it cannot be moved to another use.
 */
const VERSION = 1;

export function sealSecret(key: Buffer, secret: string, context: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), nonce, cipher.getAuthTag(), body]).toString(
    "base64",
  );
}

export function openSecret(key: Buffer, sealed: string, context: string): string {
  const bytes = Buffer.from(sealed, "base64");
  if (bytes[0] !== VERSION || bytes.length < 1 + 12 + 16) throw new Error("Malformed secret");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(1, 13));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(bytes.subarray(13, 29));
  return Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString("utf8");
}

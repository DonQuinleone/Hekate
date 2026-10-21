import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/**
 * Upload requests (#139): the link's token and the optional password. Only hashes are kept: the
 * token's (SHA-256, as it is long and random) and the password's (scrypt, salted, as people
 * choose it).
 */

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  length: number,
) => Promise<Buffer>;

/** A new link's token: 32 random bytes, URL-safe. */
export const newRequestToken = () => randomBytes(32).toString("base64url");

/** What a password is kept as: `scrypt:<salt>:<hash>`, both base64. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 32);
  return `scrypt:${salt.toString("base64")}:${hash.toString("base64")}`;
}

/** Whether `password` is the one kept as `stored`, in constant time. */
export async function passwordMatches(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const given = await scryptAsync(password, Buffer.from(salt, "base64"), expected.length);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

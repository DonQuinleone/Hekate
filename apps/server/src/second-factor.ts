import { createHmac, randomInt } from "node:crypto";

/**
 * Recovery codes for a second factor: ten, each ten characters from an alphabet without
 * look-alikes, written in two groups ("k7m2p-x9q4t"). They are kept only as keyed hashes, so
 * the database never holds one that works; each is shown once, when it is made.
 */

const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
export const recoveryCodeCount = 10;

export function newRecoveryCodes(count = recoveryCodeCount): string[] {
  return Array.from({ length: count }, () => {
    const code = Array.from({ length: 10 }, () => alphabet[randomInt(alphabet.length)]).join("");
    return `${code.slice(0, 5)}-${code.slice(5)}`;
  });
}

/** A code as typed: any case, with or without the dash or spaces. */
export const normaliseRecoveryCode = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, "");

const hashed = /^[0-9a-f]{64}$/;

export const hashRecoveryCode = (secret: string, code: string) =>
  hashed.test(code)
    ? code
    : createHmac("sha256", secret).update(normaliseRecoveryCode(code)).digest("hex");

/**
 * Better Auth stores the codes through `encrypt` and reads them back through `decrypt`, then
 * looks for the one typed in the list. Here `encrypt` hashes each code (and leaves those already
 * hashed, as the list is stored again without the one used), `decrypt` returns the hashes, and
 * the typed code is hashed before the lookup (auth.ts).
 */
export const hashedRecoveryCodes = (secret: string) => ({
  encrypt: async (json: string) => {
    const codes = JSON.parse(json) as string[];
    return JSON.stringify(codes.map((code) => hashRecoveryCode(secret, code)));
  },
  decrypt: async (stored: string) => stored,
});

/** How many unused codes a stored list holds. */
export function recoveryCodesLeft(stored: string | null | undefined): number {
  if (!stored) return 0;
  try {
    const codes: unknown = JSON.parse(stored);
    return Array.isArray(codes) ? codes.length : 0;
  } catch {
    return 0;
  }
}

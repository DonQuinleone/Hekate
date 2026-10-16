import { createHmac, randomInt } from "node:crypto";
import type { SessionFactor } from "@hekate/shared";

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

/** A stored code: a keyed hash, tagged so it is never mistaken for a code someone typed. */
const STORED = "h1:";

/** The stored form of a code as typed: always hashed, whatever was typed. */
export const hashRecoveryCode = (secret: string, code: string) =>
  `${STORED}${createHmac("sha256", secret).update(normaliseRecoveryCode(code)).digest("hex")}`;

/**
 * Better Auth stores the codes through `encrypt` and reads them back through `decrypt`, then
 * looks for the one typed in the list. Here `encrypt` hashes each new code (and keeps those
 * already stored, tagged, as the list is stored again without the one used), `decrypt` returns
 * the stored hashes, and the typed code is always hashed before the lookup (auth.ts): a stored
 * hash sent as if it were a code is hashed again, and matches nothing.
 */
export const hashedRecoveryCodes = (secret: string) => ({
  encrypt: async (json: string) => {
    const codes = JSON.parse(json) as string[];
    return JSON.stringify(
      codes.map((code) => (code.startsWith(STORED) ? code : hashRecoveryCode(secret, code))),
    );
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

/**
 * How a new session was signed in, from the route that made it (decision 048). A code, or a
 * recovery code, makes it a second-factor session; a passkey, a passkey session. A password
 * alone is just that, unless the account has a code app: then sign-in only ends without one
 * in a browser trusted after a code. Removing the code app leaves a code-backed session with
 * the password alone. Anything else (a session renewed after a change) keeps the factor of
 * the session it replaces.
 */
export function factorFor(
  path: string | undefined,
  account: { twoFactorEnabled: boolean },
  previous: SessionFactor | undefined,
): SessionFactor {
  if (path === "/two-factor/verify-totp" || path === "/two-factor/verify-backup-code")
    return "second_factor";
  if (path === "/passkey/verify-authentication") return "passkey";
  if (path === "/sign-in/email") return account.twoFactorEnabled ? "second_factor" : "password";
  // Removing the code app takes away what a code-backed session stood on.
  if (path === "/two-factor/disable") return previous === "passkey" ? "passkey" : "password";
  return previous ?? "password";
}

import { createHash, randomBytes } from "node:crypto";

/** A random 256-bit token for the link, and the hash stored in its place. */
export function newInvitationToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashInvitationToken(token) };
}

export function hashInvitationToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

import { createHash, randomInt, timingSafeEqual } from "node:crypto";

/**
 * A code sent to a guest who opens their link, where the workspace asks for one: the link alone
 * then opens nothing, so a forwarded mail is no use to whoever it was forwarded to. Six digits,
 * ten minutes, five tries; another can be sent after half a minute, five in all for one link.
 */
export const GUEST_CODE_MS = 10 * 60 * 1000;
export const GUEST_CODE_TRIES = 5;
export const GUEST_CODE_GAP_MS = 30 * 1000;
export const GUEST_CODES_PER_LINK = 5;

export const newGuestCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

/** Only this is stored: the code bound to its link, so a hash is no use for another. */
export const hashGuestCode = (linkId: string, code: string) =>
  createHash("sha256")
    .update(`${linkId}:${code.replace(/\D/g, "")}`)
    .digest("hex");

export interface CodeState {
  id: string;
  codeHash: string | null;
  codeExpiresAt: Date | null;
  codeAttempts: number;
}

export type CodeCheck = "ok" | "wrong" | "expired" | "too_many" | "none";

/** What a typed code is worth against the one sent. */
export function checkGuestCode(link: CodeState, given: string, now: Date): CodeCheck {
  if (!link.codeHash || !link.codeExpiresAt) return "none";
  if (link.codeAttempts >= GUEST_CODE_TRIES) return "too_many";
  if (link.codeExpiresAt <= now) return "expired";
  const typed = Buffer.from(hashGuestCode(link.id, given), "hex");
  const sent = Buffer.from(link.codeHash, "hex");
  return typed.length === sent.length && timingSafeEqual(typed, sent) ? "ok" : "wrong";
}

/** Whether another code may go out for this link now. */
export function mayResend(
  link: { codeSentAt: Date | null; codesSent: number },
  now: Date,
): "send" | "wait" | "limit" {
  if (link.codesSent >= GUEST_CODES_PER_LINK) return "limit";
  if (link.codeSentAt && now.getTime() - link.codeSentAt.getTime() < GUEST_CODE_GAP_MS)
    return "wait";
  return "send";
}

/** An address as a hint of where the code went: "m•••@example.test". */
export function maskEmail(email: string): string {
  const [name = "", domain = ""] = email.split("@");
  return `${name.slice(0, 1)}•••@${domain}`;
}

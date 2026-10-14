import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/**
 * Playback tokens (docs/security.md). A token names one file in one organisation
 * and is bound to the viewer's sign-in session: every playlist, segment and key
 * request must carry both the token and that session's cookie, so a copied URL is
 * useless on its own. Tokens are HMAC-signed and expire.
 */

export interface PlaybackClaims {
  /** The sign-in session the token was issued to. */
  sessionId: string;
  organisationId: string;
  fileId: string;
  /** For a guest, the review they came through: every playback event names it. */
  reviewId?: string;
  /** Unix seconds. */
  expiresAt: number;
}

/** Long enough to watch a feature film with pauses; the session cookie still has to match. */
export const PLAYBACK_LIFETIME_SECONDS = 4 * 60 * 60;

/** A key for playback tokens, derived from AUTH_SECRET so it needs no setting of its own. */
export function playbackSecret(authSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", authSecret, "", "hekate playback tokens v1", 32));
}

const encode = (value: Buffer | string) => Buffer.from(value).toString("base64url");

export function signPlayback(secret: Buffer, claims: PlaybackClaims): string {
  const payload = encode(
    JSON.stringify({
      s: claims.sessionId,
      o: claims.organisationId,
      f: claims.fileId,
      ...(claims.reviewId ? { r: claims.reviewId } : {}),
      e: claims.expiresAt,
    }),
  );
  const signature = encode(createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${signature}`;
}

/** The claims, or null when the token is malformed, forged or expired. */
export function verifyPlayback(
  secret: Buffer,
  token: string,
  now = Date.now(),
): PlaybackClaims | null {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let raw: { s?: unknown; o?: unknown; f?: unknown; r?: unknown; e?: unknown };
  try {
    raw = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    typeof raw.s !== "string" ||
    typeof raw.o !== "string" ||
    typeof raw.f !== "string" ||
    typeof raw.e !== "number" ||
    (raw.r !== undefined && typeof raw.r !== "string")
  ) {
    return null;
  }
  if (raw.e * 1000 <= now) return null;
  return {
    sessionId: raw.s,
    organisationId: raw.o,
    fileId: raw.f,
    ...(typeof raw.r === "string" ? { reviewId: raw.r } : {}),
    expiresAt: raw.e,
  };
}

/**
 * A small per-session limit on content key requests. Players fetch a key once per
 * rendition; a burst means something is harvesting keys.
 */
export function keyRateLimiter(limit = 30, windowMs = 60_000) {
  const windows = new Map<string, { start: number; count: number }>();
  return (sessionId: string, now = Date.now()): boolean => {
    const current = windows.get(sessionId);
    if (!current || now - current.start >= windowMs) {
      windows.set(sessionId, { start: now, count: 1 });
      if (windows.size > 10_000) {
        for (const [id, w] of windows) if (now - w.start >= windowMs) windows.delete(id);
      }
      return true;
    }
    current.count += 1;
    return current.count <= limit;
  };
}

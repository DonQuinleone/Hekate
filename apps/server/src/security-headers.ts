import { createMiddleware } from "hono/factory";

/**
 * The headers every response carries (#172). The web app loads nothing from elsewhere, so the
 * Content Security Policy allows this origin alone: no inline or evaluated script, media and
 * requests only to Hekate itself (and `blob:`, where hls.js feeds MediaSource and runs its
 * worker), and no framing by anyone. Unreleased material should never be one embed away.
 */
export const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  // React writes style attributes (positions, sizes); no stylesheet comes from elsewhere.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Nothing here needs a camera or a location; passkeys and full screen do. The take log reads a
 * recorder (decision 240) through Web MIDI and, for a recorder's timecode out, an audio input,
 * so this origin may ask for those, and only when someone connects one.
 */
export const permissionsPolicy = [
  "camera=()",
  "microphone=(self)",
  "midi=(self)",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "interest-cohort=()",
  "fullscreen=(self)",
  "autoplay=(self)",
  "publickey-credentials-get=(self)",
  "publickey-credentials-create=(self)",
].join(", ");

export const securityHeaders = (options: { https: boolean }) =>
  createMiddleware(async (c, next) => {
    await next();
    const headers = c.res.headers;
    // A workspace's logo (#185) carries a stricter policy of its own, which it keeps.
    if (!headers.has("Content-Security-Policy"))
      headers.set("Content-Security-Policy", contentSecurityPolicy);
    headers.set("X-Frame-Options", "DENY");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    headers.set("Permissions-Policy", permissionsPolicy);
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    // Only that logo is meant for other origins (mail clients show it), so only it may say so.
    if (headers.get("Cross-Origin-Resource-Policy") !== "cross-origin")
      headers.set("Cross-Origin-Resource-Policy", "same-origin");
    headers.set("Origin-Agent-Cluster", "?1");
    // Behind HTTPS only: a browser told this over plain HTTP would refuse the instance after.
    if (options.https) headers.set("Strict-Transport-Security", "max-age=31536000");
  });

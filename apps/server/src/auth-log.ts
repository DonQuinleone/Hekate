import { isIP } from "node:net";
import { type Database, schema } from "@hekate/db";

/**
 * The authentication log (#157): every sign-in, refusal and lockout, by how it was tried. Written
 * beside the sign-in, never awaited by it: a slow log holds no one up, and a failure to write it
 * is told to the server's log rather than refusing the person.
 */

export type AuthMethod = (typeof schema.authEvents.$inferInsert)["method"];
export type AuthEvent = typeof schema.authEvents.$inferInsert;

/** How a sign-in was made, from the path that made it; none for a path that signs no one in. */
export function signInMethodOf(path: string): AuthMethod | null {
  if (path === "/sign-in/email") return "password";
  if (path === "/passkey/verify-authentication") return "passkey";
  if (path.startsWith("/two-factor/verify-")) return "second_factor";
  if (path === "/sign-in/directory") return "directory";
  if (path.startsWith("/sso/")) return "sso";
  return null;
}

/**
 * The address and browser a request came from, as the access log reads them: behind Caddy
 * (TRUST_PROXY) the address is the last X-Forwarded-For entry, Caddy's own; otherwise none, as a
 * client could claim any.
 */
export function requestOf(
  request: Request | undefined,
  trustProxy: boolean,
): { ipAddress: string | null; userAgent: string | null } {
  const address = trustProxy
    ? request?.headers.get("x-forwarded-for")?.split(",").pop()?.trim()
    : undefined;
  return {
    ipAddress: address && isIP(address) ? address : null,
    userAgent: request?.headers.get("user-agent")?.slice(0, 512) ?? null,
  };
}

/** Write one event beside whatever it records. */
export function recordAuth(db: Database, event: AuthEvent): void {
  void db
    .insert(schema.authEvents)
    .values({ ...event, account: event.account.slice(0, 320) })
    .catch((cause: unknown) => console.error("Could not write the authentication log:", cause));
}

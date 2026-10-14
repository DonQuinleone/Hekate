import { createHash, randomBytes } from "node:crypto";
import { type Database, inOrg, schema } from "@hekate/db";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { Actor, GuestActor } from "./access.ts";
import type { Auth } from "./auth.ts";
import { organisationFor } from "./tenancy.ts";

const { guests, guestLinks, guestSessions } = schema;

/** A magic link works once, within three days of being sent. */
export const GUEST_LINK_LIFETIME_MS = 3 * 24 * 60 * 60 * 1000;
/** A guest's browser stays signed in for a fortnight, unless revoked. */
export const GUEST_SESSION_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
export const GUEST_COOKIE = "hekate_guest";

/** A random token for a link or a session, and the hash that is all the database keeps. */
export function newToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * A new magic link for a guest. Any earlier link not yet used is revoked, so only the most
 * recent one works. Returns the token, which goes in the email and nowhere else.
 */
export async function issueGuestLink(
  db: Database,
  organisationId: string,
  guestId: string,
  now = new Date(),
) {
  const { token, hash } = newToken();
  await db.transaction(async (tx) => {
    // One issue at a time per guest, so two sends cannot leave two working links.
    const [guest] = await tx
      .select({ id: guests.id })
      .from(guests)
      .where(inOrg(guests, organisationId, eq(guests.id, guestId)))
      .for("update");
    if (!guest) throw new Error("No such guest to send a link to");
    await tx
      .update(guestLinks)
      .set({ revokedAt: now })
      .where(
        inOrg(
          guestLinks,
          organisationId,
          eq(guestLinks.guestId, guestId),
          isNull(guestLinks.usedAt),
          isNull(guestLinks.revokedAt),
        ),
      );
    await tx.insert(guestLinks).values({
      organisationId,
      guestId,
      tokenHash: hash,
      expiresAt: new Date(now.getTime() + GUEST_LINK_LIFETIME_MS),
    });
  });
  return token;
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Exchange a magic link for a session. The link is spent atomically, so two browsers
 * racing with the same link get one session between them. Null for a link that is
 * unknown, used, revoked or expired: the same answer for each, so nothing can be learnt.
 * `andThen` runs in the same transaction (to log the sign-in): if it fails, the link
 * stays unspent.
 */
export async function useGuestLink(
  db: Database,
  token: string,
  andThen: (tx: Tx, session: typeof guestSessions.$inferSelect) => Promise<void> = async () => {},
  now = new Date(),
) {
  return db.transaction(async (tx) => {
    const [link] = await tx
      .update(guestLinks)
      .set({ usedAt: now })
      .where(
        and(
          eq(guestLinks.tokenHash, hashToken(token)),
          isNull(guestLinks.usedAt),
          isNull(guestLinks.revokedAt),
          gt(guestLinks.expiresAt, now),
        ),
      )
      .returning();
    if (!link) return null;
    const session = newToken();
    const [row] = await tx
      .insert(guestSessions)
      .values({
        organisationId: link.organisationId,
        guestId: link.guestId,
        tokenHash: session.hash,
        expiresAt: new Date(now.getTime() + GUEST_SESSION_LIFETIME_MS),
        lastSeenAt: now,
      })
      .returning();
    if (!row) throw new Error("Guest session insert returned no row");
    await andThen(tx, row);
    return { session: row, token: session.token };
  });
}

/**
 * Revoke every unused link and every session a guest has: they must be sent a new link.
 * Pass the caller's transaction to commit this with whatever else it records.
 */
export async function revokeGuest(
  db: Pick<Database, "transaction">,
  organisationId: string,
  guestId: string,
) {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(guestLinks)
      .set({ revokedAt: now })
      .where(
        inOrg(
          guestLinks,
          organisationId,
          eq(guestLinks.guestId, guestId),
          isNull(guestLinks.usedAt),
          isNull(guestLinks.revokedAt),
        ),
      );
    await tx
      .update(guestSessions)
      .set({ revokedAt: now })
      .where(
        inOrg(
          guestSessions,
          organisationId,
          eq(guestSessions.guestId, guestId),
          isNull(guestSessions.revokedAt),
        ),
      );
  });
}

/** The guest session behind a request's cookie, if it is current. */
export async function guestSessionOf(db: Database, c: Context, now = new Date()) {
  const token = getCookie(c, GUEST_COOKIE);
  if (!token) return null;
  const [row] = await db
    .select({
      id: guestSessions.id,
      organisationId: guestSessions.organisationId,
      guestId: guestSessions.guestId,
      name: guests.name,
      email: guests.email,
      label: guests.label,
    })
    .from(guestSessions)
    .innerJoin(guests, eq(guests.id, guestSessions.guestId))
    .where(
      and(
        eq(guestSessions.tokenHash, hashToken(token)),
        isNull(guestSessions.revokedAt),
        gt(guestSessions.expiresAt, now),
      ),
    );
  return row ?? null;
}

/** Set the guest's cookie: strict, script-proof, and only over HTTPS when the site uses it. */
export function setGuestCookie(c: Context, token: string, secure: boolean) {
  setCookie(c, GUEST_COOKIE, token, {
    httpOnly: true,
    sameSite: "Strict",
    secure,
    path: "/",
    maxAge: Math.floor(GUEST_SESSION_LIFETIME_MS / 1000),
  });
}
export const clearGuestCookie = (c: Context) => deleteCookie(c, GUEST_COOKIE, { path: "/" });

/** Variables of routes a guest may also use: who is asking, and nothing member-only. */
export interface ViewerVariables {
  actor: Actor;
  /** The member's sign-in session, or the guest's session: playback is bound to it. */
  sessionId: string;
  organisationId: string;
}

/**
 * A member (with their organisation) or a guest. Members are tried first: someone who is
 * both signed in and holding a guest cookie acts as the member.
 */
export const requireViewer = (auth: Auth, db: Database) =>
  createMiddleware<{ Variables: ViewerVariables }>(async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (session) {
      const membership = await organisationFor(db, session.user.id, session.session.id);
      c.set("actor", {
        kind: "member",
        userId: session.user.id,
        organisationId: membership.organisationId,
        organisationRole: membership.role,
      });
      c.set("sessionId", session.session.id);
      c.set("organisationId", membership.organisationId);
      await next();
      return;
    }
    const guest = await guestSessionOf(db, c);
    if (!guest) throw new HTTPException(401, { message: "Sign in to continue" });
    const actor: GuestActor = {
      kind: "guest",
      guestId: guest.guestId,
      organisationId: guest.organisationId,
    };
    c.set("actor", actor);
    c.set("sessionId", guest.id);
    c.set("organisationId", guest.organisationId);
    await next();
  });

/** Whoever holds a playback link: a member's sign-in, or a guest's session. */
export interface PlaySessionVariables {
  sessionId: string;
  who: { kind: "member"; userId: string } | GuestActor;
}

/**
 * A signed-in member or guest, without choosing an organisation: a playback link carries
 * its own, which the play routes check against this.
 */
export const requirePlaySession = (auth: Auth, db: Database) =>
  createMiddleware<{ Variables: PlaySessionVariables }>(async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (session) {
      c.set("sessionId", session.session.id);
      c.set("who", { kind: "member", userId: session.user.id });
      await next();
      return;
    }
    const guest = await guestSessionOf(db, c);
    if (!guest) throw new HTTPException(401, { message: "Sign in to continue" });
    c.set("sessionId", guest.id);
    c.set("who", { kind: "guest", guestId: guest.guestId, organisationId: guest.organisationId });
    await next();
  });

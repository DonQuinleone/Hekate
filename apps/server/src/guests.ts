import { createHash, randomBytes } from "node:crypto";
import { type Database, inOrg, schema } from "@hekate/db";
import { workspaceSettingsOf } from "@hekate/shared";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { Actor, GuestActor } from "./access.ts";
import type { Auth } from "./auth.ts";
import {
  checkGuestCode,
  GUEST_CODE_MS,
  GUEST_CODE_TRIES,
  hashGuestCode,
  mayResend,
  newGuestCode,
} from "./guest-code.ts";
import { assertSecondFactor, organisationFor, type SecondFactorRule } from "./tenancy.ts";

const { guests, guestLinks, guestSessions, organisations } = schema;

const DAY_MS = 24 * 60 * 60 * 1000;
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
 * recent one works. It lasts as long as the workspace's settings say. Returns the token, which
 * goes in the email and nowhere else, and the days it works for.
 */
export async function issueGuestLink(
  db: Database,
  organisationId: string,
  guestId: string,
  now = new Date(),
) {
  const { token, hash } = newToken();
  const days = await db.transaction(async (tx) => {
    // One issue at a time per guest, so two sends cannot leave two working links.
    const [guest] = await tx
      .select({ id: guests.id })
      .from(guests)
      .where(inOrg(guests, organisationId, eq(guests.id, guestId)))
      .for("update");
    if (!guest) throw new Error("No such guest to send a link to");
    const [workspace] = await tx
      .select({ settings: organisations.settings })
      .from(organisations)
      .where(eq(organisations.id, organisationId));
    const { guestLinkDays } = workspaceSettingsOf(workspace?.settings);
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
      expiresAt: new Date(now.getTime() + guestLinkDays * DAY_MS),
    });
    return guestLinkDays;
  });
  return { token, days };
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** A session for a guest whose link was just spent, in the same transaction. */
async function startSession(tx: Tx, link: { organisationId: string; guestId: string }, now: Date) {
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
  return { row, token: session.token };
}

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
    const { row, token: cookie } = await startSession(tx, link, now);
    await andThen(tx, row);
    return { session: row, token: cookie };
  });
}

/** A link that still works, locked for the rest of the transaction; null otherwise. */
async function usableLink(tx: Tx, token: string, now: Date) {
  const [link] = await tx
    .select()
    .from(guestLinks)
    .where(
      and(
        eq(guestLinks.tokenHash, hashToken(token)),
        isNull(guestLinks.usedAt),
        isNull(guestLinks.revokedAt),
        gt(guestLinks.expiresAt, now),
      ),
    )
    .for("update");
  return link ?? null;
}

/**
 * How a link opens: by itself, or with a code as well (the workspace's setting). Null for a
 * link that no longer works.
 */
export async function verificationFor(db: Database, token: string, now = new Date()) {
  const [row] = await db
    .select({ settings: organisations.settings })
    .from(guestLinks)
    .innerJoin(organisations, eq(organisations.id, guestLinks.organisationId))
    .where(
      and(
        eq(guestLinks.tokenHash, hashToken(token)),
        isNull(guestLinks.usedAt),
        isNull(guestLinks.revokedAt),
        gt(guestLinks.expiresAt, now),
      ),
    );
  return row ? workspaceSettingsOf(row.settings).guestVerification : null;
}

/**
 * A new code for a guest opening their link, without spending it: the link opens only once
 * the code comes back. Null for a link that no longer works; "wait" or "limit" when another
 * may not go out yet, or at all. Only the code's hash is kept. `deliver` mails it and logs it
 * in the same transaction: if either fails, no code is issued and none of the five is used.
 */
export async function newGuestCodeFor(
  db: Database,
  token: string,
  deliver: (
    tx: Tx,
    sent: { code: string; organisationId: string; guestId: string; email: string },
  ) => Promise<void>,
  now = new Date(),
) {
  return db.transaction(async (tx) => {
    const link = await usableLink(tx, token, now);
    if (!link) return null;
    const [guest] = await tx
      .select({ email: guests.email })
      .from(guests)
      .where(inOrg(guests, link.organisationId, eq(guests.id, link.guestId)));
    if (!guest) return null;
    const who = { organisationId: link.organisationId, guestId: link.guestId, email: guest.email };
    const may = mayResend(link, now);
    if (may !== "send") return { status: may, ...who };
    const code = newGuestCode();
    await tx
      .update(guestLinks)
      .set({
        codeHash: hashGuestCode(link.id, code),
        codeSentAt: now,
        codeExpiresAt: new Date(now.getTime() + GUEST_CODE_MS),
        codeAttempts: 0,
        codesSent: link.codesSent + 1,
      })
      .where(inOrg(guestLinks, link.organisationId, eq(guestLinks.id, link.id)));
    await deliver(tx, { code, ...who });
    return { status: "sent" as const, ...who };
  });
}

/**
 * A guest's code against the one sent for their link. Right: the link is spent and a session
 * starts, as with the link alone (`signedIn` logs it in the same transaction). Otherwise it
 * says why not, and `refused` logs that in the same transaction; a wrong code's try is counted
 * there too, so the count and its log entry are kept together or not at all.
 */
export async function verifyGuestCode(
  db: Database,
  token: string,
  code: string,
  log: {
    signedIn: (tx: Tx, session: typeof guestSessions.$inferSelect) => Promise<void>;
    refused: (
      tx: Tx,
      who: { organisationId: string; guestId: string },
      reason: Exclude<ReturnType<typeof checkGuestCode>, "ok">,
    ) => Promise<void>;
  },
  now = new Date(),
) {
  return db.transaction(async (tx) => {
    const link = await usableLink(tx, token, now);
    if (!link) return { status: "gone" as const };
    const who = { organisationId: link.organisationId, guestId: link.guestId };
    const check = checkGuestCode(link, code, now);
    if (check === "wrong") {
      await tx
        .update(guestLinks)
        .set({ codeAttempts: link.codeAttempts + 1 })
        .where(inOrg(guestLinks, link.organisationId, eq(guestLinks.id, link.id)));
      await log.refused(tx, who, check);
      return { status: "wrong" as const, left: GUEST_CODE_TRIES - link.codeAttempts - 1, ...who };
    }
    if (check !== "ok") {
      await log.refused(tx, who, check);
      return { status: check, ...who };
    }
    await tx
      .update(guestLinks)
      .set({ usedAt: now, codeHash: null })
      .where(inOrg(guestLinks, link.organisationId, eq(guestLinks.id, link.id)));
    const { row, token: cookie } = await startSession(tx, link, now);
    await log.signedIn(tx, row);
    return { status: "ok" as const, session: row, token: cookie };
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
export const requireViewer = (auth: Auth, db: Database, rule: SecondFactorRule) =>
  createMiddleware<{ Variables: ViewerVariables }>(async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (session) {
      const membership = await organisationFor(db, session.user.id, session.session.id);
      await assertSecondFactor(db, session.session.id, membership, rule);
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

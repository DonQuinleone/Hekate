import { type Database, schema } from "@hekate/db";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { type Audit, requestInfo } from "../audit.ts";
import { clearGuestCookie, guestSessionOf, setGuestCookie, useGuestLink } from "../guests.ts";
import { guestReviews } from "./reviews.ts";

const { organisations, guestSessions } = schema;

export interface GuestRouteDeps {
  db: Database;
  audit: Audit;
  publicUrl: string;
  trustProxy: boolean;
}

/**
 * `/api/guest`: a guest reviewer's side of signing in (docs/security.md). Public: the magic
 * link is the credential, exchanged once for a session bound to this browser.
 */
export const guestRoutes = (deps: GuestRouteDeps) => {
  const secure = deps.publicUrl.startsWith("https://");
  const profile = async (organisationId: string, guestId: string) => {
    const [organisation] = await deps.db
      .select({ name: organisations.name })
      .from(organisations)
      .where(eq(organisations.id, organisationId));
    return {
      organisation: organisation?.name ?? null,
      reviews: await guestReviews(deps.db, organisationId, guestId),
    };
  };

  return new Hono()
    .post(
      "/sessions",
      zValidator("json", z.object({ token: z.string().min(16).max(128) })),
      async (c) => {
        const used = await useGuestLink(deps.db, c.req.valid("json").token);
        // One answer for unknown, used, revoked and expired links: nothing to learn from it.
        if (!used) {
          throw new HTTPException(410, {
            message:
              "This link has been used or has expired. Ask whoever invited you to send a new one.",
          });
        }
        const { session, token } = used;
        setGuestCookie(c, token, secure);
        await deps.audit.record(
          session.organisationId,
          await deps.audit.guest(session.guestId),
          { action: "guest.sign_in" },
          requestInfo(c, deps.trustProxy),
        );
        return c.json(
          {
            guest: { id: session.guestId },
            ...(await profile(session.organisationId, session.guestId)),
          },
          201,
        );
      },
    )
    .get("/me", async (c) => {
      const guest = await guestSessionOf(deps.db, c);
      if (!guest)
        throw new HTTPException(401, { message: "Open the link in your email to continue" });
      await deps.db
        .update(guestSessions)
        .set({ lastSeenAt: new Date() })
        .where(eq(guestSessions.id, guest.id));
      return c.json({
        guest: { id: guest.guestId, name: guest.name, email: guest.email, label: guest.label },
        ...(await profile(guest.organisationId, guest.guestId)),
      });
    })
    .post("/sign-out", async (c) => {
      const guest = await guestSessionOf(deps.db, c);
      if (guest) {
        await deps.db
          .update(guestSessions)
          .set({ revokedAt: new Date() })
          .where(eq(guestSessions.id, guest.id));
      }
      clearGuestCookie(c);
      return c.body(null, 204);
    });
};

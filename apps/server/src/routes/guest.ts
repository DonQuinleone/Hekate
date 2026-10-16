import { type Database, inOrg, schema } from "@hekate/db";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { type Audit, requestInfo } from "../audit.ts";
import { CodedException } from "../errors.ts";
import { maskEmail } from "../guest-code.ts";
import {
  clearGuestCookie,
  guestSessionOf,
  newGuestCodeFor,
  setGuestCookie,
  useGuestLink,
  verificationFor,
  verifyGuestCode,
} from "../guests.ts";
import { type Mailer, sendEmail } from "../mail.ts";
import { guestReviews } from "./reviews.ts";

const { organisations, guestSessions } = schema;

export interface GuestRouteDeps {
  db: Database;
  audit: Audit;
  mailer: Mailer;
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

  const gone = () =>
    new CodedException(
      410,
      "link_gone",
      "This link has been used or has expired. Ask whoever invited you to send a new one.",
    );
  const tokenBody = z.object({ token: z.string().min(16).max(128) });

  /**
   * Send a code for a link, where the workspace asks for one. On opening the link a code goes
   * out unless one went out moments ago (a reload); asked for again, a refusal says why.
   */
  const sendCode = async (c: Context, token: string, asked: boolean) => {
    const sent = await newGuestCodeFor(deps.db, token);
    if (!sent) throw gone();
    if (sent.status === "sent") {
      const [workspace] = await deps.db
        .select({ name: organisations.name })
        .from(organisations)
        .where(eq(organisations.id, sent.organisationId));
      await sendEmail(deps.mailer, sent.email, {
        workspace: workspace?.name,
        subject: `${sent.code} is your code to open your review`,
        heading: "Your code to open the review",
        body: [
          `Type ${sent.code} where you opened your link. It lasts ten minutes and works once.`,
          "The link was opened in a browser. If that was not you, ignore this: without the code, the link opens nothing.",
        ],
        foot: "You get this because a review was sent to this address.",
      });
      await deps.audit.record(
        sent.organisationId,
        await deps.audit.guest(sent.guestId),
        { action: "guest.code_sent" },
        requestInfo(c, deps.trustProxy),
      );
    } else if (asked) {
      throw sent.status === "wait"
        ? new CodedException(429, "code_wait", "A code has just been sent. Wait a moment.")
        : new CodedException(
            429,
            "code_limit",
            "No more codes for this link. Ask whoever invited you to send a new one.",
          );
    }
    return c.json({ verify: "code" as const, sentTo: maskEmail(sent.email) }, 202);
  };

  return (
    new Hono()
      .post("/sessions", zValidator("json", tokenBody), async (c) => {
        const { token } = c.req.valid("json");
        // Where the workspace asks for a code, the link alone opens nothing: a code goes out.
        if ((await verificationFor(deps.db, token)) === "code") return sendCode(c, token, false);
        // The sign-in is logged in the transaction that spends the link.
        const used = await useGuestLink(deps.db, token, async (tx, session) => {
          await deps.audit.record(
            session.organisationId,
            await deps.audit.guest(session.guestId),
            { action: "guest.sign_in" },
            requestInfo(c, deps.trustProxy),
            tx,
          );
        });
        // One answer for unknown, used, revoked and expired links: nothing to learn from it.
        if (!used) throw gone();
        setGuestCookie(c, used.token, secure);
        return c.json(
          {
            guest: { id: used.session.guestId },
            ...(await profile(used.session.organisationId, used.session.guestId)),
          },
          201,
        );
      })
      // Another code, when the first did not arrive or ran out.
      .post("/sessions/code", zValidator("json", tokenBody), async (c) =>
        sendCode(c, c.req.valid("json").token, true),
      )
      // The code from the email: right, and the link opens as it would alone.
      .post(
        "/sessions/verify",
        zValidator(
          "json",
          tokenBody.extend({
            code: z
              .string()
              .max(12)
              .regex(/^[\d ]+$/),
          }),
        ),
        async (c) => {
          const { token, code } = c.req.valid("json");
          const info = requestInfo(c, deps.trustProxy);
          const result = await verifyGuestCode(deps.db, token, code, async (tx, session) => {
            await deps.audit.record(
              session.organisationId,
              await deps.audit.guest(session.guestId),
              { action: "guest.sign_in", details: { verified: "code" } },
              info,
              tx,
            );
          });
          if (result.status === "ok") {
            setGuestCookie(c, result.token, secure);
            return c.json(
              {
                guest: { id: result.session.guestId },
                ...(await profile(result.session.organisationId, result.session.guestId)),
              },
              201,
            );
          }
          if (result.status === "gone") throw gone();
          // Every try that fails is in the access log, with why.
          await deps.audit.record(
            result.organisationId,
            await deps.audit.guest(result.guestId),
            { action: "guest.code_failed", details: { reason: result.status } },
            info,
          );
          if (result.status === "wrong")
            throw new CodedException(
              400,
              "code_wrong",
              result.left > 0
                ? "That code is not right. Check the latest email and try again."
                : "That code is not right, and that was the last try. Send another code.",
            );
          if (result.status === "expired")
            throw new CodedException(410, "code_expired", "That code has expired. Send another.");
          if (result.status === "too_many")
            throw new CodedException(429, "code_tries", "Too many tries. Send another code.");
          throw new CodedException(400, "code_none", "Send a code first.");
        },
      )
      .get("/me", async (c) => {
        const guest = await guestSessionOf(deps.db, c);
        if (!guest)
          throw new HTTPException(401, { message: "Open the link in your email to continue" });
        await deps.db
          .update(guestSessions)
          .set({ lastSeenAt: new Date() })
          .where(inOrg(guestSessions, guest.organisationId, eq(guestSessions.id, guest.id)));
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
            .where(inOrg(guestSessions, guest.organisationId, eq(guestSessions.id, guest.id)));
        }
        clearGuestCookie(c);
        return c.body(null, 204);
      })
  );
};

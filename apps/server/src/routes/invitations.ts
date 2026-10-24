import { type Database, schema } from "@hekate/db";
import { acceptInvitationInput } from "@hekate/shared";
import { and, eq, gt, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Auth } from "../auth.ts";
import { hashInvitationToken } from "../invitation-token.ts";
import { zValidator } from "../openapi/validator.ts";
import { assertMemberRoom } from "../usage.ts";

const { invitations, organisations, users, members } = schema;
const tokenParam = zValidator("param", z.object({ token: z.string().min(20).max(100) }));

type Status = "valid" | "expired" | "accepted" | "revoked";

async function find(db: Database, token: string) {
  const [row] = await db
    .select({ invitation: invitations, organisationName: organisations.name })
    .from(invitations)
    .innerJoin(organisations, eq(invitations.organisationId, organisations.id))
    .where(eq(invitations.tokenHash, hashInvitationToken(token)));
  if (!row) return undefined;
  const { invitation } = row;
  const status: Status = invitation.acceptedAt
    ? "accepted"
    : invitation.revokedAt
      ? "revoked"
      : invitation.expiresAt <= new Date()
        ? "expired"
        : "valid";
  return { ...row, status };
}

/** Public routes for someone holding an invitation link. */
export const invitationRoutes = (db: Database, auth: Auth) =>
  new Hono()
    .get("/:token", tokenParam, async (c) => {
      const found = await find(db, c.req.valid("param").token);
      if (!found) throw new HTTPException(404, { message: "This invitation link is not valid" });
      const [account] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, found.invitation.email));
      return c.json({
        organisation: found.organisationName,
        email: found.invitation.email,
        role: found.invitation.role,
        status: found.status,
        hasAccount: Boolean(account),
      });
    })
    .post("/:token/accept", tokenParam, zValidator("json", acceptInvitationInput), async (c) => {
      const { token } = c.req.valid("param");
      const input = c.req.valid("json");
      const found = await find(db, token);
      if (!found) throw new HTTPException(404, { message: "This invitation link is not valid" });
      if (found.status !== "valid")
        throw new HTTPException(410, {
          message: `This invitation has ${found.status === "expired" ? "expired" : `been ${found.status}`}`,
        });
      const { invitation } = found;
      // Refused before an account is made for it; checked again as the place is taken.
      await db.transaction((tx) => assertMemberRoom(tx, invitation.organisationId, "accepting"));

      const [existing] = await db.select().from(users).where(eq(users.email, invitation.email));
      let userId: string;
      let signInCookies: string[] = [];
      if (existing) {
        // An existing account accepts while signed in as that account.
        const session = await auth.api.getSession({ headers: c.req.raw.headers });
        if (!session || session.user.id !== existing.id) {
          throw new HTTPException(401, {
            message: `Sign in as ${invitation.email} to accept this invitation`,
          });
        }
        userId = existing.id;
      } else {
        if (!input.name || !input.password) {
          throw new HTTPException(400, {
            message: "Enter your name and a password of at least 12 characters",
          });
        }
        const ctx = await auth.$context;
        const user = await ctx.internalAdapter.createUser(
          { name: input.name, email: invitation.email, emailVerified: true },
          { method: "admin" },
        );
        await ctx.internalAdapter.linkAccount({
          userId: user.id,
          providerId: "credential",
          accountId: user.id,
          password: await ctx.password.hash(input.password),
        });
        userId = user.id;
      }

      await db
        .transaction(async (tx) => {
          // Room under the member limit (#175), first: a refusal leaves the link usable once
          // someone has left or the limit is raised.
          await assertMemberRoom(tx, invitation.organisationId, "accepting");
          // Claim the invitation atomically so a link can only be used once.
          const [claimed] = await tx
            .update(invitations)
            .set({ acceptedAt: new Date() })
            .where(
              and(
                eq(invitations.id, invitation.id),
                isNull(invitations.acceptedAt),
                isNull(invitations.revokedAt),
                gt(invitations.expiresAt, new Date()),
              ),
            )
            .returning({ id: invitations.id });
          if (!claimed)
            throw new HTTPException(410, { message: "This invitation has already been used" });
          await tx
            .insert(members)
            .values({ organisationId: invitation.organisationId, userId, role: invitation.role })
            .onConflictDoNothing();
        })
        .catch(async (error: unknown) => {
          // Refused once its account was made (the last place went between the checks, say):
          // the account goes too, so a later try is a first one again.
          if (!existing) await db.delete(users).where(eq(users.id, userId));
          throw error;
        });

      if (!existing && input.password) {
        const signIn = await auth.api.signInEmail({
          body: { email: invitation.email, password: input.password },
          headers: c.req.raw.headers,
          asResponse: true,
        });
        signInCookies = signIn.headers.getSetCookie();
      }
      // Make the new organisation the active one for this session.
      const session = signInCookies.length
        ? undefined
        : await auth.api.getSession({ headers: c.req.raw.headers });
      if (session) {
        await db
          .update(schema.authSessions)
          .set({ activeOrganisationId: invitation.organisationId })
          .where(eq(schema.authSessions.id, session.session.id));
      }
      const res = c.json({ organisationId: invitation.organisationId }, 201);
      for (const cookie of signInCookies) res.headers.append("set-cookie", cookie);
      return res;
    });

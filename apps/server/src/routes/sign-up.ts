import { type Database, schema } from "@hekate/db";
import {
  SIGN_UP_LINK_MS,
  type SignUpInfo,
  type SignUpLink,
  signUpAllowed,
  signUpInput,
  signUpRefusal,
  signUpStartInput,
  signUpTokenParam,
  trialEnd,
} from "@hekate/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requestInfo } from "../audit.ts";
import type { Auth } from "../auth.ts";
import { CodedException } from "../errors.ts";
import { type Subdomains, workspaceAddress } from "../hosts.ts";
import { recordInstanceEvent } from "../instance-events.ts";
import type { InstanceSettingsStore } from "../instance-settings.ts";
import { type Mailer, sendEmail } from "../mail.ts";
import { zValidator } from "../openapi/validator.ts";
import { newAccountPassword } from "../passwords.ts";
import { assignPlan } from "../plans.ts";
import { admit, type LimitRule, tooMany } from "../rate-limit.ts";
import { claimSignUpLink, findSignUpLink, newSignUpLink, trialPlan } from "../sign-up.ts";

export interface SignUpDeps {
  db: Database;
  auth: Auth;
  settings: InstanceSettingsStore;
  mailer: Mailer;
  publicUrl: string;
  /** The billing module is on: a workspace that signs up starts a trial (#177). */
  billing: boolean;
  leakCheck: boolean;
  trustProxy: boolean;
  subdomains: Subdomains | null;
}

/**
 * Abuse limits (#184): links asked for, by address and by email, and workspaces made, by
 * address and by email. Generous for a person, tight for a script.
 */
const limits = {
  linksByAddress: { max: 5, windowMs: 60 * 60_000 },
  linksByEmail: { max: 3, windowMs: 60 * 60_000 },
  madeByAddress: { max: 10, windowMs: 60 * 60_000 },
  madeByEmail: { max: 3, windowMs: 24 * 60 * 60_000 },
} satisfies Record<string, LimitRule>;

const refused = (mode: Parameters<typeof signUpRefusal>[0]) =>
  new CodedException(403, "sign_up_closed", signUpRefusal(mode));

/**
 * `/api/sign-up` (#184): making a workspace without an operator, as the instance's registration
 * allows. Open sign-up mails a link that confirms the email; an operator's invitation is such a
 * link. At the link, its holder names the workspace and its subdomain and, without an account,
 * makes one; the workspace starts from the instance's defaults, with a trial when billing is on.
 */
export const signUpRoutes = (deps: SignUpDeps) => {
  const { db } = deps;
  const base = deps.publicUrl.replace(/\/$/, "");
  const subdomains = deps.subdomains ? deps.subdomains.url.host : null;
  /** The trial a workspace made now starts with, in days; null for none. */
  const trialDays = async () => {
    if (!deps.billing) return null;
    const days = (await deps.settings.get()).billing.trialDays;
    return days > 0 && (await trialPlan(db)) ? days : null;
  };
  return (
    new Hono()
      .get("/", async (c) => {
        const { mode } = (await deps.settings.get()).registration;
        return c.json({
          mode,
          trialDays: mode === "closed" ? null : await trialDays(),
          subdomains,
        } satisfies SignUpInfo);
      })
      // A link to make a workspace, to the email given, with open sign-up. The answer is the
      // same whether or not the email has an account: the link says what to do either way.
      .post("/start", zValidator("json", signUpStartInput), async (c) => {
        const { mode } = (await deps.settings.get()).registration;
        if (mode !== "open") throw refused(mode);
        const email = c.req.valid("json").email.toLowerCase();
        const address = requestInfo(c, deps.trustProxy).ipAddress ?? "unknown";
        for (const [key, rule] of [
          [`sign-up-link:${address}`, limits.linksByAddress],
          [`sign-up-link:${email}`, limits.linksByEmail],
        ] as const) {
          const { allowed, retryAfter } = await admit(db, key, rule);
          if (!allowed)
            return tooMany(
              c,
              retryAfter,
              "Several links were asked for moments ago. Try again in an hour.",
            );
        }
        const token = await newSignUpLink(db, {
          email,
          invitedBy: null,
          lifetimeMs: SIGN_UP_LINK_MS,
        });
        await sendEmail(deps.mailer, email, {
          subject: "Make your Hekate workspace",
          heading: "Confirm your email",
          body: [
            "Open the link to name your workspace and choose its address. It lasts a day and works once.",
          ],
          action: { label: "Make a workspace", url: `${base}/sign-up/${token}` },
          foot: "If you did not ask, ignore this: nothing is made without the link.",
        });
        return c.json({ sent: true }, 202);
      })
      .get("/:token", zValidator("param", signUpTokenParam), async (c) => {
        const link = await findSignUpLink(db, c.req.valid("param").token);
        if (!link) throw new HTTPException(404, { message: "This link is not valid" });
        const { mode } = (await deps.settings.get()).registration;
        const allowed = signUpAllowed(mode, link.invitedBy !== null);
        const [account] = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.email, link.email));
        return c.json({
          email: link.email,
          invited: link.invitedBy !== null,
          expired: link.expiresAt <= new Date(),
          hasAccount: Boolean(account),
          allowed,
          refusal: allowed ? null : signUpRefusal(mode),
          trialDays: allowed ? await trialDays() : null,
          subdomains,
        } satisfies SignUpLink);
      })
      // Makes the workspace, and the account when there is none, at the link.
      .post(
        "/:token",
        zValidator("param", signUpTokenParam),
        zValidator("json", signUpInput),
        async (c) => {
          const input = c.req.valid("json");
          const link = await findSignUpLink(db, c.req.valid("param").token);
          if (!link) throw new HTTPException(404, { message: "This link is not valid" });
          const settings = await deps.settings.get();
          const { mode } = settings.registration;
          if (!signUpAllowed(mode, link.invitedBy !== null)) throw refused(mode);
          if (link.expiresAt <= new Date())
            throw new CodedException(
              410,
              "link_expired",
              "This link has expired. Ask for another.",
            );
          const address = requestInfo(c, deps.trustProxy).ipAddress ?? "unknown";
          for (const [key, rule] of [
            [`sign-up-made:${address}`, limits.madeByAddress],
            [`sign-up-made:${link.email}`, limits.madeByEmail],
          ] as const) {
            const { allowed, retryAfter } = await admit(db, key, rule);
            if (!allowed)
              return tooMany(
                c,
                retryAfter,
                "Several workspaces were made from here lately. Try again later.",
              );
          }

          const [existing] = await db
            .select({ id: schema.users.id })
            .from(schema.users)
            .where(eq(schema.users.email, link.email));
          let userId: string;
          if (existing) {
            // An account that exists makes the workspace while signed in as itself.
            const session = await deps.auth.api.getSession({ headers: c.req.raw.headers });
            if (session?.user.id !== existing.id)
              throw new HTTPException(401, {
                message: `Sign in as ${link.email} to make the workspace`,
              });
            userId = existing.id;
          } else {
            if (!input.name || !input.password)
              throw new HTTPException(400, {
                message: "Enter your name and a password of at least 12 characters",
              });
            const ctx = await deps.auth.$context;
            // Made here, outside Better Auth's sign-up route: checked and hashed directly.
            const password = await newAccountPassword(input.password, deps.leakCheck);
            // The link confirmed the email: it came to that address.
            const user = await ctx.internalAdapter
              .createUser(
                { name: input.name, email: link.email, emailVerified: true },
                { method: "admin" },
              )
              .catch(() => {
                throw new CodedException(
                  409,
                  "account_exists",
                  `${link.email} has an account now. Sign in, then open the link again.`,
                );
              });
            await ctx.internalAdapter.linkAccount({
              userId: user.id,
              providerId: "credential",
              accountId: user.id,
              password,
            });
            userId = user.id;
          }

          const days = await trialDays();
          const trialEndsAt = days ? trialEnd(days, new Date()) : null;
          const { defaults } = settings;
          const organisation = await db
            .transaction(async (tx) => {
              // The link is used as the workspace is made, or not at all.
              if (!(await claimSignUpLink(tx, link.id)))
                throw new CodedException(410, "link_used", "This link has been used already.");
              const [made] = await tx
                .insert(schema.organisations)
                .values({
                  name: input.workspace,
                  slug: input.slug,
                  settings: { guestLinkDays: defaults.guestLinkDays },
                  storageQuota: defaults.storageQuota,
                  memberLimit: defaults.memberLimit,
                })
                .onConflictDoNothing({ target: schema.organisations.slug })
                .returning({ id: schema.organisations.id });
              if (!made)
                throw new CodedException(409, "slug_taken", "Another workspace has that subdomain");
              await tx
                .insert(schema.members)
                .values({ organisationId: made.id, userId, role: "owner" });
              const plan = trialEndsAt ? await trialPlan(tx) : undefined;
              if (plan && trialEndsAt)
                await assignPlan(tx, made.id, {
                  planId: plan.id,
                  status: "trial",
                  trialEndsAt: trialEndsAt.toISOString(),
                  renewsAt: null,
                });
              await recordInstanceEvent(tx, {
                actorId: userId,
                action: "workspace.signed_up",
                target: input.workspace,
                details: {
                  organisationId: made.id,
                  slug: input.slug,
                  owner: link.email,
                  invited: link.invitedBy !== null,
                  trialEndsAt: plan ? (trialEndsAt?.toISOString() ?? null) : null,
                },
                ipAddress: address === "unknown" ? null : address,
              });
              return made;
            })
            .catch(async (error: unknown) => {
              // Refused once its account was made (the subdomain taken meanwhile, say): the
              // account goes too, so the link, still good, is a first try again.
              if (!existing) await db.delete(schema.users).where(eq(schema.users.id, userId));
              throw error;
            });

          let cookies: string[] = [];
          if (!existing && input.password) {
            const signIn = await deps.auth.api.signInEmail({
              body: { email: link.email, password: input.password },
              headers: c.req.raw.headers,
              asResponse: true,
            });
            cookies = signIn.headers.getSetCookie();
          } else {
            // Signed in already: the new workspace becomes the one this session is in.
            const session = await deps.auth.api.getSession({ headers: c.req.raw.headers });
            if (session)
              await db
                .update(schema.authSessions)
                .set({ activeOrganisationId: organisation.id })
                .where(eq(schema.authSessions.id, session.session.id));
          }
          const res = c.json(
            {
              organisationId: organisation.id,
              address: deps.subdomains ? workspaceAddress(deps.subdomains, input.slug) : null,
              trialEndsAt: trialEndsAt?.toISOString() ?? null,
            },
            201,
          );
          for (const cookie of cookies) res.headers.append("set-cookie", cookie);
          return res;
        },
      )
  );
};

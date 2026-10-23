import { type Database, inOrg, schema } from "@hekate/db";
import { directorySignInInput, roleForGroups } from "@hekate/shared";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { and, eq, sql } from "drizzle-orm";
import type { Audit } from "./audit.ts";
import { lockedAttempts } from "./auth-log.ts";
import { authenticate, directoryConfig } from "./directory.ts";
import type { Keyring } from "./keyring.ts";
import { waitMessage } from "./lockout.ts";
import { admitAttempt, clearAttempts } from "./sign-in.ts";
import { memberRoom } from "./usage.ts";

const { authAccounts, members, organisations, users } = schema;

/** The account's sign-in record for one workspace's directory: its DN there. */
const providerFor = (organisationId: string) => `directory:${organisationId}`;

/**
 * `POST /api/auth/sign-in/directory`: a workspace's directory username and password (#38).
 * The directory checks the password; the first sign-in makes the account and the membership,
 * and every sign-in sets the role its groups give (owners stay owners). A directory vouches
 * for its own workspace only: an address that already has an account here, not yet signed in
 * through this directory, is refused rather than taken over. Wrong passwords are slowed and
 * locked as passwords are (lockout.ts).
 */
export const directorySignIn = (deps: { db: Database; keyring?: Keyring; audit?: Audit }) =>
  ({
    id: "directory",
    endpoints: {
      signInDirectory: createAuthEndpoint(
        "/sign-in/directory",
        { method: "POST", body: directorySignInInput },
        async (ctx) => {
          const { db, keyring, audit } = deps;
          const { workspace, username, password } = ctx.body;
          const [organisation] = await db
            .select({ id: organisations.id })
            .from(organisations)
            .where(eq(organisations.slug, workspace.toLowerCase()));
          const config =
            organisation && keyring ? await directoryConfig(db, keyring, organisation.id) : null;
          if (!organisation || !config?.enabled)
            throw new APIError("BAD_REQUEST", {
              message: "That workspace does not sign in with a directory.",
            });

          const attempts = `directory:${organisation.id}:${username.toLowerCase()}`;
          const admitted = await admitAttempt(db, attempts);
          // Locked now, or this try reaches the lock: its refusal is logged as a lockout (#157).
          if (ctx.request && (admitted.locks || (admitted.wait > 0 && admitted.locked)))
            lockedAttempts.add(ctx.request);
          if (admitted.wait > 0)
            throw new APIError(
              "TOO_MANY_REQUESTS",
              { message: waitMessage(admitted.wait, admitted.locked) },
              { "Retry-After": String(Math.ceil(admitted.wait / 1000)) },
            );
          const person = await authenticate(config, username, password).catch(() => {
            throw new APIError("SERVICE_UNAVAILABLE", {
              message: "The directory could not be reached. Try again, or ask an admin.",
            });
          });
          if (!person)
            throw new APIError("UNAUTHORIZED", {
              message: "That username and password do not match.",
            });
          if (!person.email)
            throw new APIError("FORBIDDEN", {
              message: "Your directory entry has no email address. Ask an admin to add one.",
            });
          await clearAttempts(db, attempts);

          const provider = providerFor(organisation.id);
          const role = roleForGroups(person.groups, config.roles);
          // The account, its link to this directory and the membership are made together, one
          // sign-in per address at a time: two first sign-ins at once make one account, and a
          // failure part-way leaves nothing to trip over on the next try.
          const email = person.email;
          const { userId, joined } = await db.transaction(async (tx) => {
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtext(${`directory-sign-in:${email}`}))`,
            );
            const [linked] = await tx
              .select({ userId: authAccounts.userId })
              .from(authAccounts)
              .where(
                and(eq(authAccounts.providerId, provider), eq(authAccounts.accountId, person.dn)),
              );
            let id = linked?.userId;
            if (!id) {
              const [existing] = await tx
                .select({ id: users.id })
                .from(users)
                .where(eq(sql`lower(${users.email})`, email));
              if (existing)
                throw new APIError("FORBIDDEN", {
                  message:
                    "An account with this address already exists. Sign in with its password or passkey instead.",
                });
              id = crypto.randomUUID();
              const now = new Date();
              await tx.insert(users).values({
                id,
                email,
                name: person.name ?? email,
                emailVerified: true,
                createdAt: now,
                updatedAt: now,
              });
              await tx.insert(authAccounts).values({
                id: crypto.randomUUID(),
                userId: id,
                providerId: provider,
                accountId: person.dn,
                createdAt: now,
                updatedAt: now,
              });
            }
            // The membership, and the role the groups give: never an owner's, which people set.
            const [membership] = await tx
              .select({ id: members.id, role: members.role })
              .from(members)
              .where(inOrg(members, organisation.id, eq(members.userId, id)));
            if (!membership) {
              // The workspace's member limit (#175): no account is kept for one refused.
              const refusal = await memberRoom(tx, organisation.id, "provisioning");
              if (refusal) throw new APIError("FORBIDDEN", { message: refusal });
              await tx
                .insert(members)
                .values({ organisationId: organisation.id, userId: id, role });
            } else if (membership.role !== "owner" && membership.role !== role)
              await tx
                .update(members)
                .set({ role })
                .where(inOrg(members, organisation.id, eq(members.id, membership.id)));
            return { userId: id, joined: !membership };
          });
          if (audit)
            await audit.record(organisation.id, await audit.member(userId), {
              action: "account.directory_sign_in",
              details: { role, joined },
            });

          const user = await ctx.context.internalAdapter.findUserById(userId);
          if (!user) throw new APIError("INTERNAL_SERVER_ERROR");
          const session = await ctx.context.internalAdapter.createSession(userId, false, {
            activeOrganisationId: organisation.id,
          });
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ user: { id: user.id, email: user.email, name: user.name } });
        },
      ),
    },
    rateLimit: [
      { pathMatcher: (path: string) => path === "/sign-in/directory", window: 60, max: 10 },
    ],
  }) satisfies BetterAuthPlugin;

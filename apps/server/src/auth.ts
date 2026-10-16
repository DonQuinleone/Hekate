import { type Database, schema } from "@hekate/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Mailer } from "./mail.ts";

export interface AuthOptions {
  db: Database;
  secret: string;
  baseURL: string;
  trustedOrigins?: string[];
  /** Relaxed limits for tests. */
  testing?: boolean;
  /** Sends the link that confirms a new email address; without it, addresses cannot change. */
  mailer?: Mailer;
}

/**
 * Better Auth with email and password. Public sign-up is closed: the first account is created by
 * first-run setup, later accounts by invitation. SSO, LDAP, passkeys and magic links plug in here
 * (issues 37, 38, 39, 24). See docs/security.md (Authentication).
 */
export function createAuth(options: AuthOptions) {
  return betterAuth({
    appName: "Hekate",
    secret: options.secret,
    baseURL: options.baseURL,
    basePath: "/api/auth",
    trustedOrigins: options.trustedOrigins ?? [],
    telemetry: { enabled: false },
    database: drizzleAdapter(options.db, {
      provider: "pg",
      schema: {
        user: schema.users,
        session: schema.authSessions,
        account: schema.authAccounts,
        verification: schema.authVerifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 256,
    },
    // A new address takes effect only once its owner follows the link sent to it.
    ...(options.mailer
      ? {
          emailVerification: {
            expiresIn: 60 * 60 * 24,
            sendVerificationEmail: async ({
              user,
              url,
            }: {
              user: { email: string };
              url: string;
            }) => {
              await options.mailer?.send({
                to: user.email,
                subject: "Confirm your new email address for Hekate",
                text: `Someone, probably you, asked for this address to be used to sign in to Hekate.\n\nTo confirm it, open this link within a day:\n${url}\n\nIf it was not you, ignore this message and nothing changes.`,
              });
            },
          },
          user: { changeEmail: { enabled: true } },
        }
      : {}),
    session: {
      expiresIn: 60 * 60 * 24 * 14,
      updateAge: 60 * 60 * 24,
      additionalFields: {
        activeOrganisationId: { type: "string", required: false, input: false },
      },
    },
    advanced: {
      cookiePrefix: "hekate",
      useSecureCookies: options.baseURL.startsWith("https://"),
      database: { generateId: () => crypto.randomUUID() },
    },
    rateLimit: {
      enabled: !options.testing,
      window: 60,
      max: 100,
      customRules: { "/sign-in/email": { window: 60, max: 10 } },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

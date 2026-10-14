import { type Database, schema } from "@hekate/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

export interface AuthOptions {
  db: Database;
  secret: string;
  baseURL: string;
  trustedOrigins?: string[];
  /** Relaxed limits for tests. */
  testing?: boolean;
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

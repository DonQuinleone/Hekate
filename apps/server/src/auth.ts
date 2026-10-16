import { type Database, schema } from "@hekate/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { emailOTP, haveIBeenPwned } from "better-auth/plugins";
import type { Audit } from "./audit.ts";
import { waitMessage } from "./lockout.ts";
import { type Mailer, sendEmail } from "./mail.ts";
import { admitAttempt, clearAttempts, logLockout, logToWorkspaces } from "./sign-in.ts";

export interface AuthOptions {
  db: Database;
  secret: string;
  baseURL: string;
  trustedOrigins?: string[];
  /** Relaxed limits for tests. */
  testing?: boolean;
  /** Sends the link that confirms a new email address; without it, addresses cannot change. */
  mailer?: Mailer;
  /** Where lockouts and password resets are logged, in each of the account's workspaces. */
  audit?: Audit;
  /**
   * Check new passwords against known breaches (Have I Been Pwned, by the first five
   * characters of a hash). On by default; an instance without internet access turns it off.
   */
  leakCheck?: boolean;
}

/** The base of the app's own links, for those in emails. */
const appBase = (baseURL: string) => baseURL.replace(/\/$/, "");

/**
 * Better Auth with email and password. Public sign-up is closed: the first account is created by
 * first-run setup, later accounts by invitation. SSO, LDAP, passkeys and magic links plug in here
 * (issues 37, 38, 39, 24). See docs/security.md (Authentication).
 */
export function createAuth(options: AuthOptions) {
  /** Sign-in requests whose attempt reached the lock, to log once they have failed. */
  const locking = new WeakSet<Request>();
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
      // A new password ends every session, wherever it was: whoever knew the old one is out.
      revokeSessionsOnPasswordReset: true,
    },
    plugins: [
      // A forgotten password: a six-digit code by email, with a link that carries it, both
      // lasting ten minutes and working once. Never a sign-in by email for members
      // (decision 025): that stays for guests.
      emailOTP({
        otpLength: 6,
        expiresIn: 10 * 60,
        allowedAttempts: 3,
        storeOTP: "hashed",
        disableSignUp: true,
        sendVerificationOTP: async ({ email, otp, type }) => {
          if (type !== "forget-password" || !options.mailer) return;
          const link = `${appBase(options.baseURL)}/sign-in?view=reset&email=${encodeURIComponent(email)}&code=${otp}`;
          await sendEmail(options.mailer, email, {
            subject: `${otp} is your code to set a new Hekate password`,
            heading: "Set a new password",
            body: [
              `Your code is ${otp}. Type it where you asked, or open the link. Both last ten minutes and work once.`,
            ],
            action: { label: "Set a new password", url: link },
            foot: "If you did not ask, ignore this: your password stays as it is.",
          });
        },
      }),
      haveIBeenPwned({
        enabled: options.leakCheck ?? !options.testing,
        customPasswordCompromisedMessage:
          "That password appears in known data breaches. Choose another one.",
      }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Members never sign in by an emailed code.
        if (
          ctx.path === "/sign-in/email-otp" ||
          (ctx.path === "/email-otp/send-verification-otp" && ctx.body?.type === "sign-in")
        ) {
          throw new APIError("FORBIDDEN", { message: "Sign in with your password." });
        }
        // Repeated guesses wait longer each time, then the account locks for a while. Each
        // attempt is counted as it is let in, so a burst cannot slip through together.
        if (ctx.path === "/sign-in/email" && typeof ctx.body?.email === "string") {
          const admitted = await admitAttempt(options.db, ctx.body.email);
          if (admitted.wait > 0) {
            throw new APIError(
              "TOO_MANY_REQUESTS",
              { message: waitMessage(admitted.wait, admitted.locked) },
              { "Retry-After": String(Math.ceil(admitted.wait / 1000)) },
            );
          }
          if (admitted.locks && ctx.request) locking.add(ctx.request);
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        const email = typeof ctx.body?.email === "string" ? ctx.body.email : null;
        if (!email) return;
        const returned = ctx.context.returned;
        const failed = isAPIError(returned);
        if (ctx.path === "/sign-in/email") {
          // Counted when let in; a success clears it, and a failure that locked is told.
          if (!failed) await clearAttempts(options.db, email);
          else if (ctx.request && locking.has(ctx.request) && options.audit)
            await logLockout(options.db, options.audit, email);
        }
        if (ctx.path === "/email-otp/reset-password" && !failed) {
          await clearAttempts(options.db, email);
          if (options.audit)
            await logToWorkspaces(options.db, options.audit, email, "account.password_reset");
        }
      }),
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
              if (!options.mailer) return;
              await sendEmail(options.mailer, user.email, {
                subject: "Confirm your new email address for Hekate",
                heading: "Confirm your new email address",
                body: [
                  "Someone, probably you, asked for this address to be used to sign in to Hekate. The link works for a day.",
                ],
                action: { label: "Confirm the address", url },
                foot: "If it was not you, ignore this message and nothing changes.",
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
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
        // A reset code is a key to the account: few to ask for, fewer to try.
        "/email-otp/request-password-reset": { window: 15 * 60, max: 5 },
        "/email-otp/reset-password": { window: 15 * 60, max: 10 },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

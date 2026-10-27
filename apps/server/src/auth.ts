import { passkey } from "@better-auth/passkey";
import { sso } from "@better-auth/sso";
import { type Database, schema } from "@hekate/db";
import {
  entitled,
  methodsFor,
  notEntitledMessage,
  rateLimits,
  type SessionFactor,
  type SignInMethod,
  signInMethodWords,
  workspaceSettingsOf,
} from "@hekate/shared";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { emailOTP, haveIBeenPwned, twoFactor } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import type { Audit } from "./audit.ts";
import { lockedAttempts, recordAuth, requestOf, signInMethodOf } from "./auth-log.ts";
import { directorySignIn } from "./directory-sign-in.ts";
import { passkeyOrigins, type Subdomains } from "./hosts.ts";
import type { Keyring } from "./keyring.ts";
import { waitMessage } from "./lockout.ts";
import { type Mailer, sendEmail } from "./mail.ts";
import { metrics } from "./metrics/index.ts";
import { workspacePlanOf } from "./plans.ts";
import {
  factorFor,
  hashedRecoveryCodes,
  hashRecoveryCode,
  methodFor,
  newRecoveryCodes,
} from "./second-factor.ts";
import {
  admitAttempt,
  clearAttempts,
  logForAccount,
  logLockout,
  logToWorkspaces,
} from "./sign-in.ts";
import { providerState, provision } from "./sso.ts";

export interface AuthOptions {
  db: Database;
  secret: string;
  baseURL: string;
  trustedOrigins?: string[];
  /** Workspace subdomains (#176): one session for the root and every workspace's host. */
  subdomains?: Subdomains | null;
  /** The billing module is on: a workspace's plan decides what it may sign in with (#177). */
  billing?: boolean;
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
  /** Opens a workspace directory's bind password, for directory sign-in (#38). */
  keyring?: Keyring;
  /** How many passkeys and hardware security keys one account may hold (MAX_PASSKEYS). */
  maxPasskeys?: number;
  /**
   * Identity providers on a private network the server may reach (SSO_TRUSTED_ORIGINS); public
   * ones need nothing.
   */
  ssoTrustedOrigins?: string[];
  /** Read the client address from X-Forwarded-For (behind Caddy), for the authentication log. */
  trustProxy?: boolean;
}

/** Better Auth's SSO routes Hekate does not use: providers are set in workspace settings. */
const ssoDisabledPaths = [
  "/sso/register",
  "/sso/update-provider",
  "/sso/delete-provider",
  "/sso/providers",
  "/sso/get-provider",
  "/sso/request-domain-verification",
  "/sso/verify-domain",
  "/sso/callback",
];

/** The provider a single sign-on request names, from its address or its body. */
const ssoProviderIn = (ctx: { path: string; params?: unknown; body?: unknown }) => {
  if (
    ctx.path === "/sso/callback/:providerId" ||
    ctx.path === "/sso/saml2/sp/acs/:providerId" ||
    ctx.path === "/sso/saml2/sp/metadata"
  ) {
    const params = ctx.params as { providerId?: unknown } | undefined;
    if (typeof params?.providerId === "string") return params.providerId;
  }
  return undefined;
};

/** The base of the app's own links, for those in emails. */
const appBase = (baseURL: string) => baseURL.replace(/\/$/, "");

/** How long a session lasts without use, in days. */
export const SESSION_DAYS = 14;

/**
 * Why signing in this way is refused, when it is: the account belongs to workspaces and none of
 * them takes this way in for it (decision 248). An account in no workspace yet (an operator, or
 * one being made) is never refused here.
 */
async function refusedEverywhere(
  db: Database,
  userId: string,
  method: SignInMethod,
): Promise<string | null> {
  const memberships = await db
    .select({ role: schema.members.role, settings: schema.organisations.settings })
    .from(schema.members)
    .innerJoin(schema.organisations, eq(schema.organisations.id, schema.members.organisationId))
    .where(eq(schema.members.userId, userId));
  if (memberships.length === 0) return null;
  const taken = memberships.some((m) =>
    methodsFor(workspaceSettingsOf(m.settings).signInMethods, m.role).includes(method),
  );
  if (taken) return null;
  return `Your workspace does not take signing in with ${signInMethodWords[method]}. Sign in another way.`;
}

/**
 * Better Auth with email and password. Public sign-up is closed: the first account is created by
 * first-run setup, later accounts by invitation. A code app or a passkey is the second factor,
 * and a passkey also signs in on its own; SSO, LDAP and magic links plug in here (issues 37,
 * 38, 24). See docs/security.md (Authentication).
 */
export function createAuth(options: AuthOptions) {
  const maxPasskeys = options.maxPasskeys ?? 5;
  /** Sign-in requests whose attempt reached the lock, to log once they have failed. */
  const locking = new WeakSet<Request>();
  /** Single sign-on, on a plan without it (#177), neither starts nor finishes. */
  const assertSsoEntitled = async (organisationId: string) => {
    const { entitlements } = await workspacePlanOf(
      options.db,
      organisationId,
      options.billing ?? false,
    );
    if (!entitled(entitlements, "sso"))
      throw new APIError("FORBIDDEN", { message: notEntitledMessage("sso") });
  };
  return betterAuth({
    appName: "Hekate",
    secret: options.secret,
    baseURL: options.baseURL,
    basePath: "/api/auth",
    trustedOrigins: [
      ...(options.trustedOrigins ?? []),
      ...(options.ssoTrustedOrigins ?? []),
      // Every workspace's host, with subdomains on (#176).
      ...(options.subdomains
        ? [`${options.subdomains.url.protocol}//*.${options.subdomains.url.host}`]
        : []),
    ],
    disabledPaths: ssoDisabledPaths,
    telemetry: { enabled: false },
    database: drizzleAdapter(options.db, {
      provider: "pg",
      schema: {
        user: schema.users,
        session: schema.authSessions,
        account: schema.authAccounts,
        verification: schema.authVerifications,
        twoFactor: schema.twoFactors,
        passkey: schema.passkeys,
        ssoProvider: schema.ssoProviders,
        rateLimit: schema.authRateLimits,
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
    // Signing in through a provider never joins an account that exists already (see sso.ts).
    account: { accountLinking: { disableImplicitLinking: true } },
    plugins: [
      // A workspace's single sign-on (OIDC or SAML): set by its admins, found by workspace.
      sso({
        fields: { organizationId: "organisationId" },
        providersLimit: 0,
        organizationProvisioning: { disabled: true },
        provisionUserOnEveryLogin: true,
        provisionUser: async ({ user, userInfo, provider }) =>
          provision(options.db, options.audit, {
            userId: user.id,
            providerId: provider.providerId,
            groups: userInfo.groups,
          }),
      }),
      // A workspace's directory (LDAP): its username and password sign in.
      directorySignIn({
        db: options.db,
        keyring: options.keyring,
        audit: options.audit,
        billing: options.billing ?? false,
      }),
      // Passkeys and hardware security keys (WebAuthn): sign in on their own, or confirm a
      // password sign-in, for this instance's address only. The root's host is the relying
      // party, so a key made on any workspace's host works on the others too (#176).
      passkey({
        rpID: new URL(options.baseURL).hostname,
        rpName: "Hekate",
        origin: passkeyOrigins(
          [appBase(options.baseURL), ...(options.trustedOrigins ?? [])],
          options.subdomains ?? null,
        ),
      }),
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
      // A second factor: a code app, with ten recovery codes kept only as keyed hashes. A
      // browser can be trusted for 30 days; ten wrong codes in a row lock it for 15 minutes.
      twoFactor({
        issuer: "Hekate",
        totpOptions: { digits: 6, period: 30 },
        backupCodeOptions: {
          amount: 10,
          customBackupCodesGenerate: () => newRecoveryCodes(),
          storeBackupCodes: hashedRecoveryCodes(options.secret),
        },
        trustDeviceMaxAge: 30 * 24 * 60 * 60,
        accountLockout: { enabled: true, maxFailedAttempts: 10, durationSeconds: 15 * 60 },
      }),
      haveIBeenPwned({
        enabled: options.leakCheck ?? !options.testing,
        customPasswordCompromisedMessage:
          "That password appears in known data breaches. Choose another one.",
      }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Single sign-on starts from a workspace's provider, named, and only while it is on;
        // never from the domain of an address, which any workspace could claim.
        if (ctx.path === "/sign-in/sso") {
          const body = (ctx.body ?? {}) as { providerId?: unknown };
          const provider =
            typeof body.providerId === "string"
              ? await providerState(options.db, body.providerId)
              : null;
          if (!provider?.enabled)
            throw new APIError("BAD_REQUEST", {
              message: "That workspace does not sign in with single sign-on.",
            });
          await assertSsoEntitled(provider.organisationId);
          return {
            context: {
              body: {
                providerId: body.providerId,
                callbackURL: (ctx.body as { callbackURL?: unknown }).callbackURL,
                errorCallbackURL: (ctx.body as { errorCallbackURL?: unknown }).errorCallbackURL,
              },
            },
          };
        }
        const via = ssoProviderIn(ctx);
        if (via) {
          const provider = await providerState(options.db, via);
          if (!provider?.enabled)
            throw new APIError("BAD_REQUEST", {
              message: "That workspace does not sign in with single sign-on.",
            });
          // Asked again as the provider answers: a plan changed meanwhile holds at once.
          await assertSsoEntitled(provider.organisationId);
        }
        // Up to the instance's limit of keys per account: asked when registration starts, and
        // again when the key is saved, so options fetched ahead of time cannot pass it.
        if (
          ctx.path === "/passkey/generate-register-options" ||
          ctx.path === "/passkey/verify-registration"
        ) {
          const session = await getSessionFromCtx(ctx);
          if (session) {
            const held = await options.db
              .select({ id: schema.passkeys.id })
              .from(schema.passkeys)
              .where(eq(schema.passkeys.userId, session.user.id));
            if (held.length >= maxPasskeys)
              throw new APIError("FORBIDDEN", {
                message: `${maxPasskeys} keys are registered, the most an account may hold. Remove one to add another.`,
              });
          }
        }
        // A recovery code is compared by its hash: typed in any case, with or without the dash.
        if (ctx.path === "/two-factor/verify-backup-code" && typeof ctx.body?.code === "string") {
          return {
            context: {
              body: { ...ctx.body, code: hashRecoveryCode(options.secret, ctx.body.code) },
            },
          };
        }
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
            metrics.signInsRefused.inc({ method: "password" });
            await recordAuth(options.db, {
              method: "password",
              result: admitted.locked ? "locked" : "refused",
              reason: "too many attempts",
              account: ctx.body.email,
              ...requestOf(ctx.request, options.trustProxy ?? false),
            });
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
        const succeeded = !isAPIError(ctx.context.returned);
        // Sign-ins for Prometheus (#70); directory and single sign-on count where they are logged.
        const method =
          ctx.path === "/sign-in/email"
            ? "password"
            : ctx.path === "/passkey/verify-authentication"
              ? "passkey"
              : null;
        if (method) (succeeded ? metrics.signIns : metrics.signInsRefused).inc({ method });
        // The authentication log (#157): each sign-in as its session is made, each refusal.
        const signedInBy = signInMethodOf(ctx.path);
        const created = ctx.context.newSession;
        if (signedInBy && created)
          await recordAuth(options.db, {
            method: signedInBy,
            result: "signed_in",
            account: created.user.email,
            userId: created.user.id,
            organisationId:
              (created.session as { activeOrganisationId?: string | null }).activeOrganisationId ??
              null,
            ...requestOf(ctx.request, options.trustProxy ?? false),
          });
        else if (signedInBy && !succeeded) {
          const returned = ctx.context.returned as { body?: { message?: unknown } };
          const tried = typeof ctx.body?.email === "string" ? ctx.body.email : null;
          const locked =
            ctx.request !== undefined &&
            ((signedInBy === "password" && locking.has(ctx.request)) ||
              lockedAttempts.has(ctx.request));
          await recordAuth(options.db, {
            method: signedInBy,
            result: locked ? "locked" : "refused",
            reason: locked
              ? "too many failed attempts"
              : typeof returned.body?.message === "string"
                ? returned.body.message.slice(0, 200)
                : null,
            account:
              tried ?? (typeof ctx.body?.username === "string" ? ctx.body.username : "Not known"),
            ...requestOf(ctx.request, options.trustProxy ?? false),
          });
        }
        // When each key was last used, for the account page.
        if (ctx.path === "/passkey/verify-authentication" && succeeded) {
          const credential = (ctx.body as { response?: { id?: unknown } } | undefined)?.response
            ?.id;
          if (typeof credential === "string")
            await options.db
              .update(schema.passkeys)
              .set({ lastUsedAt: new Date() })
              .where(eq(schema.passkeys.credentialID, credential));
        }
        if (
          (ctx.path === "/passkey/verify-registration" || ctx.path === "/passkey/delete-passkey") &&
          succeeded &&
          options.audit
        ) {
          const session = await getSessionFromCtx(ctx);
          if (session)
            await logForAccount(
              options.db,
              options.audit,
              session.user.id,
              ctx.path === "/passkey/verify-registration"
                ? "account.passkey_added"
                : "account.passkey_removed",
            );
        }
        if (
          ctx.path === "/two-factor/generate-backup-codes" &&
          options.audit &&
          !isAPIError(ctx.context.returned)
        ) {
          const session = await getSessionFromCtx(ctx);
          if (session)
            await logForAccount(
              options.db,
              options.audit,
              session.user.id,
              "account.recovery_codes",
            );
        }
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
    // Adding a second factor (its first code verified) and removing it are logged.
    databaseHooks: {
      // Every session knows how it was signed in (decision 048).
      session: {
        create: {
          before: async (session, ctx) => {
            const [account] = await options.db
              .select({ twoFactorEnabled: schema.users.twoFactorEnabled })
              .from(schema.users)
              .where(eq(schema.users.id, session.userId));
            const current = ctx?.context.session?.session as
              | { factor?: SessionFactor; ssoProviderId?: string | null; method?: SignInMethod }
              | undefined;
            const via = ctx ? ssoProviderIn(ctx) : undefined;
            const signedInTo = via
              ? (await providerState(options.db, via))?.organisationId
              : undefined;
            const factor = factorFor(
              ctx?.path,
              { twoFactorEnabled: account?.twoFactorEnabled ?? false },
              current?.factor,
            );
            const method = methodFor(ctx?.path, factor, Boolean(via), current?.method);
            // Signing in a way none of their workspaces takes (decision 248) is refused here,
            // with why; one that some take signs in, and the others refuse it as it acts there.
            if (ctx?.path && signInMethodOf(ctx.path)) {
              const refusal = await refusedEverywhere(options.db, session.userId, method);
              if (refusal) throw new APIError("FORBIDDEN", { message: refusal });
            }
            return {
              data: {
                ...session,
                factor,
                method,
                // Which single sign-on made it, for a workspace that takes members only so.
                ssoProviderId: via ?? current?.ssoProviderId ?? null,
                // Signed in through a workspace's provider: in that workspace (#176).
                ...(signedInTo ? { activeOrganisationId: signedInTo } : {}),
              },
            };
          },
        },
      },
      user: {
        update: {
          after: async (user, ctx) => {
            if (!options.audit || !ctx) return;
            const enabled = (user as { twoFactorEnabled?: boolean }).twoFactorEnabled;
            if (ctx.path === "/two-factor/verify-totp" && enabled)
              await logForAccount(
                options.db,
                options.audit,
                user.id,
                "account.second_factor_added",
              );
            if (ctx.path === "/two-factor/disable" && enabled === false)
              await logForAccount(
                options.db,
                options.audit,
                user.id,
                "account.second_factor_removed",
              );
          },
        },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * SESSION_DAYS,
      updateAge: 60 * 60 * 24,
      additionalFields: {
        activeOrganisationId: { type: "string", required: false, input: false },
        factor: { type: "string", required: false, input: false, defaultValue: "password" },
        ssoProviderId: { type: "string", required: false, input: false },
        method: { type: "string", required: false, input: false },
      },
    },
    advanced: {
      cookiePrefix: "hekate",
      // With subdomains (#176), the session's cookie is the root's, sent to every workspace's
      // host; each host still admits only that workspace's members.
      ...(options.subdomains
        ? { crossSubDomainCookies: { enabled: true, domain: options.subdomains.root } }
        : {}),
      useSecureCookies: options.baseURL.startsWith("https://"),
      database: { generateId: () => crypto.randomUUID() },
    },
    rateLimit: {
      enabled: !options.testing,
      // In PostgreSQL, so every replica counts the same attempts.
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        // Shown in the instance's Operations from the same rule (decision 251).
        "/sign-in/email": {
          window: rateLimits.signIn.windowMs / 1000,
          max: rateLimits.signIn.max,
        },
        // A reset code is a key to the account: few to ask for, fewer to try.
        "/email-otp/request-password-reset": { window: 15 * 60, max: 5 },
        "/email-otp/reset-password": { window: 15 * 60, max: 10 },
        // The plugin locks an account after ten wrong codes; this slows a run at many.
        "/two-factor/verify-totp": { window: 60, max: 10 },
        "/two-factor/verify-backup-code": { window: 60, max: 10 },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

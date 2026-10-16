import type { Database } from "@hekate/db";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import type { Audit } from "./audit.ts";
import type { Auth } from "./auth.ts";
import { onError } from "./errors.ts";
import { requirePlaySession, requireViewer } from "./guests.ts";
import type { Jobs } from "./jobs.ts";
import type { Keyring } from "./keyring.ts";
import type { Mailer } from "./mail.ts";
import { rateLimit } from "./rate-limit.ts";
import { categoryRoutes, projectCategoryRoutes } from "./routes/categories.ts";
import { carryRoutes, commentRoutes, fileCommentRoutes } from "./routes/comments.ts";
import { directoryRoutes } from "./routes/directory.ts";
import { fileDetailRoutes } from "./routes/file-details.ts";
import { fileManageRoutes, folderRoutes, projectFolderRoutes } from "./routes/folders.ts";
import { projectGroupRoutes } from "./routes/groups.ts";
import { guestRoutes } from "./routes/guest.ts";
import { health } from "./routes/health.ts";
import { homeRoutes } from "./routes/home.ts";
import { invitationRoutes } from "./routes/invitations.ts";
import { projectMarkRoutes } from "./routes/marks.ts";
import { accountRoutes, meRoutes } from "./routes/me.ts";
import { notificationRoutes } from "./routes/notifications.ts";
import { organisationRoutes } from "./routes/organisation.ts";
import { projectOverviewRoutes } from "./routes/overview.ts";
import { fileRoutes, playRoutes } from "./routes/playback.ts";
import { projectAccessRoutes } from "./routes/project-access.ts";
import { projectRoutes } from "./routes/projects.ts";
import { fileQaRoutes } from "./routes/qa.ts";
import { fileRetryRoutes } from "./routes/retry.ts";
import { projectReviewRoutes, reviewRoutes } from "./routes/reviews.ts";
import { searchRoutes } from "./routes/search.ts";
import { setupRoutes } from "./routes/setup.ts";
import { signInMethodRoutes } from "./routes/sign-in-methods.ts";
import { ssoRoutes } from "./routes/sso.ts";
import { storageSettingsRoutes } from "./routes/storage-settings.ts";
import { fileTagRoutes, tagRoutes } from "./routes/tags.ts";
import {
  projectTrackRoutes,
  trackRoutes,
  variationRoutes,
  versionRoutes,
} from "./routes/tracks.ts";
import { uploadRoutes } from "./routes/uploads.ts";
import { securityHeaders } from "./security-headers.ts";
import type { Storage } from "./storage.ts";
import { requireOrganisation, requireSession } from "./tenancy.ts";

export interface AppDeps {
  db: Database;
  auth: Auth;
  mailer: Mailer;
  storage: Storage;
  audit: Audit;
  keyring: Keyring;
  /** Signs playback tokens; derived from AUTH_SECRET (playbackSecret). */
  playbackSecret: Buffer;
  /** Only queueing is needed here; workers run separately. */
  jobs: Pick<Jobs, "send">;
  /** Read the client address from X-Forwarded-For (behind Caddy). */
  trustProxy?: boolean;
  publicUrl: string;
  log?: boolean;
  /** How many passkeys one account may hold (MAX_PASSKEYS). */
  maxPasskeys?: number;
  /** What storage reconciliation does with bytes nothing uses (STORAGE_RECONCILE). */
  storageReconcile?: "remove" | "report";
  /** Identity providers on a private network the server may reach (SSO_TRUSTED_ORIGINS). */
  ssoTrustedOrigins?: string[];
  /** Check the first owner's password against known breaches (PASSWORD_LEAK_CHECK). */
  passwordLeakCheck?: boolean;
  /** The instance asks every account for a second factor (REQUIRE_SECOND_FACTOR). */
  requireSecondFactor?: boolean;
}

export function createApi(deps: AppDeps) {
  const rule = { instance: deps.requireSecondFactor ?? false };
  const member = [requireSession(deps.auth), requireOrganisation(deps.db, rule)] as const;
  // Someone who still owes a second factor may read who they are, to be sent to add one, and
  // switch to a workspace that does not ask for it; nothing else.
  const owingAllowed = new Set(["/api/me", "/api/me/organisation"]);
  const viewer = requireViewer(deps.auth, deps.db, rule);
  const playback = {
    db: deps.db,
    storage: deps.storage,
    keyring: deps.keyring,
    audit: deps.audit,
    secret: deps.playbackSecret,
    trustProxy: deps.trustProxy ?? false,
    secondFactor: rule,
  };
  const reviewDeps = {
    db: deps.db,
    audit: deps.audit,
    mailer: deps.mailer,
    publicUrl: deps.publicUrl,
    trustProxy: deps.trustProxy ?? false,
  };
  return (
    new Hono()
      .route("/health", health(deps.db))
      .route("/setup", setupRoutes(deps.db, deps.auth, deps.passwordLeakCheck ?? false))
      .route("/sign-in-methods", signInMethodRoutes(deps.db))
      // Deleting the account needs no workspace; it answers before the workspace check below.
      .route(
        "/me",
        accountRoutes(deps.db, {
          auth: deps.auth,
          audit: deps.audit,
          keyring: deps.keyring,
          trustProxy: deps.trustProxy ?? false,
          maxPasskeys: deps.maxPasskeys ?? 5,
        }),
      )
      // "/me/*" also covers "/me" itself.
      .use("/me/*", requireSession(deps.auth), requireOrganisation(deps.db, rule, owingAllowed))
      .route("/me", meRoutes(deps.db, rule, { maxPasskeys: deps.maxPasskeys ?? 5 }))
      .route("/invitations", invitationRoutes(deps.db, deps.auth))
      .use("/organisation/*", ...member)
      .route(
        "/organisation/directory",
        directoryRoutes(deps.db, deps.keyring, deps.audit, deps.trustProxy ?? false),
      )
      .route(
        "/organisation/sso",
        ssoRoutes(deps.db, deps.audit, {
          baseURL: deps.publicUrl,
          trusted: deps.ssoTrustedOrigins ?? [],
          trustProxy: deps.trustProxy ?? false,
        }),
      )
      .route(
        "/organisation/storage",
        storageSettingsRoutes({
          db: deps.db,
          storage: deps.storage,
          audit: deps.audit,
          removing: (deps.storageReconcile ?? "remove") === "remove",
        }),
      )
      .route(
        "/organisation",
        organisationRoutes(
          deps.db,
          deps.mailer,
          deps.publicUrl,
          deps.storage,
          deps.audit,
          deps.trustProxy ?? false,
        ),
      )
      .use("/notifications/*", ...member)
      .use("/notifications", ...member)
      .route("/notifications", notificationRoutes(deps.db))
      .use("/search/*", ...member)
      .use("/search", ...member)
      .route("/search", searchRoutes(deps.db))
      .use("/home", ...member)
      .route("/home", homeRoutes(deps.db))
      .use("/projects/*", ...member)
      .use("/projects", ...member)
      .route("/projects", projectRoutes(deps.db, deps.audit, deps.trustProxy ?? false))
      .route("/projects", projectTrackRoutes(deps.db))
      .route("/projects", projectAccessRoutes(deps.db))
      .route("/projects", projectReviewRoutes(reviewDeps))
      .route("/projects", projectGroupRoutes(deps.db))
      .route("/projects", projectFolderRoutes(deps.db))
      .route("/projects", projectOverviewRoutes(deps.db))
      .route("/projects", projectMarkRoutes(deps.db))
      .route("/projects", projectCategoryRoutes(deps.db))
      .use("/tags/*", ...member)
      .use("/tags", ...member)
      .route("/tags", tagRoutes(deps.db))
      .use("/folders/*", ...member)
      .route("/folders", folderRoutes(deps.db))
      .use("/tracks/*", ...member)
      .route(
        "/tracks",
        trackRoutes(
          deps.db,
          deps.jobs,
          { mailer: deps.mailer, publicUrl: deps.publicUrl },
          deps.audit,
          deps.trustProxy ?? false,
        ),
      )
      .use("/versions/*", ...member)
      .route("/versions", versionRoutes(deps.db))
      .use("/variations/*", ...member)
      .route(
        "/variations",
        variationRoutes(deps.db, deps.jobs, deps.audit, deps.trustProxy ?? false),
      )
      .use("/uploads/*", ...member)
      .use("/uploads", ...member)
      // Starting uploads, per member: a client in a loop is stopped before storage is.
      .post(
        "/uploads",
        rateLimit(
          deps.db,
          "uploads",
          { max: 120, windowMs: 60_000 },
          {
            trustProxy: deps.trustProxy ?? false,
            by: (c) => (c.var as { userId?: string }).userId,
          },
        ),
      )
      .route(
        "/uploads",
        uploadRoutes(deps.db, deps.storage, deps.jobs, deps.audit, deps.trustProxy ?? false),
      )
      // Guest reviewers reach files and reviews too, only those of their own reviews.
      .use("/files/*", viewer)
      .route("/files", fileRoutes(playback))
      .route(
        "/files",
        fileCommentRoutes(deps.db, deps.audit, deps.trustProxy ?? false, {
          mailer: deps.mailer,
          publicUrl: deps.publicUrl,
        }),
      )
      .route("/files", fileManageRoutes(deps.db, deps.audit, deps.trustProxy ?? false))
      .route("/files", fileQaRoutes(deps.db))
      .route("/files", fileTagRoutes(deps.db))
      .route("/files", fileRetryRoutes(deps.db, deps.jobs))
      .route("/files", fileDetailRoutes(deps.db))
      .use("/reviews/*", viewer)
      .route("/reviews", reviewRoutes(reviewDeps))
      // Opening links and trying codes, per address: few people need many in ten minutes.
      .use(
        "/guest/sessions/*",
        rateLimit(
          deps.db,
          "guest",
          { max: 30, windowMs: 10 * 60_000 },
          {
            trustProxy: deps.trustProxy ?? false,
          },
        ),
      )
      .route("/guest", guestRoutes(reviewDeps))
      .use("/comments/*", ...member)
      .route("/comments", commentRoutes(deps.db))
      .use("/categories/*", ...member)
      .route("/categories", categoryRoutes(deps.db))
      .use("/comment-carries/*", ...member)
      .route("/comment-carries", carryRoutes(deps.db))
      // The organisation comes from the token, which the route checks against membership.
      .use("/play/*", requirePlaySession(deps.auth, deps.db))
      .route("/play", playRoutes(playback))
  );
}

export type Api = ReturnType<typeof createApi>;

/** The largest request body outside the upload chunks, which carry their own limit. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export function createApp(deps: AppDeps) {
  const app = new Hono();
  app.use("*", securityHeaders({ https: deps.publicUrl.startsWith("https://") }));
  if (deps.log !== false) app.use("/api/*", logger());
  // Every other body is small: settings, comments, sign-in. A chunk's limit is its own.
  app.use("/api/*", async (c, next) =>
    /^\/api\/uploads\/[^/]+\/chunks\//.test(c.req.path)
      ? next()
      : bodyLimit({
          maxSize: MAX_BODY_BYTES,
          onError: (c) =>
            c.json({ error: { code: "too_large", message: "That request is too large." } }, 413),
        })(c, next),
  );
  // Public sign-up is closed: accounts come from setup and, later, invitations.
  app.all("/api/auth/sign-up/*", () => {
    throw new HTTPException(403, { message: "Sign-up is by invitation" });
  });
  app.on(["GET", "POST"], "/api/auth/*", (c) => deps.auth.handler(c.req.raw));
  app.route("/api", createApi(deps));
  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));
  app.onError(onError);
  return app;
}

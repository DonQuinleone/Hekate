import type { Database } from "@hekate/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import type { Audit } from "./audit.ts";
import type { Auth } from "./auth.ts";
import { onError } from "./errors.ts";
import { requirePlaySession, requireViewer } from "./guests.ts";
import type { Jobs } from "./jobs.ts";
import type { Keyring } from "./keyring.ts";
import type { Mailer } from "./mail.ts";
import { carryRoutes, commentRoutes, fileCommentRoutes } from "./routes/comments.ts";
import { fileManageRoutes, folderRoutes, projectFolderRoutes } from "./routes/folders.ts";
import { projectGroupRoutes } from "./routes/groups.ts";
import { guestRoutes } from "./routes/guest.ts";
import { health } from "./routes/health.ts";
import { homeRoutes } from "./routes/home.ts";
import { invitationRoutes } from "./routes/invitations.ts";
import { meRoutes } from "./routes/me.ts";
import { notificationRoutes } from "./routes/notifications.ts";
import { organisationRoutes } from "./routes/organisation.ts";
import { fileRoutes, playRoutes } from "./routes/playback.ts";
import { projectAccessRoutes } from "./routes/project-access.ts";
import { projectRoutes } from "./routes/projects.ts";
import { fileQaRoutes } from "./routes/qa.ts";
import { projectReviewRoutes, reviewRoutes } from "./routes/reviews.ts";
import { searchRoutes } from "./routes/search.ts";
import { setupRoutes } from "./routes/setup.ts";
import {
  projectTrackRoutes,
  trackRoutes,
  variationRoutes,
  versionRoutes,
} from "./routes/tracks.ts";
import { uploadRoutes } from "./routes/uploads.ts";
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
}

export function createApi(deps: AppDeps) {
  const member = [requireSession(deps.auth), requireOrganisation(deps.db)] as const;
  const viewer = requireViewer(deps.auth, deps.db);
  const playback = {
    db: deps.db,
    storage: deps.storage,
    keyring: deps.keyring,
    audit: deps.audit,
    secret: deps.playbackSecret,
    trustProxy: deps.trustProxy ?? false,
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
      .route("/setup", setupRoutes(deps.db, deps.auth))
      .use("/me/*", ...member)
      .use("/me", ...member)
      .route("/me", meRoutes(deps.db))
      .route("/invitations", invitationRoutes(deps.db, deps.auth))
      .use("/organisation/*", ...member)
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
      .use("/search", ...member)
      .route("/search", searchRoutes(deps.db))
      .use("/home", ...member)
      .route("/home", homeRoutes(deps.db))
      .use("/projects/*", ...member)
      .use("/projects", ...member)
      .route("/projects", projectRoutes(deps.db))
      .route("/projects", projectTrackRoutes(deps.db))
      .route("/projects", projectAccessRoutes(deps.db))
      .route("/projects", projectReviewRoutes(reviewDeps))
      .route("/projects", projectGroupRoutes(deps.db))
      .route("/projects", projectFolderRoutes(deps.db))
      .use("/folders/*", ...member)
      .route("/folders", folderRoutes(deps.db))
      .use("/tracks/*", ...member)
      .route(
        "/tracks",
        trackRoutes(deps.db, deps.jobs, { mailer: deps.mailer, publicUrl: deps.publicUrl }),
      )
      .use("/versions/*", ...member)
      .route("/versions", versionRoutes(deps.db))
      .use("/variations/*", ...member)
      .route("/variations", variationRoutes(deps.db))
      .use("/uploads/*", ...member)
      .use("/uploads", ...member)
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
      .use("/reviews/*", viewer)
      .route("/reviews", reviewRoutes(reviewDeps))
      .route("/guest", guestRoutes(reviewDeps))
      .use("/comments/*", ...member)
      .route("/comments", commentRoutes(deps.db))
      .use("/comment-carries/*", ...member)
      .route("/comment-carries", carryRoutes(deps.db))
      // The organisation comes from the token, which the route checks against membership.
      .use("/play/*", requirePlaySession(deps.auth, deps.db))
      .route("/play", playRoutes(playback))
  );
}

export type Api = ReturnType<typeof createApi>;

export function createApp(deps: AppDeps) {
  const app = new Hono();
  if (deps.log !== false) app.use("/api/*", logger());
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

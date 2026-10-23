import { tmpdir } from "node:os";
import type { Database } from "@hekate/db";
import {
  type BounceProvider,
  COMMENT_ATTACHMENT_MAX_BYTES,
  type InstanceMail,
  type InstanceModules,
  type InstanceNotice,
  type MailStepInput,
} from "@hekate/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import type { Audit } from "./audit.ts";
import { type Auth, SESSION_DAYS } from "./auth.ts";
import type { Gateway } from "./billing/gateway.ts";
import { createSend, type Send } from "./channels.ts";
import { errorHandler, requestId } from "./errors.ts";
import { requirePlaySession, requireViewer } from "./guests.ts";
import { createHealthChecks } from "./health-checks.ts";
import { type Subdomains, workspaceFromHost } from "./hosts.ts";
import { createInstanceSettings, type InstanceSettingsStore } from "./instance-settings.ts";
import type { Jobs } from "./jobs.ts";
import type { Keyring } from "./keyring.ts";
import type { Mailer } from "./mail.ts";
import { countRequests, metricsHandler } from "./metrics/index.ts";
import type { Sampler } from "./metrics/sampler.ts";
import { rateLimit } from "./rate-limit.ts";
import { attachmentRoutes } from "./routes/attachments.ts";
import { billingRoutes } from "./routes/billing.ts";
import { billingHookRoutes } from "./routes/billing-hooks.ts";
import { projectBoardRoutes } from "./routes/board.ts";
import { calendarFeedRoutes, projectCalendarRoutes } from "./routes/calendar.ts";
import { captionRoutes } from "./routes/captions.ts";
import { categoryRoutes, projectCategoryRoutes } from "./routes/categories.ts";
import { channelRoutes } from "./routes/channels.ts";
import { carryRoutes, commentRoutes, fileCommentRoutes } from "./routes/comments.ts";
import { directoryRoutes } from "./routes/directory.ts";
import {
  downloadRoutes,
  fileDownloadRoutes,
  projectScoreDownloadRoutes,
} from "./routes/downloads.ts";
import { editDecisionRoutes } from "./routes/edit-decisions.ts";
import { fileDetailRoutes } from "./routes/file-details.ts";
import { fileManageRoutes, folderRoutes, projectFolderRoutes } from "./routes/folders.ts";
import { projectGroupRoutes } from "./routes/groups.ts";
import { guestRoutes } from "./routes/guest.ts";
import { health } from "./routes/health.ts";
import { homeRoutes } from "./routes/home.ts";
import { installRoutes } from "./routes/install.ts";
import { instanceRoutes } from "./routes/instance.ts";
import { invitationRoutes } from "./routes/invitations.ts";
import { mailHookRoutes } from "./routes/mail-hooks.ts";
import { projectMarkRoutes } from "./routes/marks.ts";
import { accountRoutes, meRoutes } from "./routes/me.ts";
import { notificationRoutes } from "./routes/notifications.ts";
import { operationsRoutes } from "./routes/operations.ts";
import { organisationRoutes } from "./routes/organisation.ts";
import { projectOverviewRoutes } from "./routes/overview.ts";
import { patchRowRoutes, projectPatchRoutes, stageBoxRoutes } from "./routes/patch.ts";
import { personnelRoutes, projectPersonnelRoutes } from "./routes/personnel.ts";
import { planRoutes } from "./routes/plan.ts";
import { fileRoutes, playRoutes } from "./routes/playback.ts";
import { projectAccessRoutes } from "./routes/project-access.ts";
import { projectDeletionRoutes } from "./routes/project-deletion.ts";
import { projectStorageRoutes } from "./routes/project-storage.ts";
import { projectTransferRoutes } from "./routes/project-transfers.ts";
import { projectRoutes } from "./routes/projects.ts";
import { fileQaRoutes } from "./routes/qa.ts";
import { projectRepertoireRoutes, venueRoutes, workRoutes } from "./routes/repertoire.ts";
import { fileRetryRoutes } from "./routes/retry.ts";
import { projectReviewRoutes, type ReviewDeps, reviewRoutes } from "./routes/reviews.ts";
import { projectScheduleRoutes, scheduleDayRoutes, scheduleRowRoutes } from "./routes/schedule.ts";
import {
  projectScoreCategoryRoutes,
  scoreCategoryRoutes,
  scoreMarkRoutes,
  trackScoreMarkRoutes,
} from "./routes/score-marks.ts";
import { searchRoutes } from "./routes/search.ts";
import { projectSessionRoutes, sessionRoutes } from "./routes/sessions.ts";
import { setupRoutes } from "./routes/setup.ts";
import { signInMethodRoutes } from "./routes/sign-in-methods.ts";
import { signUpRoutes } from "./routes/sign-up.ts";
import { ssoRoutes } from "./routes/sso.ts";
import { projectStagePlanRoutes, stagePlanRoutes } from "./routes/stage-plans.ts";
import { storageSettingsRoutes } from "./routes/storage-settings.ts";
import { fileTagRoutes, tagRoutes } from "./routes/tags.ts";
import { sharedTakeRoutes, takeRoutes, trackTakeRoutes } from "./routes/takes.ts";
import { projectTaskRoutes, taskRoutes } from "./routes/tasks.ts";
import { projectTemplateRoutes, templateRoutes } from "./routes/templates.ts";
import { tlsRoutes } from "./routes/tls.ts";
import { trackCompareRoutes } from "./routes/track-compare.ts";
import {
  projectTrackRoutes,
  trackRoutes,
  variationRoutes,
  versionRoutes,
} from "./routes/tracks.ts";
import { uploadLinkRoutes, uploadRequestRoutes } from "./routes/upload-requests.ts";
import { uploadRoutes } from "./routes/uploads.ts";
import { trackWorkflowRunRoutes, workflowRunRoutes } from "./routes/workflow-runs.ts";
import { projectWorkflowRoutes, workflowRoutes } from "./routes/workflows.ts";
import { workspaceMailRoutes } from "./routes/workspace-mail.ts";
import { securityHeaders } from "./security-headers.ts";
import type { SetupGate } from "./setup-code.ts";
import type { Storage } from "./storage.ts";
import { traced } from "./telemetry.ts";
import { requireOrganisation, requireSession } from "./tenancy.ts";
import { type RunnerDeps, reviewSettled } from "./workflow-runner.ts";

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
  /** Workspace subdomains (#176), where WORKSPACE_SUBDOMAINS turns them on. */
  subdomains?: Subdomains | null;
  log?: boolean;
  /** How many passkeys one account may hold (MAX_PASSKEYS). */
  maxPasskeys?: number;
  /** What storage reconciliation does with bytes nothing uses (STORAGE_RECONCILE). */
  storageReconcile?: "remove" | "report";
  /** Identity providers on a private network the server may reach (SSO_TRUSTED_ORIGINS). */
  ssoTrustedOrigins?: string[];
  /** Channels and webhooks on a private network the server may reach (WEBHOOK_TRUSTED_ORIGINS). */
  webhookTrustedOrigins?: string[];
  /** How a channel is sent to (#161); a guarded HTTP request unless a test gives its own. */
  sendToChannel?: Send;
  /** The instance's provider, where it is one that reports bounces (#161), secret or not. */
  bounceProvider?: BounceProvider | null;
  /** The instance's provider's bounce reports (#161): which provider, and its signing secret. */
  instanceBounces?: { provider: BounceProvider; secret: string } | null;
  /** For tests: the mailer a workspace's own mail details come to (#161). */
  buildWorkspaceMailer?: (mail: MailStepInput) => Mailer;
  /** Check the first owner's password against known breaches (PASSWORD_LEAK_CHECK). */
  passwordLeakCheck?: boolean;
  /** The instance asks every account for a second factor (REQUIRE_SECOND_FACTOR). */
  requireSecondFactor?: boolean;
  /** Guards creating the first owner with the code from the server's log (decision 061). */
  setupGate?: SetupGate;
  /** Operators act only from a session signed in with a key (OPERATOR_SECURITY_KEY). */
  operatorSecurityKey?: boolean;
  /**
   * Scratch space for decrypted media while a page or download is marked (WORK_DIR), as for
   * the media workers; the system's temporary directory if unset.
   */
  workDir?: string;
  /** The bearer token a Prometheus scraper sends to read `/metrics`; none turns it off. */
  metricsToken?: string;
  /** The instance's settings (#160), shared with the workers; read from the database if unset. */
  settings?: InstanceSettingsStore;
  /** How instance mail goes out (#71): SMTP, Microsoft 365, Mailcoach, or to the log. */
  mail?: InstanceMail;
  /** The commit the image was built from (HEKATE_BUILD). */
  build?: string;
  /** The daily release check is on (HEKATE_UPDATE_CHECK). */
  updateCheck?: boolean;
  /** This process's minute-by-minute measures (#156); none in tests. */
  sampler?: Sampler;
  /** The disk System health measures: local storage's, else the working directory's. */
  diskPath?: string;
  /** Each storage backend's driver and where it keeps its objects, for System health. */
  storageDescribed?: { name: string; driver: "local" | "s3"; where: string }[];
  /** Earlier master keys still configured (MASTER_KEYS_PREVIOUS). */
  previousMasterKeys?: number;
  /** The modules switched on at start, shown in the instance's Settings (#160). */
  modules?: InstanceModules;
  /** The billing gateway (#178), with HEKATE_BILLING=stripe; none otherwise. */
  gateway?: Gateway | null;
}

export function createApi(deps: AppDeps) {
  const settings = deps.settings ?? createInstanceSettings(deps.db);
  // What links sent out are made from: each workspace's own address with subdomains on (#437).
  const links = { publicUrl: deps.publicUrl, subdomains: deps.subdomains ?? null };
  const billing = {
    db: deps.db,
    gateway: deps.gateway ?? null,
    mailer: deps.mailer,
    ...links,
    // The rules as an operator last set them (#180).
    rules: async () => (await settings.get()).billing,
  };
  // The environment asks it, or an operator does in Settings (#160), read as the server runs.
  const rule = {
    get instance() {
      return (deps.requireSecondFactor ?? false) || settings.current().security.requireSecondFactor;
    },
  };
  // A workspace billing suspended for a payment overdue (#179): its owners may still read
  // what is owed and change the card, and nothing else.
  const payable = new Set(["/api/organisation/billing", "/api/organisation/billing/portal"]);
  const member = [
    requireSession(deps.auth),
    requireOrganisation(deps.db, rule, new Set(), payable),
  ] as const;
  const checks = createHealthChecks(deps.db, {
    backends: deps.storage.backends,
    mailer: deps.mailer,
  });
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
    workDir: deps.workDir,
    jobs: deps.jobs,
  };
  const downloads = {
    db: deps.db,
    storage: deps.storage,
    keyring: deps.keyring,
    audit: deps.audit,
    trustProxy: deps.trustProxy ?? false,
    workDir: deps.workDir,
  };
  const taskMail = { db: deps.db, mailer: deps.mailer, ...links };
  const uploadRequestDeps = {
    db: deps.db,
    storage: deps.storage,
    jobs: deps.jobs,
    audit: deps.audit,
    mailer: deps.mailer,
    ...links,
    trustProxy: deps.trustProxy ?? false,
  };
  const uploadLinkLimit = rateLimit(
    deps.db,
    "upload-link",
    { max: 60, windowMs: 10 * 60_000 },
    { trustProxy: deps.trustProxy ?? false },
  );
  const reviewDeps: ReviewDeps = {
    db: deps.db,
    audit: deps.audit,
    mailer: deps.mailer,
    ...links,
    trustProxy: deps.trustProxy ?? false,
  };
  // Workflows ask for reviews, and a review's outcome moves its workflow on (#25).
  const runner: RunnerDeps = { db: deps.db, jobs: deps.jobs, reviews: reviewDeps };
  reviewDeps.onSettled = (review, by) => reviewSettled(runner, review, by);
  return (
    new Hono()
      // Before anything that reads the database: liveness must answer while it stalls (#156).
      .route("/health", health(deps.db, checks))
      // Read as each request starts (from memory, mostly), for the checks that answer at once.
      .use("*", async (_c, next) => {
        await settings.get();
        await next();
      })
      // What everyone is told, signed in or not: maintenance mode's notice (#154).
      .get("/notice", async (c) =>
        c.json({ maintenance: (await settings.get()).maintenance } satisfies InstanceNotice),
      )
      .route(
        "/setup",
        setupRoutes(deps.db, deps.auth, deps.passwordLeakCheck ?? false, deps.setupGate),
      )
      .route("/install", installRoutes(null))
      .route(
        "/instance",
        instanceRoutes({
          billing,
          db: deps.db,
          auth: deps.auth,
          rule,
          operatorSecurityKey: deps.operatorSecurityKey ?? true,
          trustProxy: deps.trustProxy ?? false,
          mailer: deps.mailer,
          ...links,
          keyring: deps.keyring,
          jobs: deps.jobs,
          backends: deps.storage.backends,
          audit: deps.audit,
          settings,
          system: { build: deps.build ?? "dev", checkOn: deps.updateCheck ?? false },
          health: {
            checks,
            ...(deps.sampler ? { sampler: deps.sampler } : {}),
            diskPath: deps.diskPath ?? deps.workDir ?? tmpdir(),
            backends: deps.storage.backends,
            described: deps.storageDescribed ?? [],
            previousMasterKeys: deps.previousMasterKeys ?? 0,
          },
          environment: {
            publicUrl: deps.publicUrl,
            subdomains: deps.subdomains ? `*.${deps.subdomains.url.host}` : null,
            requireSecondFactor: deps.requireSecondFactor ?? false,
            operatorSecurityKey: deps.operatorSecurityKey ?? true,
            mail: deps.mail ?? "log",
            bounces: deps.bounceProvider
              ? {
                  provider: deps.bounceProvider,
                  url: new URL("/api/hooks/mail/instance", deps.publicUrl).toString(),
                  secretSet: Boolean(deps.instanceBounces),
                }
              : null,
            passwordLeakCheck: deps.passwordLeakCheck ?? false,
            sessionDays: SESSION_DAYS,
            modules: deps.modules ?? {
              billing: "off",
              support: "off",
              docsUrl: "https://docs.hekate.studio",
              statusUrl: null,
            },
          },
        }),
      )
      .route(
        "/sign-in-methods",
        signInMethodRoutes(
          deps.db,
          deps.subdomains ?? null,
          async () => (await settings.get()).registration.mode,
        ),
      )
      // Which names Caddy may get a certificate for (#176): asked before each one.
      .route("/tls", tlsRoutes(deps.db, deps.subdomains ?? null))
      // The billing gateway's events (#178): no session, a signature instead.
      .route("/hooks/billing", billingHookRoutes(billing))
      // Providers' bounce reports (#161): no session, a signature instead.
      .route(
        "/hooks/mail",
        mailHookRoutes({
          db: deps.db,
          keyring: deps.keyring,
          instance: deps.instanceBounces ?? null,
        }),
      )
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
      .route(
        "/me",
        meRoutes(deps.db, rule, {
          maxPasskeys: deps.maxPasskeys ?? 5,
          subdomains: deps.subdomains ?? null,
          billing: (deps.modules?.billing ?? "off") !== "off",
        }),
      )
      .route("/invitations", invitationRoutes(deps.db, deps.auth))
      // Making a workspace without an operator (#184), as the instance's registration allows.
      .route(
        "/sign-up",
        signUpRoutes({
          db: deps.db,
          auth: deps.auth,
          settings,
          mailer: deps.mailer,
          publicUrl: deps.publicUrl,
          billing: (deps.modules?.billing ?? "off") !== "off",
          leakCheck: deps.passwordLeakCheck ?? false,
          trustProxy: deps.trustProxy ?? false,
          subdomains: deps.subdomains ?? null,
        }),
      )
      .use("/organisation/*", ...member)
      .route(
        "/organisation/directory",
        directoryRoutes(
          deps.db,
          deps.keyring,
          deps.audit,
          deps.trustProxy ?? false,
          (deps.modules?.billing ?? "off") !== "off",
        ),
      )
      .route(
        "/organisation/sso",
        ssoRoutes(deps.db, deps.audit, {
          baseURL: deps.publicUrl,
          trusted: deps.ssoTrustedOrigins ?? [],
          trustProxy: deps.trustProxy ?? false,
          billing: (deps.modules?.billing ?? "off") !== "off",
        }),
      )
      .route("/organisation/plan", planRoutes(deps.db, (deps.modules?.billing ?? "off") !== "off"))
      .route("/organisation/billing", billingRoutes(billing))
      .route(
        "/organisation/channels",
        channelRoutes({
          db: deps.db,
          keyring: deps.keyring,
          audit: deps.audit,
          jobs: deps.jobs,
          send: deps.sendToChannel ?? createSend(deps.webhookTrustedOrigins ?? []),
          ...links,
          trusted: deps.webhookTrustedOrigins ?? [],
          trustProxy: deps.trustProxy ?? false,
        }),
      )
      .route(
        "/organisation/mail",
        workspaceMailRoutes({
          db: deps.db,
          keyring: deps.keyring,
          audit: deps.audit,
          trusted: deps.webhookTrustedOrigins ?? [],
          trustProxy: deps.trustProxy ?? false,
          publicUrl: deps.publicUrl,
          ...(deps.buildWorkspaceMailer ? { build: deps.buildWorkspaceMailer } : {}),
        }),
      )
      .route(
        "/organisation/operations",
        operationsRoutes({
          db: deps.db,
          checks,
          settings,
          build: deps.build ?? "dev",
          updateCheck: deps.updateCheck ?? false,
          metricsOn: Boolean(deps.metricsToken),
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
          links,
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
      .route("/projects", projectDeletionRoutes(reviewDeps))
      .route("/projects", projectStorageRoutes({ db: deps.db, storage: deps.storage }))
      .route("/projects", projectScoreDownloadRoutes(downloads))
      .route("/projects", projectTrackRoutes(deps.db))
      .route("/projects", projectAccessRoutes(deps.db))
      .route("/projects", projectReviewRoutes(reviewDeps))
      .route("/projects", projectGroupRoutes(deps.db))
      .route("/projects", projectFolderRoutes(deps.db))
      .route("/projects", projectOverviewRoutes(deps.db))
      .route("/projects", projectMarkRoutes(deps.db))
      .route("/projects", projectCategoryRoutes(deps.db))
      .route("/projects", projectScoreCategoryRoutes(deps.db))
      .route("/projects", projectPatchRoutes(deps.db))
      .route("/projects", projectStagePlanRoutes(deps.db))
      .route("/projects", projectPersonnelRoutes(deps.db))
      .route("/projects", projectRepertoireRoutes(deps.db))
      .route("/projects", projectScheduleRoutes(deps.db))
      .route("/projects", projectSessionRoutes(deps.db))
      .route("/projects", projectWorkflowRoutes(deps.db))
      .route("/projects", projectTemplateRoutes(deps.db))
      .route("/projects", projectTaskRoutes(taskMail))
      .route("/projects", projectBoardRoutes(deps.db))
      .route("/projects", projectCalendarRoutes(deps.db, deps.publicUrl))
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
          { mailer: deps.mailer, ...links },
          deps.audit,
          deps.trustProxy ?? false,
          deps.storage,
          runner,
        ),
      )
      .route("/tracks", trackTakeRoutes(deps.db))
      .route("/tracks", editDecisionRoutes(deps.db, deps.storage))
      .route("/tracks", trackScoreMarkRoutes(deps.db))
      .route("/tracks", trackCompareRoutes(deps.db, deps.jobs))
      .route("/tracks", trackWorkflowRunRoutes(runner))
      .use("/score-categories/*", ...member)
      .route("/score-categories", scoreCategoryRoutes(deps.db))
      .use("/stage-boxes/*", ...member)
      .route("/stage-boxes", stageBoxRoutes(deps.db))
      .use("/patch-rows/*", ...member)
      .route("/patch-rows", patchRowRoutes(deps.db))
      .use("/works/*", ...member)
      .route("/works", workRoutes(deps.db))
      .use("/venues/*", ...member)
      .route("/venues", venueRoutes(deps.db))
      .use("/schedule-days/*", ...member)
      .route("/schedule-days", scheduleDayRoutes(deps.db))
      .use("/schedule-rows/*", ...member)
      .route("/schedule-rows", scheduleRowRoutes(deps.db, runner))
      .use("/personnel/*", ...member)
      .route("/personnel", personnelRoutes(deps.db))
      .use("/stage-plans/*", ...member)
      .route("/stage-plans", stagePlanRoutes(deps.db))
      .use("/score-marks/*", ...member)
      .route("/score-marks", scoreMarkRoutes(deps.db))
      .use("/takes/*", ...member)
      .route("/takes", takeRoutes(deps.db))
      .use("/sessions/*", ...member)
      .route("/sessions", sessionRoutes(deps.db))
      .use("/tasks/*", ...member)
      .route("/tasks", taskRoutes({ ...taskMail, runner }))
      // Moving a project between workspaces (#240): from the project, and as either side sees it.
      .use("/transfers/*", ...member)
      .use("/transfers", ...member)
      .route(
        "/",
        projectTransferRoutes({
          db: deps.db,
          auth: deps.auth,
          keyring: deps.keyring,
          backends: deps.storage.backends,
          jobs: deps.jobs,
          audit: deps.audit,
          mailer: deps.mailer,
          ...links,
          trustProxy: deps.trustProxy ?? false,
        }),
      )
      .use("/workflows/*", ...member)
      .route("/workflows", workflowRoutes(deps.db))
      .use("/workflow-runs/*", ...member)
      .route("/workflow-runs", workflowRunRoutes(runner))
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
      // Upload requests (#139): members ask for files; the visitor's side has no session, its
      // link the credential, so opening one and starting a file are slowed, per address.
      .use("/upload-requests/*", ...member)
      .route("/", uploadRequestRoutes(uploadRequestDeps))
      .use("/upload-links/*", async (c, next) =>
        /\/chunks\//.test(c.req.path) ? next() : uploadLinkLimit(c, next),
      )
      .route("/upload-links", uploadLinkRoutes(uploadRequestDeps))
      // Guest reviewers reach files and reviews too, only those of their own reviews.
      .use("/files/*", viewer)
      .route("/files", fileRoutes(playback))
      .route(
        "/files",
        fileCommentRoutes(deps.db, deps.audit, deps.trustProxy ?? false, {
          mailer: deps.mailer,
          ...links,
        }),
      )
      .route("/files", fileManageRoutes(deps.db, deps.audit, deps.trustProxy ?? false))
      .route("/files", fileQaRoutes(deps.db))
      .route("/files", fileTagRoutes(deps.db))
      .route("/files", fileRetryRoutes(deps.db, deps.jobs))
      .route("/files", fileDetailRoutes(deps.db))
      .route("/files", fileDownloadRoutes(downloads))
      .route("/files", attachmentRoutes(downloads))
      .route("/files", captionRoutes(downloads))
      .use("/downloads/*", viewer)
      .route("/downloads", downloadRoutes(downloads))
      .use("/reviews/*", viewer)
      .route("/reviews", reviewRoutes(reviewDeps))
      // Calendar feeds (#141), read by calendars with no session: the link is the credential,
      // so guessing at links is slowed, per address.
      .use(
        "/calendar/*",
        rateLimit(
          deps.db,
          "calendar",
          { max: 120, windowMs: 10 * 60_000 },
          { trustProxy: deps.trustProxy ?? false },
        ),
      )
      .route("/calendar", calendarFeedRoutes(deps.db, deps.publicUrl))
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
      .route("/comments", commentRoutes(deps.db, { mailer: deps.mailer, ...links }))
      .route("/comments", sharedTakeRoutes(downloads))
      .use("/templates", ...member)
      .use("/templates/*", ...member)
      .route("/templates", templateRoutes(deps.db))
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

/** Where a comment's attachment is sent, which takes up to its own limit. */
const ATTACHMENT_PATH = /^\/api\/files\/[^/]+\/comments\/[^/]+\/attachments$/;

/** The largest request body outside the upload chunks, which carry their own limit. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** An upload's chunk, a member's or one sent through an upload request: its own limit. */
const CHUNK_PATH = /^\/api\/(uploads|upload-links\/[^/]+\/uploads)\/[^/]+\/chunks\//;

/** What an upload sends: starting one, its chunks, finishing it, or a comment's attachment. */
const uploading = (method: string, path: string) =>
  (method === "POST" || method === "PUT") &&
  (/^\/api\/uploads(\/|$)/.test(path) ||
    /^\/api\/upload-links\/[^/]+\/uploads/.test(path) ||
    ATTACHMENT_PATH.test(path));

export function createApp(given: AppDeps) {
  const deps = { ...given, settings: given.settings ?? createInstanceSettings(given.db) };
  const settings = deps.settings;
  const app = new Hono();
  app.use("*", securityHeaders({ https: deps.publicUrl.startsWith("https://") }));
  // For Prometheus (#70): only with a token, and never through the API's own middleware.
  app.get("/metrics", metricsHandler(deps.metricsToken));
  // A span for each request (#162), around everything else so the rest happens inside it.
  app.use("/api/*", traced);
  app.use("/api/*", countRequests);
  app.use("/api/*", requestId);
  // The workspace a host names (#176), for the tenancy checks to hold each request to.
  app.use("/api/*", workspaceFromHost(deps.db, deps.subdomains ?? null, deps.trustProxy ?? false));
  if (deps.log !== false) app.use("/api/*", logger());
  // Every other body is small: settings, comments, sign-in. A chunk's limit is its own.
  app.use("/api/*", async (c, next) =>
    CHUNK_PATH.test(c.req.path)
      ? next()
      : ATTACHMENT_PATH.test(c.req.path)
        ? bodyLimit({
            maxSize: COMMENT_ATTACHMENT_MAX_BYTES,
            onError: (c) =>
              c.json(
                { error: { code: "too_large", message: "An attachment can be at most 25 MB" } },
                413,
              ),
          })(c, next)
        : bodyLimit({
            maxSize: MAX_BODY_BYTES,
            onError: (c) =>
              c.json({ error: { code: "too_large", message: "That request is too large." } }, 413),
          })(c, next),
  );
  // Maintenance mode (#154): uploads wait until it is over, the files they would send kept.
  app.use("/api/*", async (c, next) => {
    if (uploading(c.req.method, c.req.path) && (await settings.get()).maintenance.on)
      return c.json(
        {
          error: {
            code: "maintenance",
            message: "The instance is under maintenance: uploads wait until it is over.",
          },
        },
        503,
      );
    await next();
  });
  // Better Auth's own sign-up stays closed: accounts come from setup, invitations, and the
  // instance's sign-up (#184, `/api/sign-up`), which confirms the email first.
  app.all("/api/auth/sign-up/*", () => {
    throw new HTTPException(403, { message: "Sign-up is by invitation" });
  });
  app.on(["GET", "POST"], "/api/auth/*", (c) => deps.auth.handler(c.req.raw));
  app.route("/api", createApi(deps));
  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));
  app.onError(errorHandler(deps.db));
  return app;
}

import type { Database } from "@hekate/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import type { Auth } from "./auth.ts";
import { onError } from "./errors.ts";
import type { Mailer } from "./mail.ts";
import { health } from "./routes/health.ts";
import { invitationRoutes } from "./routes/invitations.ts";
import { meRoutes } from "./routes/me.ts";
import { organisationRoutes } from "./routes/organisation.ts";
import { projectRoutes } from "./routes/projects.ts";
import { setupRoutes } from "./routes/setup.ts";
import type { Storage } from "./storage.ts";
import { requireOrganisation, requireSession } from "./tenancy.ts";

export interface AppDeps {
  db: Database;
  auth: Auth;
  mailer: Mailer;
  storage: Storage;
  publicUrl: string;
  log?: boolean;
}

export function createApi(deps: AppDeps) {
  const member = [requireSession(deps.auth), requireOrganisation(deps.db)] as const;
  return new Hono()
    .route("/health", health(deps.db))
    .route("/setup", setupRoutes(deps.db, deps.auth))
    .use("/me/*", ...member)
    .use("/me", ...member)
    .route("/me", meRoutes(deps.db))
    .route("/invitations", invitationRoutes(deps.db, deps.auth))
    .use("/organisation/*", ...member)
    .route("/organisation", organisationRoutes(deps.db, deps.mailer, deps.publicUrl, deps.storage))
    .use("/projects/*", ...member)
    .use("/projects", ...member)
    .route("/projects", projectRoutes(deps.db));
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

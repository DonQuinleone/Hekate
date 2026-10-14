import type { Database } from "@hekate/db";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { onError } from "./errors.ts";
import { health } from "./routes/health.ts";
import { projectRoutes } from "./routes/projects.ts";
import { tenant } from "./tenancy.ts";

export interface AppDeps {
  db: Database;
  organisationId: () => Promise<string>;
  log?: boolean;
}

export function createApi(deps: AppDeps) {
  const api = new Hono()
    .route("/health", health(deps.db))
    .use("/projects/*", tenant(deps.organisationId))
    .route("/projects", projectRoutes(deps.db));
  return api;
}

export type Api = ReturnType<typeof createApi>;

export function createApp(deps: AppDeps) {
  const app = new Hono();
  if (deps.log !== false) app.use("/api/*", logger());
  app.route("/api", createApi(deps));
  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));
  app.onError(onError);
  return app;
}

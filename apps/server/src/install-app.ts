import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { logger } from "hono/logger";
import { MAX_BODY_BYTES } from "./app.ts";
import { CodedException, onError } from "./errors.ts";
import { type InstallerOptions, installRoutes } from "./routes/install.ts";
import { securityHeaders } from "./security-headers.ts";
import { serveWeb } from "./static.ts";
import { version } from "./version.ts";

/**
 * The server before it is configured (decision 061): the web app and the installer's routes,
 * and nothing else. Every other API route answers that Hekate is still being installed.
 */
export function createInstallApp(
  options: InstallerOptions & { webDist?: string | undefined; docsUrl: string; log?: boolean },
) {
  const app = new Hono();
  app.use("*", securityHeaders({ https: false }));
  if (options.log !== false) app.use("/api/*", logger());
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        c.json({ error: { code: "too_large", message: "That request is too large." } }, 413),
    }),
  );
  app.route("/api/install", installRoutes(options));
  // The page asks these before anything else: it is setting up, and the server is alive.
  app.get("/api/setup", (c) => c.json({ needed: true }));
  app.get("/api/health", (c) => c.json({ status: "installing", version } as const));
  app.all("/api/*", () => {
    throw new CodedException(409, "installing", "Hekate is still being installed");
  });
  if (options.webDist) serveWeb(app, options.webDist, { docsUrl: options.docsUrl });
  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));
  app.onError(onError);
  return app;
}

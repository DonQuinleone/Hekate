import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";

/** Serves the built web app, falling back to index.html for client-side routes. */
export function serveWeb(app: Hono, root: string) {
  app.use("/assets/*", serveStatic({ root }));
  app.use("*", serveStatic({ root }));
  app.get("*", async (c) => {
    if (c.req.path.startsWith("/api/")) return c.notFound();
    return c.html(await readFile(join(root, "index.html"), "utf8"));
  });
}

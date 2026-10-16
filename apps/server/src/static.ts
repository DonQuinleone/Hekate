import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";

/** What the page needs from the server's settings before any script runs. */
export interface WebMeta {
  /** Where "View documentation" goes (HEKATE_DOCS_URL). */
  docsUrl: string;
}

const attribute = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The page with the server's settings as meta tags: read by the app as it starts, with no
 * inline script, so the content security policy stays strict.
 */
export function withMeta(html: string, meta: WebMeta) {
  const tags = `<meta name="hekate-docs-url" content="${attribute(meta.docsUrl)}" />`;
  return html.replace("</head>", `${tags}</head>`);
}

/** Serves the built web app, falling back to index.html for client-side routes. */
export function serveWeb(app: Hono, root: string, meta: WebMeta) {
  let page: Promise<string> | undefined;
  const index = () => {
    page ??= readFile(join(root, "index.html"), "utf8").then((html) => withMeta(html, meta));
    return page;
  };
  // The page itself, at its own address too, always carries the meta tags.
  app.get("/", async (c) => c.html(await index()));
  app.get("/index.html", async (c) => c.html(await index()));
  app.use("/assets/*", serveStatic({ root }));
  app.use("*", serveStatic({ root }));
  app.get("*", async (c) => {
    if (c.req.path.startsWith("/api/")) return c.notFound();
    return c.html(await index());
  });
}

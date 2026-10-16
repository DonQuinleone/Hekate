import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { serveWeb, withMeta } from "./static.ts";

describe("the served page", () => {
  it("carries the configured documentation address, escaped, before any script runs", () => {
    const html = withMeta("<html><head><title>Hekate</title></head><body></body></html>", {
      docsUrl: 'https://docs.example.test/?a=1&b="2"',
    });
    expect(html).toContain(
      '<meta name="hekate-docs-url" content="https://docs.example.test/?a=1&amp;b=&quot;2&quot;" /></head>',
    );
  });

  it("serves the page with them at its root, its own address and every client route", async () => {
    const root = mkdtempSync(join(tmpdir(), "hekate-web-"));
    writeFileSync(join(root, "index.html"), "<html><head></head><body>app</body></html>");
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "assets", "app.js"), "console.log(1)");
    const app = new Hono();
    serveWeb(app, root, { docsUrl: "https://docs.example.test" });
    for (const path of ["/", "/index.html", "/projects/abc/settings"]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toContain('name="hekate-docs-url"');
    }
    const asset = await app.request("/assets/app.js");
    expect(await asset.text()).toBe("console.log(1)");
    expect((await app.request("/api/nothing")).status).toBe(404);
  });
});

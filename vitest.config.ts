import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The browser suite in apps/e2e runs under Playwright, not here.
    projects: ["packages/*", "apps/*", "!apps/e2e", "docs/site"],
  },
});

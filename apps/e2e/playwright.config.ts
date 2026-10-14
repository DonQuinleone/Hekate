import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createArgosReporterOptions } from "@argos-ci/playwright/reporter";
import { defineConfig } from "@playwright/test";

/**
 * The visual suite: the real app, seeded with known music, captured screen by screen at
 * desktop and phone width. Every capture also has its layout and accessibility checked
 * (tests/checks.ts), and goes to Argos, which compares it with master's and asks for
 * approval on any change. Without an Argos token the checks still run; nothing is compared.
 */
const PORT = 3990;
const state = join(import.meta.dirname, ".state");
// Each run starts from nothing: an empty store, a fresh key. Workers load this file too,
// after the seed has run, and must leave it be.
if (!process.env.E2E_REUSE && process.env.TEST_WORKER_INDEX === undefined) {
  rmSync(state, { recursive: true, force: true });
  mkdirSync(join(state, "storage"), { recursive: true });
}

export default defineConfig({
  testDir: "tests",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  reporter: [
    [process.env.CI ? "github" : "list"],
    [
      "@argos-ci/playwright/reporter",
      createArgosReporterOptions({ uploadToArgos: Boolean(process.env.ARGOS_TOKEN) }),
    ],
  ],
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: "en-GB",
    timezoneId: "Europe/London",
    colorScheme: "dark",
    reducedMotion: "reduce",
    launchOptions: {
      // The same glyphs on every machine.
      args: ["--disable-lcd-text", "--font-render-hinting=none"],
      // A browser of the machine's own, where Playwright's download is not wanted.
      ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}),
    },
  },
  projects: [
    { name: "seed", testMatch: /seed\.setup\.ts/ },
    {
      name: "desktop",
      dependencies: ["seed"],
      use: { viewport: { width: 1440, height: 900 }, storageState: join(state, "owner.json") },
    },
    {
      name: "phone",
      dependencies: ["seed"],
      use: {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        storageState: join(state, "owner.json"),
      },
    },
  ],
  webServer: {
    // The log is kept: without a mail server, the links guests are sent are written there.
    command: `node src/index.ts 2>&1 | tee "${join(state, "server.log")}"`,
    cwd: join(import.meta.dirname, "../server"),
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: Boolean(process.env.E2E_REUSE),
    timeout: 120_000,
    stdout: "pipe",
    env: {
      PORT: String(PORT),
      PUBLIC_URL: `http://localhost:${PORT}`,
      DATABASE_URL: process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? "",
      AUTH_SECRET: randomBytes(32).toString("hex"),
      MASTER_KEY: randomBytes(32).toString("base64"),
      STORAGE_LOCAL_PATH: join(state, "storage"),
      WEB_DIST: join(import.meta.dirname, "../web/dist"),
      MIGRATE_ON_START: "true",
      NO_PROXY: "localhost,127.0.0.1",
    },
  },
});

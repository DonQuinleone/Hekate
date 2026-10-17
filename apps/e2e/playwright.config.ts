import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import { INSTALL_PORT, SETUP_CODE } from "./constants.ts";

/**
 * The visual suite: the real app, seeded with known music, captured screen by screen at
 * desktop and phone width. Every capture also has its layout and accessibility checked
 * (tests/checks.ts) and is saved under test-results/screens for anyone to look at.
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
  reporter: [[process.env.CI ? "github" : "list"]],
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
    // A clean server, from the setup code to its first workspace.
    {
      name: "install",
      testMatch: /install\.spec\.ts/,
      use: { viewport: { width: 1440, height: 900 }, baseURL: `http://localhost:${INSTALL_PORT}` },
    },
    { name: "seed", testMatch: /seed\.setup\.ts/ },
    {
      name: "desktop",
      dependencies: ["seed"],
      testIgnore: /install\.spec\.ts/,
      use: { viewport: { width: 1440, height: 900 }, storageState: join(state, "owner.json") },
    },
    {
      name: "phone",
      dependencies: ["seed"],
      testIgnore: /install\.spec\.ts/,
      use: {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        storageState: join(state, "owner.json"),
      },
    },
  ],
  webServer: [
    {
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
        // Given, when CI restores the instance afterwards and needs the key that wrapped it.
        MASTER_KEY: process.env.E2E_MASTER_KEY ?? randomBytes(32).toString("base64"),
        STORAGE_LOCAL_PATH: join(state, "storage"),
        WEB_DIST: join(import.meta.dirname, "../web/dist"),
        MIGRATE_ON_START: "true",
        // The suite never depends on a service outside the machine.
        PASSWORD_LEAK_CHECK: "false",
        HEKATE_SETUP_CODE: SETUP_CODE,
        // Never a settings file left by a development install.
        HEKATE_SETTINGS_FILE: join(state, "hekate.env"),
        NO_PROXY: "localhost,127.0.0.1",
      },
    },
    {
      // No database and no master key: the server installs, and the suite walks it through.
      command: `node src/index.ts 2>&1 | tee "${join(state, "install.log")}"`,
      cwd: join(import.meta.dirname, "../server"),
      url: `http://localhost:${INSTALL_PORT}/api/health`,
      reuseExistingServer: Boolean(process.env.E2E_REUSE),
      timeout: 120_000,
      stdout: "pipe",
      env: {
        PORT: String(INSTALL_PORT),
        HEKATE_SETTINGS_FILE: join(state, "install", "hekate.env"),
        HEKATE_SETUP_CODE: SETUP_CODE,
        // Nothing configured, whatever the shell running the suite has set: the installer does it.
        DATABASE_URL: "",
        MASTER_KEY: "",
        AUTH_SECRET: "",
        PUBLIC_URL: "",
        STORAGE_LOCAL_PATH: "",
        WEB_DIST: join(import.meta.dirname, "../web/dist"),
        PASSWORD_LEAK_CHECK: "false",
        NO_PROXY: "localhost,127.0.0.1",
      },
    },
  ],
});

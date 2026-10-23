import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { SETUP_CODE } from "../constants.ts";
import { checkScreen } from "./checks.ts";
import { saveScreen, state } from "./fixtures.ts";

/**
 * A clean server, from its setup code to its first workspace, through the installer alone
 * (#127). Each step is checked and captured at desktop and phone width as it is reached.
 */

/** An empty database beside the suite's own, for the installer to be given. */
async function emptyDatabase() {
  const url = process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
  const target = new URL(url);
  const name = `${target.pathname.slice(1)}_install`;
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`drop database if exists "${name}" with (force)`);
    await sql.unsafe(`create database "${name}"`);
  } finally {
    await sql.end();
  }
  target.pathname = `/${name}`;
  return target.toString();
}

async function capture(page: Page, name: string) {
  for (const [suffix, viewport] of [
    ["", { width: 1440, height: 900 }],
    ["-phone", { width: 390, height: 844 }],
  ] as const) {
    await page.setViewportSize(viewport);
    await checkScreen(page);
    await saveScreen(page, `${name}${suffix}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

const heading = (page: Page, name: string) =>
  expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
const proceed = (page: Page, name = "Continue") => page.getByRole("button", { name }).click();

test("a clean server installs through the browser alone", async ({ page }) => {
  test.setTimeout(240_000);
  const databaseUrl = await emptyDatabase();
  const storagePath = join(state, "install", "storage");
  mkdirSync(storagePath, { recursive: true });

  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await heading(page, "Requirements");
  await expect(page.getByLabel("Setup code")).toBeVisible();
  await capture(page, "install-code");
  await page.getByLabel("Setup code").fill("AAAA-AAAA-AAAA");
  await proceed(page);
  await expect(page.getByRole("alert")).toContainText("not the setup code");
  await page.getByLabel("Setup code").fill(SETUP_CODE.toLowerCase());
  await proceed(page);

  // Requirements: what the image and the host give.
  await expect(page.getByText("Node.js 26")).toBeVisible();
  await expect(page.getByText("Writable settings directory")).toBeVisible();
  await capture(page, "install-requirements");
  await proceed(page);

  // Database: tested, migrated and saved.
  await heading(page, "Database");
  await page.getByLabel("Connection").fill(databaseUrl);
  await page.getByRole("button", { name: "Test the connection" }).click();
  await expect(page.getByText("Migrated")).toBeVisible({ timeout: 60_000 });
  await capture(page, "install-database");
  await proceed(page);

  // Storage: a local directory, written to and read back.
  await heading(page, "Storage");
  await page.getByLabel("Path").fill(storagePath);
  await page.getByRole("button", { name: "Write and read a test object" }).click();
  await expect(page.getByText("Wrote and read a test object")).toBeVisible();
  await capture(page, "install-storage");
  await proceed(page);

  // The master key: made in the browser, and not saved until it is said to be stored.
  await heading(page, "Master key");
  await expect(page.getByTestId("master-key")).toHaveText(/^[A-Za-z0-9+/]{43}=$/);
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  await capture(page, "install-master-key");
  await page.getByLabel("I have stored the master key").check();
  await proceed(page);

  // Mail: Microsoft 365 asks for an app registration, as Graph sends for it (#71).
  await heading(page, "Mail");
  await page.getByLabel("Provider").selectOption("microsoft");
  await page.getByLabel("Directory (tenant) ID").fill("endlesshall.onmicrosoft.com");
  await capture(page, "install-mail-microsoft");
  // Written to the log here, with a test message first.
  await page.getByLabel("Provider").selectOption("log");
  await page.getByLabel("From").fill("Hekate <hekate@endlesshall.example>");
  await page.getByLabel("Send a test to").fill("mira@endlesshall.example");
  await page.getByRole("button", { name: "Send a test message" }).click();
  await expect(page.getByText("written to the log", { exact: true })).toBeVisible();
  await capture(page, "install-mail");
  await proceed(page);

  // The address: this server answers at it, so the rest of the server can start.
  await heading(page, "Address");
  await page.getByRole("button", { name: "Check the address" }).click();
  await expect(page.getByText("it is this server", { exact: true })).toBeVisible();
  await capture(page, "install-address");
  await proceed(page, "Save and start Hekate");

  // The first workspace and its owner; the code is not asked for twice.
  await heading(page, "First workspace");
  await expect(page.getByLabel("Setup code")).toHaveCount(0);
  await capture(page, "install-owner");
  await page.getByLabel("Workspace").fill("Endless Hall Records");
  await page.getByLabel("Your name").fill("Alex Rivera");
  await page.getByLabel("Email").fill("producer@example.test");
  await page.getByLabel(/^Password/).fill("correct horse battery");
  await page.getByLabel("Confirm password").fill("correct horse battery");
  await proceed(page, "Create and finish");
  await heading(page, "Hekate is ready");
  await capture(page, "install-ready");
  await proceed(page, "Open Hekate");
  await expect(page.getByText("Nothing here yet")).toBeVisible();

  // Installed, it never installs again.
  const res = await page.request.post("/api/install/finish", {
    headers: { "x-hekate-setup-code": SETUP_CODE },
  });
  expect(res.status()).toBe(409);
});

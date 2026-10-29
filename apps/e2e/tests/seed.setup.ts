import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test as setup } from "@playwright/test";
import postgres from "postgres";
import { apiOf, type Client, type Session, seed } from "../../server/src/demo/seed.ts";
import { SETUP_CODE } from "../constants.ts";
import { checkScreen } from "./checks.ts";
import { FIXED_TIME, saveScreen, state } from "./fixtures.ts";

/**
 * Seeds the instance the screens are captured from: the server's own seed (decision 265),
 * driven through Playwright's request contexts, with the captures only this run can take: the
 * setup form, the empty home, and what a suspended workspace's owner is told.
 */

/** A session on one browser context: its request context for the API, its page for captures. */
interface PageSession extends Session {
  page: Page;
}

function pageSession(page: Page, close?: () => Promise<void>): PageSession {
  const fetch: Session["fetch"] = async (path, init = {}) => {
    const response = await page.request.fetch(path, {
      method: init.method ?? "GET",
      headers: init.headers,
      data:
        init.body === undefined
          ? undefined
          : typeof init.body === "string"
            ? init.body
            : Buffer.from(init.body),
    });
    return {
      status: response.status(),
      ok: response.ok(),
      text: () => response.text(),
      json: () => response.json(),
    };
  };
  return { page, fetch, api: apiOf(fetch), close };
}

/** The screen at both widths, checked and kept, the page left at desktop width. */
async function captureBoth(page: Page, name: string) {
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

setup("seed", async ({ page, browser }) => {
  setup.setTimeout(300_000);
  // The first person sets up the organisation; the form is only there once, so it is
  // captured here, at both widths, before the seed submits it through the API.
  await page.clock.setFixedTime(FIXED_TIME);
  await page.goto("/setup");
  await expect(page.getByLabel("Workspace")).toBeVisible();
  await captureBoth(page, "setup");

  const client: Client<PageSession> = {
    owner: pageSession(page),
    session: async () => {
      const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
      return pageSession(await context.newPage(), () => context.close());
    },
  };
  const sql = postgres(process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? "", {
    onnotice: () => undefined,
  });
  try {
    const seeded = await seed({
      client,
      setupCode: SETUP_CODE,
      sql,
      media: join(state, "media"),
      // A new workspace lands on an empty home that says what to do first.
      afterSetup: async () => {
        await page.goto("/");
        await expect(page.getByText("Nothing here yet")).toBeVisible();
        await captureBoth(page, "home-empty");
      },
      // The link the guest was sent, which the log holds without a mail server.
      guestLink: async () => {
        for (let tries = 0; tries < 30; tries++) {
          const link = readFileSync(join(state, "server.log"), "utf8")
            .match(/\/guest\/[A-Za-z0-9_-]{16,}/g)
            ?.at(-1);
          if (link) return link;
          await page.waitForTimeout(500);
        }
        throw new Error("No guest link in the server log");
      },
      // The guest's sign-in, kept for the screens a guest sees.
      afterGuest: async (guest) => {
        await guest.page.context().storageState({ path: join(state, "guest.json") });
      },
      // Lantern Pictures' owner, told their workspace is suspended, and why.
      afterSuspended: async (lantern) => {
        await lantern.page.clock.setFixedTime(FIXED_TIME);
        await lantern.page.goto("/");
        await lantern.page.waitForURL(/\/suspended$/);
        await expect(lantern.page.getByText("Lantern Pictures is suspended")).toBeVisible();
        await captureBoth(lantern.page, "suspended");
      },
    });
    writeFileSync(join(state, "seeded.json"), JSON.stringify(seeded, null, 2));
  } finally {
    await sql.end();
  }
  await page.context().storageState({ path: join(state, "owner.json") });
});

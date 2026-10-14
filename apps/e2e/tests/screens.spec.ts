import { argosScreenshot } from "@argos-ci/playwright";
import { expect, type Page, test } from "@playwright/test";
import { checkScreen } from "./checks.ts";
import { FIXED_TIME, type Seeded, seeded } from "./fixtures.ts";

/**
 * Every screen, as the seeded studio sees it: checked for layout and accessibility, then
 * captured for Argos to compare with master's.
 */

interface Screen {
  name: string;
  path: (s: Seeded) => string;
  /** What has to be on the screen before it is ready to capture. */
  ready: string;
  /** Leave the session out: the screen someone signed out sees. */
  signedOut?: boolean;
}

const screens: Screen[] = [
  { name: "sign-in", path: () => "/sign-in", ready: "form", signedOut: true },
  { name: "projects", path: () => "/", ready: "main a:has-text('Joplin Rags')" },
  {
    name: "project-music",
    path: (s) => `/projects/${s.musicProjectId}`,
    ready: "main a:has-text('Maple Leaf Rag - Score.pdf')",
  },
  {
    name: "project-video",
    path: (s) => `/projects/${s.videoProjectId}`,
    ready: "main a:has-text('Opening titles - Cut 3.mp4')",
  },
  { name: "track", path: (s) => `/tracks/${s.trackId}`, ready: "text=Bars 12 to 16" },
  {
    name: "file-recording",
    path: (s) => `/files/${s.dryFileId}`,
    ready: "section[aria-label=Comments] li",
  },
  {
    name: "file-score",
    path: (s) => `/files/${s.scoreFileId}`,
    ready: "section[aria-label=Comments] li",
  },
  {
    name: "file-video",
    path: (s) => `/files/${s.cutFileId}`,
    ready: "section[aria-label=Comments] li",
  },
  { name: "review", path: (s) => `/reviews/${s.reviewId}`, ready: "h1:has-text('Album masters')" },
  { name: "my-reviews", path: () => "/reviews", ready: "text=Album masters" },
  { name: "members", path: () => "/members", ready: "main >> text=Alex Rivera" },
];

/** Fonts in, pictures drawn, nothing still on its way. */
async function settle(page: Page, ready: string) {
  await expect(page.locator(ready).first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.evaluate(async () => {
    await document.fonts.ready;
    // Pictures drawn lazily below the fold load when scrolled to, not before.
    const eager = [...document.images].filter((img) => !img.complete && img.loading !== "lazy");
    await Promise.race([
      Promise.all(eager.map((img) => img.decode().catch(() => undefined))),
      new Promise((done) => setTimeout(done, 10_000)),
    ]);
  });
}

/**
 * The app scrolls inside its main area, not the document, so a full-page capture would
 * stop at the window: grow the window until the main area holds everything.
 */
async function showWhole(page: Page) {
  const hidden = await page.evaluate(() => {
    const main = document.querySelector("main");
    return main ? main.scrollHeight - main.clientHeight : 0;
  });
  const size = page.viewportSize();
  if (hidden > 0 && size) await page.setViewportSize({ ...size, height: size.height + hidden });
}

function capture(screen: Screen) {
  test(screen.name, async ({ page }) => {
    await page.clock.setFixedTime(FIXED_TIME);
    await page.goto(screen.path(seeded()));
    await settle(page, screen.ready);
    await showWhole(page);
    await settle(page, screen.ready);
    await checkScreen(page);
    await argosScreenshot(page, screen.name);
  });
}

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  for (const screen of screens.filter((s) => s.signedOut)) capture(screen);
});

for (const screen of screens.filter((s) => !s.signedOut)) capture(screen);

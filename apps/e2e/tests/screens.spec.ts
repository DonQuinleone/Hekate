import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { checkScreen } from "./checks.ts";
import { FIXED_TIME, type Seeded, saveScreen, seeded, state } from "./fixtures.ts";

/**
 * Every screen, as the seeded studio sees it: checked for layout and accessibility, then
 * captured to test-results/screens.
 */

interface Screen {
  name: string;
  path: (s: Seeded) => string;
  /** What has to be on the screen before it is ready to capture. */
  ready: string;
  /** Whose screen it is: the owner's, someone signed out, or a guest reviewer's. */
  as?: "owner" | "signed-out" | "guest";
}

const screens: Screen[] = [
  { name: "sign-in", path: () => "/sign-in", ready: "form", as: "signed-out" },
  {
    name: "invitation",
    path: (s) => s.invitationPath,
    ready: "text=Join Endless Hall Records",
    as: "signed-out",
  },
  { name: "guest-signed-out", path: () => "/guest", ready: "h1", as: "signed-out" },
  {
    name: "guest-link-used",
    path: (s) => s.usedGuestPath,
    ready: "text=This link no longer works",
    as: "signed-out",
  },
  { name: "guest-reviews", path: () => "/g", ready: "text=Album masters", as: "guest" },
  {
    name: "guest-review",
    path: (s) => `/g/reviews/${s.reviewId}`,
    ready: "h1:has-text('Album masters')",
    as: "guest",
  },
  {
    name: "guest-file",
    path: (s) => `/g/files/${s.dryFileId}`,
    ready: "section[aria-label=Comments]",
    as: "guest",
  },
  { name: "home", path: () => "/", ready: "main section[aria-label=Activity] li a" },
  { name: "projects", path: () => "/projects", ready: "main a:has-text('Joplin Rags')" },
  {
    name: "projects-list",
    path: () => "/projects?view=list&sort=name",
    ready: "main a:has-text('Joplin Rags')",
  },
  { name: "project-new", path: () => "/projects?new=1", ready: "[role=dialog] >> text=Start from" },
  {
    name: "notifications",
    path: () => "/notifications",
    ready: "main >> text=mentioned you on Maple Leaf Rag - Dry v2.wav",
  },
  {
    name: "account",
    path: () => "/account/account",
    ready: "main >> text=Endless Hall Records",
  },
  {
    name: "account-sessions",
    path: () => "/account/sessions",
    ready: "main >> text=This browser",
  },
  {
    name: "account-appearance",
    path: () => "/account/appearance",
    ready: "main >> text=Skip by",
  },
  {
    name: "account-notifications",
    path: () => "/account/notifications",
    ready: "main >> text=Maple Leaf Rag",
  },
  {
    name: "project-overview",
    path: (s) => `/projects/${s.musicProjectId}`,
    ready: "main section[aria-label='Needs attention'] li",
  },
  {
    name: "project-overview-video",
    path: (s) => `/projects/${s.videoProjectId}`,
    ready: "main section[aria-label='Activity'] li",
  },
  {
    name: "project-music",
    path: (s) => `/projects/${s.musicProjectId}/files`,
    ready: "main a:has-text('Maple Leaf Rag - Score.pdf')",
  },
  {
    name: "project-reviews",
    path: (s) => `/projects/${s.musicProjectId}/reviews`,
    ready: "main >> text=Album masters",
  },
  {
    name: "project-people",
    path: (s) => `/projects/${s.musicProjectId}/people`,
    ready: "main >> text=Alex Rivera",
  },
  {
    name: "project-video",
    path: (s) => `/projects/${s.videoProjectId}/files`,
    ready: "main a:has-text('Opening titles - Cut 3.mp4')",
  },
  { name: "track", path: (s) => `/tracks/${s.trackId}`, ready: "text=Bars 12 to 16" },
  {
    name: "file-recording",
    path: (s) => `/files/${s.dryFileId}`,
    ready: "section[aria-label=Comments] li",
  },
  {
    name: "file-recording-qa",
    path: (s) => `/files/${s.dryFileId}?view=qa`,
    ready: "section[aria-label=Checks] h2",
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
  { name: "inbox", path: () => "/inbox", ready: "main a:has-text('Album masters')" },
  {
    name: "inbox-review",
    path: (s) => `/inbox?item=${s.reviewId}`,
    ready: "section[aria-label=Review] >> text=Your decision",
  },
  {
    name: "search",
    path: (s) => `/search?q=maple&projectId=${s.musicProjectId}`,
    ready: "main section[aria-label=Files] a",
  },
  { name: "members", path: () => "/settings/members", ready: "main >> text=Alex Rivera" },
  {
    name: "settings-general",
    path: () => "/settings/general",
    ready: "main >> text=Workspaces you are in",
  },
  {
    name: "settings-storage",
    path: () => "/settings/storage",
    ready: "main >> text=New files go to",
  },
  { name: "settings-log", path: () => "/settings/log", ready: "main [data-log-entry]" },
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
    // Captured first, so a screen that fails its checks still leaves a picture to look at.
    await saveScreen(page, screen.name);
    await checkScreen(page);
  });
}

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  for (const screen of screens.filter((s) => s.as === "signed-out")) capture(screen);
});

test.describe("guest", () => {
  test.use({ storageState: join(state, "guest.json") });
  for (const screen of screens.filter((s) => s.as === "guest")) capture(screen);
});

for (const screen of screens.filter((s) => !s.as || s.as === "owner")) capture(screen);

// The bell's panel, open over the list it leads to.
test("bell", async ({ page }) => {
  await page.clock.setFixedTime(FIXED_TIME);
  await page.goto("/notifications");
  await settle(page, "main section li a");
  await showWhole(page);
  await page.getByRole("button", { name: /^Notifications/ }).click();
  await settle(page, "[role=dialog][aria-label=Notifications] li a");
  await saveScreen(page, "bell");
  await checkScreen(page);
});

// The command palette, as it opens and with results from the server.
for (const [name, typed, ready] of [
  ["palette", "", "[role=option]:has-text('Inbox')"],
  ["palette-search", "maple", "[role=option]:has-text('Maple Leaf Rag - Dry v2.wav')"],
] as const) {
  test(name, async ({ page }) => {
    await page.clock.setFixedTime(FIXED_TIME);
    await page.goto("/projects");
    await settle(page, "main a:has-text('Joplin Rags')");
    await page.keyboard.press("ControlOrMeta+k");
    const box = page.getByRole("combobox", { name: "Search and commands" });
    await expect(box).toBeFocused();
    if (typed) await box.fill(typed);
    await settle(page, `[role=dialog][aria-label='Search and commands'] ${ready}`);
    // The panel rises in; checked half-faded, its text would read as low contrast.
    await page.waitForFunction(() =>
      document.getAnimations().every((a) => a.playState !== "running"),
    );
    await saveScreen(page, name);
    await checkScreen(page);
  });
}

// The file browser's other views: columns opened down to a version, and the grid.
test("project-files-columns", async ({ page }) => {
  await page.clock.setFixedTime(FIXED_TIME);
  await page.goto(`/projects/${seeded().musicProjectId}/files`);
  await settle(page, "main a:has-text('Maple Leaf Rag - Score.pdf')");
  await page.getByRole("button", { name: "Columns", exact: true }).click();
  await page
    .getByRole("button", { name: /^Maple Leaf Rag/ })
    .first()
    .click();
  await page.getByRole("button", { name: /^V2/ }).click();
  await settle(page, "main dl >> text=Variations");
  await saveScreen(page, "project-files-columns");
  await checkScreen(page);
});

// Filters look across the project; the menu says what is on. On a phone the open menu covers
// the list it filters, so that capture shows the list and its chips instead.
test("project-files-filtered", async ({ page }, info) => {
  await page.clock.setFixedTime(FIXED_TIME);
  await page.goto(`/projects/${seeded().musicProjectId}/files?show=comments`);
  await settle(page, "main ul[aria-label=Filters]");
  if (info.project.name !== "phone") {
    await page.getByRole("button", { name: /^Filter/ }).click();
    await settle(page, "[role=dialog][aria-label='Filter files']");
  }
  await saveScreen(page, "project-files-filtered");
  await checkScreen(page);
});

test("project-files-tags", async ({ page }) => {
  await page.clock.setFixedTime(FIXED_TIME);
  await page.goto(`/projects/${seeded().musicProjectId}/files`);
  await settle(page, "main a:has-text('Maple Leaf Rag - Score.pdf')");
  await page.getByRole("button", { name: "Actions for Maple Leaf Rag - Score.pdf" }).click();
  await page.getByRole("menuitem", { name: "Tags…" }).click();
  await settle(page, "main fieldset >> text=Reference");
  await saveScreen(page, "project-files-tags");
  await checkScreen(page);
});

test("project-files-grid", async ({ page }) => {
  await page.clock.setFixedTime(FIXED_TIME);
  await page.goto(`/projects/${seeded().musicProjectId}/files`);
  await settle(page, "main a:has-text('Maple Leaf Rag - Score.pdf')");
  await page.getByRole("button", { name: "Grid" }).click();
  await settle(page, "main ul[aria-label=Contents] li");
  await showWhole(page);
  await saveScreen(page, "project-files-grid");
  await checkScreen(page);
});

// Two rows chosen: the selection bar floats at the foot of the list.
test("project-files-selected", async ({ page }) => {
  await page.clock.setFixedTime(FIXED_TIME);
  await page.goto(`/projects/${seeded().musicProjectId}/files`);
  await settle(page, "main a:has-text('Maple Leaf Rag - Score.pdf')");
  await page.getByRole("checkbox", { name: "Select The Entertainer" }).click();
  await page.getByRole("checkbox", { name: "Select Maple Leaf Rag - Score.pdf" }).click();
  await settle(page, "[role=toolbar][aria-label=Selection]");
  await saveScreen(page, "project-files-selected");
  await checkScreen(page);
});

// The list's columns, with Tags and Duration added; phones show no columns to choose.
test("project-files-columns-menu", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "A phone shows names only");
  await page.clock.setFixedTime(FIXED_TIME);
  await page.goto(`/projects/${seeded().musicProjectId}/files`);
  await settle(page, "main a:has-text('Maple Leaf Rag - Score.pdf')");
  await page.getByRole("button", { name: "Choose columns" }).click();
  const menu = page.getByRole("dialog", { name: "Columns" });
  await menu.getByRole("switch", { name: "Tags" }).click();
  await menu.getByRole("switch", { name: "Duration" }).click();
  await settle(page, "main >> text=Duration");
  await expect(menu.getByRole("switch", { name: "Duration" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await saveScreen(page, "project-files-columns-menu");
  await checkScreen(page);
  // Put the list back as it was for the captures that follow.
  await menu.getByRole("button", { name: "Reset" }).click();
});

// A file whose preparation failed says so, with a way to try again; put back as seeded after.
test("project-files-failed", async ({ page }, info) => {
  const sql = postgres(process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? "", { max: 1 });
  const { scoreFileId, musicProjectId } = seeded();
  const [before] = await sql<{ stream_status: string }[]>`
    update files set stream_status = 'failed' where id = ${scoreFileId}
    returning (select stream_status from files where id = ${scoreFileId})`;
  try {
    await page.clock.setFixedTime(FIXED_TIME);
    await page.goto(`/projects/${musicProjectId}/files`);
    // A phone has no status column; there the row's menu offers to try again.
    await settle(page, "main a:has-text('Maple Leaf Rag - Score.pdf')");
    if (info.project.name !== "phone") await settle(page, "main button:has-text('Retry')");
    await saveScreen(page, "project-files-failed");
    await checkScreen(page);
  } finally {
    await sql`update files set stream_status = ${before?.stream_status ?? "ready"} where id = ${scoreFileId}`;
    await sql.end();
  }
});

// A loose file put into a track, as its next version or beside the latest.
test("project-files-attach", async ({ page }) => {
  await page.clock.setFixedTime(FIXED_TIME);
  await page.goto(`/projects/${seeded().musicProjectId}/files`);
  await settle(page, "main a:has-text('Maple Leaf Rag - Score.pdf')");
  await page.getByRole("button", { name: "Actions for Maple Leaf Rag - Score.pdf" }).click();
  await page.getByRole("menuitem", { name: "Attach to a track…" }).click();
  await settle(page, "main form[aria-label='Attach to a track']");
  await saveScreen(page, "project-files-attach");
  await checkScreen(page);
});

// The details sheet opens only when asked for.
test("file-without-details", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "Once is enough");
  await page.goto(`/files/${seeded().dryFileId}`);
  await settle(page, "section[aria-label=Comments] li");
  await expect(page.locator("aside[aria-label=Details]")).toHaveCount(0);
  await page.getByRole("button", { name: "Details" }).click();
  await expect(page.locator("aside[aria-label=Details]")).toBeVisible();
});

// A file's details beside it: facts, storage, renditions, where it is used, its own log.
test("file-details", async ({ page }) => {
  await page.clock.setFixedTime(FIXED_TIME);
  await page.goto(`/files/${seeded().dryFileId}?sheet=details`);
  await settle(page, "aside[aria-label=Details] >> text=Renditions");
  await settle(page, "aside[aria-label=Details] >> text=Access");
  await saveScreen(page, "file-details");
  await checkScreen(page);
});

import { createHash } from "node:crypto";
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
    name: "sign-in-expired",
    path: () => "/sign-in?reason=expired&redirect=%2Finbox",
    ready: "text=You were signed out",
    as: "signed-out",
  },
  {
    name: "sign-in-forgot",
    path: () => "/sign-in?view=forgot",
    ready: "text=Forgotten your password?",
    as: "signed-out",
  },
  {
    name: "sign-in-sent",
    path: () => "/sign-in?view=sent&email=producer%40example.test",
    ready: "text=Check your email",
    as: "signed-out",
  },
  {
    name: "sign-in-reset",
    path: () => "/sign-in?view=reset&email=producer%40example.test&code=123456",
    ready: "text=Set a new password",
    as: "signed-out",
  },
  // The design system reference (built in for the suite only).
  {
    name: "sign-in-code",
    path: () => "/sign-in?view=code",
    ready: "text=Enter your code",
    as: "signed-out",
  },
  {
    name: "sign-in-recovery",
    path: () => "/sign-in?view=recovery",
    ready: "text=Use a recovery code",
    as: "signed-out",
  },
  { name: "reference", path: () => "/reference", ready: "main h1", as: "signed-out" },
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
    name: "account-security",
    path: () => "/account/security",
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
    ready: "main >> text=Guest links last",
  },
  {
    name: "settings-defaults",
    path: () => "/settings/defaults",
    ready: "main >> text=Access window",
  },
  {
    name: "settings-security",
    path: () => "/settings/security",
    ready: "main >> text=Second factor required of",
  },
  {
    name: "settings-email",
    path: () => "/settings/email",
    ready: "main iframe[title*='light mail client']",
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

// Each message in a dark client and as plain text, which matters as much as the HTML.
test("settings-email-dark-and-text", async ({ page }) => {
  await page.goto("/settings/email");
  await settle(page, "main iframe[title*='light mail client']");
  await page.getByRole("button", { name: "Dark client" }).click();
  await settle(page, "main iframe[title*='dark mail client']");
  await saveScreen(page, "settings-email-dark");
  await checkScreen(page);
  await page.getByRole("button", { name: "Plain text" }).click();
  await settle(page, "main pre >> text=Open the review:");
  await saveScreen(page, "settings-email-text");
  await checkScreen(page);
});

// The player's keys, the "?" map listing exactly them, and nothing firing while typing.
test("shortcuts", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "Keys belong to a keyboard");
  await page.clock.setFixedTime(FIXED_TIME);
  await page.goto(`/files/${seeded().dryFileId}`);
  await settle(page, "section[aria-label=Comments] li");
  const media = page.locator("main audio, main video").first();
  await page.waitForFunction(
    () =>
      ((document.querySelector("main audio, main video") as HTMLMediaElement | null)?.readyState ??
        0) >= 1,
  );
  const time = () => media.evaluate((m: HTMLMediaElement) => m.currentTime);

  // The map lists what works here, and nothing from elsewhere.
  await page.keyboard.press("?");
  const map = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(map).toBeVisible();
  await expect(map.getByRole("region", { name: "Player" })).toContainText("Play or pause");
  await expect(map.getByRole("region", { name: "Comments" })).toContainText(
    "Comment at the playhead",
  );
  await expect(map.getByRole("region", { name: "Files" })).toHaveCount(0);
  await saveScreen(page, "shortcuts");
  await checkScreen(page);
  // Behind the map, the page's keys wait.
  await page.keyboard.press(".");
  expect(await time()).toBe(0);
  await page.keyboard.press("Escape");
  await expect(map).toBeHidden();

  // Full stop and comma step; l and j jump by the chosen step.
  await page.keyboard.press(".");
  await page.keyboard.press(".");
  await expect.poll(time).toBeCloseTo(0.02, 3);
  await page.keyboard.press(",");
  await expect.poll(time).toBeCloseTo(0.01, 3);
  await page.keyboard.press("l");
  await expect.poll(time).toBeGreaterThan(1);
  await page.keyboard.press("j");
  await expect.poll(time).toBeLessThan(1);

  // i and o set the loop at the playhead.
  await page.keyboard.press("l");
  await page.keyboard.press("i");
  await expect(page.getByRole("region", { name: "Loop" })).toBeVisible();

  // c starts a comment at the playhead; in the field, the keys are just letters.
  await page.keyboard.press("c");
  const field = page.getByRole("textbox", { name: "Comment at the playhead" });
  await expect(field).toBeFocused();
  const before = await time();
  await page.keyboard.type("lj. k");
  await expect(field).toHaveValue("lj. k");
  expect(await time()).toBe(before);
  expect(await media.evaluate((m: HTMLMediaElement) => m.paused)).toBe(true);
  await field.fill("");
  await field.blur();

  // g then h goes home.
  await page.keyboard.press("g");
  await page.keyboard.press("h");
  await expect(page).toHaveURL(/\/$/);
});

// On a phone the composer is a sheet, opened from a button, so the comments stay in view.
test("file-comment-sheet", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "A sheet on phones only");
  await page.clock.setFixedTime(FIXED_TIME);
  await page.goto(`/files/${seeded().dryFileId}`);
  await settle(page, "section[aria-label=Comments] li");
  await page.getByRole("button", { name: "Comment at the playhead" }).click();
  const sheet = page.getByRole("dialog", { name: "Comment at the playhead" });
  await expect(sheet.getByRole("textbox", { name: "Comment at the playhead" })).toBeVisible();
  await saveScreen(page, "file-comment-sheet");
  await checkScreen(page);
  // With a keyboard, c opens the same sheet, ready to type in.
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toBeHidden();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("c");
  await expect(sheet.getByRole("textbox", { name: "Comment at the playhead" })).toBeFocused();
});

// Adding a code app from the account page: the password, then the code to scan. Cancelled
// there, so the account stays as seeded.
test("account-second-factor", async ({ page }) => {
  await page.goto("/account/security");
  await settle(page, "main >> text=Code app");
  await page.getByRole("button", { name: "Set up…" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a code app" });
  await dialog.getByLabel("Password").fill("correct horse battery");
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("dialog", { name: "Scan the code" })).toBeVisible();
  await expect(page.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
  await saveScreen(page, "account-second-factor");
  await checkScreen(page);
  await page.getByRole("button", { name: "Cancel" }).click();
});

// A workspace that asks for a second factor holds back a member without one until they add
// it. Asked for directly in the database, and put back after.
test("second-factor-required", async ({ page }) => {
  const sql = postgres(process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? "", { max: 1 });
  const [before] = await sql<{ id: string; settings: Record<string, postgres.JSONValue> | null }[]>`
    select id, settings from organisations where name = 'Endless Hall Records'`;
  try {
    await sql`update organisations set settings = ${sql.json({ ...before?.settings, secondFactor: "everyone" })}
      where id = ${before?.id ?? ""}`;
    await page.goto("/");
    await expect(page).toHaveURL(/\/second-factor$/);
    await settle(page, "text=asks you to sign in with a second factor");
    await saveScreen(page, "second-factor-required");
    await checkScreen(page);
  } finally {
    await sql`update organisations set settings = ${sql.json(before?.settings ?? {})} where id = ${before?.id ?? ""}`;
    await sql.end();
  }
});

// Where the workspace asks for a code, a guest's link sends one and waits for it. A link made
// in the database for the seeded guest, and the setting, are put back after.
test.describe("guest code", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test("guest-code", async ({ page }) => {
    const sql = postgres(process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? "", {
      max: 1,
    });
    const token = `e2e-guest-code-${test.info().project.name}-0123456789`;
    const [workspace] = await sql<
      { id: string; settings: Record<string, postgres.JSONValue> | null }[]
    >`select id, settings from organisations where name = 'Endless Hall Records'`;
    const [guest] = await sql<{ id: string }[]>`
      select id from guests where email = 'mira@example.test'`;
    try {
      await sql`update organisations set settings = ${sql.json({ ...workspace?.settings, guestVerification: "code" })}
        where id = ${workspace?.id ?? ""}`;
      await sql`insert into guest_links (id, organisation_id, guest_id, token_hash, expires_at)
        values (gen_random_uuid(), ${workspace?.id ?? ""}, ${guest?.id ?? ""},
          ${createHash("sha256").update(token).digest("hex")}, now() + interval '1 day')`;
      await page.goto(`/guest/${token}`);
      await settle(page, "text=Check your email");
      await expect(page.getByText("m•••@example.test", { exact: false })).toBeVisible();
      await saveScreen(page, "guest-code");
      await checkScreen(page);
    } finally {
      await sql`update organisations set settings = ${sql.json(workspace?.settings ?? {})} where id = ${workspace?.id ?? ""}`;
      await sql`delete from guest_links where token_hash = ${createHash("sha256").update(token).digest("hex")}`;
      await sql.end();
    }
  });
});

// Deleting your account asks for the address typed out and the password; opened, not sent.
test("account-delete", async ({ page }) => {
  await page.goto("/account/account");
  await settle(page, "main >> text=Danger zone");
  await page.getByRole("button", { name: "Delete…" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete your account" });
  await dialog.getByLabel("Type producer@example.test to confirm").fill("producer@example.test");
  await expect(dialog.getByRole("button", { name: "Delete my account" })).toBeDisabled();
  await saveScreen(page, "account-delete");
  await checkScreen(page);
  await dialog.getByRole("button", { name: "Cancel" }).click();
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

// Themes (#117): sign-in and the player in light (the system's choice) and in one palette.
test.describe("themes", () => {
  test.describe("signed out", () => {
    test.use({ storageState: { cookies: [], origins: [] } });
    for (const [theme, set] of [
      ["light", async (page: Page) => page.emulateMedia({ colorScheme: "light" })],
      [
        "dracula",
        async (page: Page) =>
          page.addInitScript(() => localStorage.setItem("hekate.theme", "dracula")),
      ],
    ] as const) {
      test(`sign-in-${theme}`, async ({ page }) => {
        await set(page);
        await page.goto("/sign-in");
        await settle(page, "form");
        await saveScreen(page, `sign-in-${theme}`);
        await checkScreen(page);
      });
    }

    // Before anyone signs in, the page still follows the device, browser chrome included.
    test("sign-in follows the device", async ({ page }) => {
      await page.emulateMedia({ colorScheme: "dark" });
      await page.goto("/sign-in");
      await settle(page, "form");
      const html = page.locator("html");
      const chrome = page.locator('meta[name="theme-color"]');
      await expect(html).not.toHaveAttribute("data-theme", /./);
      await expect(chrome).toHaveAttribute("content", "#0a0a0b");
      await page.emulateMedia({ colorScheme: "light" });
      await expect(html).toHaveAttribute("data-theme", "signal-light");
      await expect(chrome).toHaveAttribute("content", "#f4f4f2");
    });
  });

  test("file-recording-light", async ({ page }) => {
    await page.clock.setFixedTime(FIXED_TIME);
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(`/files/${seeded().dryFileId}`);
    await settle(page, "section[aria-label=Comments] li");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "signal-light");
    await saveScreen(page, "file-recording-light");
    await checkScreen(page);
  });

  // A member's own choice, kept on the server; put back after, for the captures that follow.
  test("file-recording-dracula", async ({ page }) => {
    const choose = (theme: string) =>
      page.request.fetch("/api/me/preferences", { method: "PATCH", data: { theme } });
    expect((await choose("dracula")).ok()).toBe(true);
    try {
      await page.clock.setFixedTime(FIXED_TIME);
      await page.goto(`/files/${seeded().dryFileId}`);
      await settle(page, "section[aria-label=Comments] li");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dracula");
      await saveScreen(page, "file-recording-dracula");
      await checkScreen(page);
    } finally {
      await choose("system");
    }
  });
});

// Density (#218): compact tightens every list on one scale. A member's choice, put back after.
test.describe("compact", () => {
  for (const [name, path, ready] of [
    [
      "project-files-compact",
      () => `/projects/${seeded().musicProjectId}/files`,
      "main a:has-text('Maple Leaf Rag')",
    ],
    ["inbox-compact", () => "/inbox", "main a:has-text('Album masters')"],
    ["account-appearance-compact", () => "/account/appearance", "main >> text=Density"],
  ] as const) {
    test(name, async ({ page }) => {
      const choose = (density: string) =>
        page.request.fetch("/api/me/preferences", { method: "PATCH", data: { density } });
      expect((await choose("compact")).ok()).toBe(true);
      try {
        await page.clock.setFixedTime(FIXED_TIME);
        await page.goto(path());
        await settle(page, ready);
        await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
        await saveScreen(page, name);
        await checkScreen(page);
      } finally {
        await choose("comfortable");
      }
    });
  }
});

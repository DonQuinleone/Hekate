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

/**
 * Every page loads under the server's Content Security Policy, enforced as in production: a
 * violation (an inline script, a style from elsewhere, a worker the policy forbids) fails the
 * screen that caused it.
 */
const violations = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const seen: string[] = [];
  violations.set(page, seen);
  page.on("console", (message) => {
    if (/Content Security Policy/i.test(message.text())) seen.push(message.text());
  });
});
test.afterEach(({ page }) => {
  expect(violations.get(page) ?? [], "Content Security Policy violations").toEqual([]);
});

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
  {
    name: "sign-in-sso",
    path: () => "/sign-in?view=sso&reason=sso",
    ready: "text=Continue to the identity provider",
    as: "signed-out",
  },
  {
    name: "sign-in-sso-refused",
    path: () => "/sign-in?view=sso&error=account_not_linked",
    ready: "text=An account with this address already exists",
    as: "signed-out",
  },
  {
    name: "sign-in-directory",
    path: () => "/sign-in?view=directory",
    ready: "text=Sign in with a directory",
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
  // A guest whose review gives them compare (#44, #55) flips between what it gives them.
  {
    name: "guest-file-compare",
    path: (s) => `/g/files/${s.dryFileId}`,
    ready: "main >> text=V2 · Wet",
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
    name: "project-people-empty",
    path: (s) => `/projects/${s.videoProjectId}/people`,
    ready: "main >> text=No guests yet",
  },
  {
    name: "project-settings",
    path: (s) => `/projects/${s.musicProjectId}/settings`,
    ready: "main input[aria-label=Name]",
  },
  {
    name: "project-settings-comments",
    path: (s) => `/projects/${s.musicProjectId}/settings?section=comments`,
    ready: "main >> text=Information only: no action expected",
  },
  {
    name: "project-settings-roles",
    path: (s) => `/projects/${s.musicProjectId}/settings?section=roles`,
    ready: "main select[aria-label='Files for Producer']",
  },
  {
    name: "project-settings-storage",
    path: (s) => `/projects/${s.musicProjectId}/settings?section=storage`,
    ready: "main >> text=Used by this project",
  },
  {
    name: "project-settings-security",
    path: (s) => `/projects/${s.musicProjectId}/settings?section=security`,
    ready: "main >> text=Visible watermark",
  },
  {
    name: "project-settings-workflow",
    path: (s) => `/projects/${s.musicProjectId}/settings?section=workflow`,
    ready: "main >> text=Checks on a new version",
  },
  {
    name: "project-settings-qa",
    path: (s) => `/projects/${s.musicProjectId}/settings?section=qa`,
    ready: "main >> text=Flattened peaks",
  },
  {
    name: "project-settings-delivery",
    path: (s) => `/projects/${s.musicProjectId}/settings?section=delivery`,
    ready: "main select[aria-label='Project default']",
  },
  {
    name: "project-video",
    path: (s) => `/projects/${s.videoProjectId}/files`,
    ready: "main a:has-text('Opening titles - Cut 3.mp4')",
  },
  {
    name: "track",
    path: (s) => `/tracks/${s.trackId}?view=versions`,
    ready: "text=Bars 12 to 16",
  },
  // Two versions side by side (#137): aligned by their audio, the checks fixed and new.
  {
    name: "track-compare",
    path: (s) => `/tracks/${s.trackId}/compare`,
    ready: "main >> text=Alignment path",
  },
  {
    name: "track-takes",
    path: (s) => `/tracks/${s.trackId}?view=takes`,
    ready: "text=no take of bars 17 to 24",
  },
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
  // The review page in each of its states (#129).
  {
    name: "review-decided",
    path: (s) => `/reviews/${s.reviewStates.decided}`,
    ready: "text=You approved",
  },
  {
    name: "review-changes",
    path: (s) => `/reviews/${s.reviewStates.changes}`,
    ready: "text=Gate not passed",
  },
  {
    name: "review-approved",
    path: (s) => `/reviews/${s.reviewStates.approved}`,
    ready: "text=Gate passed",
  },
  {
    name: "review-cancelled",
    path: (s) => `/reviews/${s.reviewStates.cancelled}`,
    ready: "text=Superseded by the album masters",
  },
  {
    name: "review-waiting",
    path: (s) => `/reviews/${s.reviewStates.waiting}`,
    ready: "text=Your turn comes after",
  },
  {
    name: "review-overdue",
    path: (s) => `/reviews/${s.reviewStates.overdue}`,
    ready: "text=overdue",
  },
  // A share (#138): those it is shared with, opened or not, and nothing asked of them.
  {
    name: "review-share",
    path: (s) => `/reviews/${s.shareId}`,
    ready: "section:has-text('Shared with') li",
  },
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
  // The instance side (#155): setup's owner is its first operator.
  {
    name: "instance",
    path: () => "/instance",
    ready: "main >> text=Needs an operator",
  },
  {
    name: "instance-workspaces",
    path: () => "/instance/workspaces",
    ready: "main >> text=Endless Hall Records >> nth=0",
  },
  {
    name: "instance-operators",
    path: () => "/instance/operators",
    ready: "main >> text=producer@example.test",
  },
  {
    name: "instance-debug",
    path: () => "/instance/debug",
    ready: "main >> text=HK-7F3A-2C",
  },
  { name: "members", path: () => "/settings/members", ready: "main >> text=Alex Rivera" },
  {
    name: "settings-general",
    path: () => "/settings/general",
    ready: "main >> text=Guest links last",
  },
  {
    name: "settings-delivery",
    path: () => "/settings/delivery",
    ready: "main >> text=Built in >> nth=0",
  },
  {
    name: "settings-defaults",
    path: () => "/settings/defaults",
    ready: "main >> text=Access window",
  },
  {
    name: "settings-security",
    path: () => "/settings/security",
    ready: "main >> text=Directory (LDAP)",
  },
  {
    name: "settings-email",
    path: () => "/settings/email",
    ready: "main iframe[title*='light mail client']",
  },
  {
    name: "settings-storage",
    path: () => "/settings/storage",
    ready: "main >> text=Usage by project",
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

  // A guest their review lets invite others (#55): the Reviewers section's Invite, open. The
  // review's answer is amended in this page alone, so no other capture sees the grant.
  test("guest-review-invite", async ({ page }) => {
    await page.route(`**/api/reviews/${seeded().reviewId}`, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { review: { you: Record<string, unknown> } };
      body.review.you.canInvite = true;
      await route.fulfill({ response, json: body });
    });
    await page.goto(`/g/reviews/${seeded().reviewId}`);
    await settle(page, "h1:has-text('Album masters')");
    await page.getByRole("button", { name: "Invite" }).click();
    await settle(page, "text=Invite to this review");
    await saveScreen(page, "guest-review-invite");
    await checkScreen(page);
  });
});

for (const screen of screens.filter((s) => !s.as || s.as === "owner")) capture(screen);

// A file opened from a review (#15): the reviewer's decision beside the comments, where they
// listen. Nothing is decided, so no other capture sees a change.
test("file-decision", async ({ page }) => {
  await page.clock.setFixedTime(FIXED_TIME);
  await page.goto(`/files/${seeded().dryFileId}?review=${seeded().reviewId}`);
  await settle(page, "section[aria-label='Your decision'] button:has-text('Approve')");
  await saveScreen(page, "file-decision");
  await checkScreen(page);
});

// Where the comments sit (#15), a wide screen's choice kept by the browser: below the player
// and the score, or put away with a button in the header to bring them back. A phone keeps
// them after the player whatever was chosen, so comments put away are still there on a
// phone. The menu that chooses is captured open, beside the player.
for (const place of ["below", "hidden"] as const) {
  test(`file-comments-${place}`, async ({ page }, info) => {
    const phone = info.project.name === "phone";
    test.skip(phone && place === "below", "A phone always shows the comments after the player");
    await page.addInitScript(
      (layout) => localStorage.setItem("hekate.file.layout", JSON.stringify(layout)),
      { comments: place, width: 340 },
    );
    await page.clock.setFixedTime(FIXED_TIME);
    await page.goto(`/files/${seeded().dryFileId}`);
    await settle(
      page,
      place === "below" || phone
        ? "section[aria-label=Comments] li"
        : "button[aria-label='Show comments']",
    );
    if (phone) {
      await expect(page.locator("section[aria-label=Comments]")).toBeVisible();
      await expect(page.getByRole("button", { name: "Show comments" })).toBeHidden();
    }
    // Below the score, the comments are only seen with the whole page.
    if (place === "below") await showWhole(page);
    await saveScreen(page, `file-comments-${place}`);
    await checkScreen(page);
  });
}

test("file-panel-position", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "A phone always shows the comments after the player");
  await page.clock.setFixedTime(FIXED_TIME);
  await page.goto(`/files/${seeded().dryFileId}`);
  await settle(page, "section[aria-label=Comments] li");
  await page.getByRole("button", { name: "Panel position" }).click();
  await settle(page, "[role=menuitemradio][aria-checked=true]");
  await saveScreen(page, "file-panel-position");
  await checkScreen(page);
});

// Commenting on a finding (#43): from the QA view back to the review, the composer at the
// finding's moment and saying what it is; the findings are marked under the timeline.
test("file-finding-comment", async ({ page }) => {
  await page.clock.setFixedTime(FIXED_TIME);
  await page.goto(`/files/${seeded().dryFileId}?view=qa`);
  await settle(page, "ul[aria-label=Findings] li");
  await page
    .getByRole("button", { name: /^Comment on \d/ })
    .first()
    .click();
  // On a phone the composer opens as a sheet; elsewhere it sits beside the player.
  const composer = page.locator("textarea[placeholder='Comment at the playhead']:visible");
  await expect(composer).toHaveCount(1);
  await expect(composer).not.toHaveValue("");
  await settle(page, "textarea[placeholder='Comment at the playhead']:visible");
  await saveScreen(page, "file-finding-comment");
  await checkScreen(page);
});

// The QA report to take away (#43): its formats, and what it is stamped with.
test("file-qa-report", async ({ page }) => {
  await page.goto(`/files/${seeded().dryFileId}?view=qa`);
  await settle(page, "ul[aria-label=Findings] li");
  await page.getByRole("button", { name: "QA report" }).click();
  await settle(page, "[role=dialog] button:has-text('Download PDF')");
  await saveScreen(page, "file-qa-report");
  await checkScreen(page);
});

// Sharing (#138): the Share dialog, from the project's Reviews, a track and someone chosen.
test("share-dialog", async ({ page }) => {
  await page.clock.setFixedTime(FIXED_TIME);
  await page.goto(`/projects/${seeded().musicProjectId}/reviews`);
  await settle(page, "main >> text=Rehearsal takes");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await settle(page, "[role=dialog] >> text=Maple Leaf Rag");
  await page.getByRole("dialog").getByRole("checkbox").first().check();
  await saveScreen(page, "share-dialog");
  await checkScreen(page);
});

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

// A workspace on the instance side (#174): its tabs, a suspended one, and making one.
for (const [name, role, open, ready] of [
  ["instance-workspace-members", "tab", "Members", "main >> text=second factor: none >> nth=0"],
  ["instance-workspace-storage", "tab", "Storage", "main >> text=New objects go to"],
  ["instance-workspace-settings", "tab", "Settings", "main >> text=Danger zone"],
  ["instance-workspace-keys", "tab", "Keys", "main >> text=Workspace key"],
  [
    "instance-workspace-suspended",
    "button",
    "Lantern Pictures",
    "main >> text=The invoice for October is unpaid.",
  ],
  ["instance-workspace-new", "button", "Workspace", "[role=dialog] >> text=First owner’s email"],
] as const) {
  test(name, async ({ page }) => {
    await page.clock.setFixedTime(FIXED_TIME);
    await page.goto("/instance/workspaces");
    await settle(page, "main >> text=Recently in this workspace");
    await page
      .getByRole(role, { name: new RegExp(`^${open}`) })
      .first()
      .click();
    await settle(page, ready);
    await saveScreen(page, name);
    await checkScreen(page);
  });
}

// Debug tools (#159): the story behind a reference, opened from what failed today.
test("instance-debug-report", async ({ page }) => {
  await page.clock.setFixedTime(FIXED_TIME);
  await page.goto("/instance/debug");
  await settle(page, "main >> text=HK-7F3A-2C");
  await page.getByRole("button", { name: "Open HK-7F3A-2C" }).click();
  await settle(page, "main >> text=Copy the report");
  await saveScreen(page, "instance-debug-report");
  await checkScreen(page);
});

// Debug tools' flags (#159), each taking effect with no restart.
test("instance-debug-flags", async ({ page }) => {
  await page.clock.setFixedTime(FIXED_TIME);
  await page.goto("/instance/debug");
  await settle(page, "main >> text=Verbose logging for the worker");
  await page.getByText("Verbose logging for the worker").scrollIntoViewIfNeeded();
  await saveScreen(page, "instance-debug-flags");
  await checkScreen(page);
});

// Debug tools' inspectors (#159): a file, a review and this very session.
for (const [name, label, ready] of [
  ["instance-inspect-file", "File id or link", "main >> text=Stored"],
  ["instance-inspect-review", "Review id or link", "main >> text=Reviewers"],
  ["instance-inspect-session", "Session id", "main >> text=Signed in with"],
] as const) {
  test(name, async ({ page }) => {
    await page.clock.setFixedTime(FIXED_TIME);
    const s = seeded();
    const sessions = (await (await page.request.get("/api/me/sessions")).json()) as {
      sessions: { id: string; current: boolean }[];
    };
    const id =
      label === "File id or link"
        ? `/projects/${s.musicProjectId}/files/${s.scoreFileId}`
        : label === "Review id or link"
          ? `/inbox?item=${s.reviewId}`
          : (sessions.sessions.find((x) => x.current)?.id ?? "");
    await page.goto("/instance/debug");
    await settle(page, "main >> text=HK-7F3A-2C");
    await page.getByLabel(label, { exact: true }).fill(id);
    await page.getByLabel(label, { exact: true }).press("Enter");
    await settle(page, ready);
    await page
      .getByText(ready.replace("main >> text=", ""), { exact: true })
      .scrollIntoViewIfNeeded();
    await saveScreen(page, name);
    await checkScreen(page);
  });
}

// The command palette, as it opens and with results from the server.
for (const [name, typed, ready] of [
  ["palette", "", "[role=option]:has-text('Inbox')"],
  ["palette-search", "maple", "[role=option]:has-text('Maple Leaf Rag')"],
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

// Mentioning someone (#133): "@" in a comment offers the project's people.
test("file-comment-mention", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "On a phone the composer is a sheet, captured apart");
  await page.clock.setFixedTime(FIXED_TIME);
  await page.goto(`/files/${seeded().dryFileId}`);
  await settle(page, "section[aria-label=Comments] li");
  const composer = page.getByRole("textbox", { name: "Comment at the playhead" });
  await composer.fill("Can you check this, @Al");
  await settle(page, "[role=listbox][aria-label='People to mention'] [role=option]");
  await saveScreen(page, "file-comment-mention");
  await checkScreen(page);
});

// Deleting a project (#240): asked for by one person, confirmed by a second owner typing its name.
// The project's answer is amended in this page alone, so nothing is ever deleted.
test("project-settings-deletion", async ({ page }) => {
  await page.route(`**/api/projects/${seeded().musicProjectId}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = (await response.json()) as { project: Record<string, unknown> };
    body.project.deletion = {
      requestedBy: "Mira Solberg",
      requestedAt: "2026-10-15T09:30:00Z",
      mayConfirm: true,
      mayCancel: true,
      confirmableAt: null,
      deleteAfter: null,
    };
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/projects/${seeded().musicProjectId}/settings`);
  await settle(page, "main >> text=Deletion asked for");
  await saveScreen(page, "project-settings-deletion");
  await checkScreen(page);
  await page.getByRole("button", { name: "Delete…" }).click();
  await page.getByRole("textbox", { name: "Project name" }).fill("Joplin Rags");
  await settle(page, "[role=dialog] button:has-text('Delete'):not([disabled])");
  await saveScreen(page, "project-settings-deletion-confirm");
  await checkScreen(page);
});

// How fast it plays (#15): the speed menu, opening upward inside the player.
test("file-speed", async ({ page }) => {
  await page.goto(`/files/${seeded().dryFileId}`);
  await settle(page, "section[aria-label=Comments] li");
  await page.getByRole("button", { name: /^Speed/ }).click();
  await page.getByRole("menuitemradio", { name: "0.75×" }).click();
  await expect(page.getByRole("button", { name: /^Speed 0\.75×/ })).toBeVisible();
  await page.getByRole("button", { name: /^Speed/ }).click();
  await saveScreen(page, "file-speed");
  await checkScreen(page);
});

// Zoomed into a recording (#34): two steps in, the view scrolled with the playhead.
test("file-zoom", async ({ page }) => {
  await page.goto(`/files/${seeded().dryFileId}`);
  await settle(page, "section[aria-label=Comments] li");
  await page.getByRole("button", { name: "Zoom into the waveform" }).click();
  await page.getByRole("button", { name: "Zoom into the waveform" }).click();
  await expect(page.getByRole("button", { name: "4×" })).toBeVisible();
  // Focused, the arrow keys move along it rather than seek.
  const surface = page.getByRole("group", { name: /^Waveform, zoomed 4 times/ });
  await surface.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => surface.evaluate((e) => e.scrollLeft)).toBeGreaterThan(0);
  await expect(page.getByText("0:00 / 0:40")).toBeVisible();
  await page.keyboard.press("Home");
  await expect.poll(() => surface.evaluate((e) => e.scrollLeft)).toBe(0);
  await saveScreen(page, "file-zoom");
  await checkScreen(page);
});

// A recording's channels heard apart (#74): its answers amended in the page alone to a 5.1
// file's, the centre soloed and the downmix on.
test("file-channels", async ({ page }) => {
  const id = seeded().dryFileId;
  await page.route(`**/api/files/${id}`, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      file: { mediaInfo: { audio: Record<string, unknown> } };
    };
    Object.assign(body.file.mediaInfo.audio, { channels: 6, channelLayout: "5.1(side)" });
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/files/${id}`);
  await settle(page, "section[aria-label=Comments] li");
  await page.getByRole("button", { name: "Channels", exact: true }).click();
  const menu = page.getByRole("region", { name: "Channels" });
  await expect(menu).toBeVisible();
  if (await menu.getByRole("button", { name: "Solo C" }).count()) {
    await menu.getByRole("button", { name: "Solo C" }).click();
    await menu.getByRole("switch", { name: "Hear the stereo downmix" }).click();
    await expect(page.getByRole("button", { name: /^Channels: solo c/ })).toBeVisible();
  }
  await saveScreen(page, "file-channels");
  await checkScreen(page);
});

// The checks narrowed (#43): to what failed, then to one check.
test("file-qa-filtered", async ({ page }) => {
  await page.goto(`/files/${seeded().dryFileId}?view=qa`);
  await settle(page, "section[aria-label=Checks] h2");
  const checks = page.locator("section[aria-label=Checks]");
  await checks.getByRole("button", { name: /failed$/ }).click();
  await checks.getByRole("combobox", { name: "Check" }).selectOption("clipping");
  await expect(checks.getByRole("button", { name: /failed$/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await saveScreen(page, "file-qa-filtered");
  await checkScreen(page);
});

// An Atmos master's checks (#74): its ADM read as a bed and objects, the LFE judged against
// its crossover. The file's answers are amended in this page alone; the seed stays stereo.
test("file-qa-atmos", async ({ page }) => {
  const id = seeded().dryFileId;
  await page.route(`**/api/files/${id}`, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      file: { mediaInfo: { audio: Record<string, unknown>; metadata: Record<string, unknown> } };
    };
    Object.assign(body.file.mediaInfo.audio, { channels: 14, channelLayout: "14 channels" });
    body.file.mediaInfo.metadata.adm = {
      bytes: 48_000,
      programme: "Maple Leaf Rag",
      bed: 12,
      layout: "7.1.4",
      objects: 2,
      lfe: [3],
      dolby: true,
    };
    await route.fulfill({ response, json: body });
  });
  await page.route(`**/api/files/${id}/qa`, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      profile: Record<string, unknown>;
      inherited: Record<string, unknown>;
      findings: Record<string, unknown>[];
    };
    const whole = { channel: null, start: null, end: null, details: {} };
    // Suggested by the ADM, as nothing else chose.
    const atmos = { id: "atmos", label: "Dolby Atmos (ADM BWF)", source: "suggested" };
    body.profile = { ...body.profile, ...atmos, chosen: false };
    body.inherited = atmos;
    body.findings = [
      {
        check: "lfe",
        severity: "fail",
        summary:
          "Content above the 120 Hz crossover on the LFE (channel 4), at 281 Hz only 12 dB below its bass: low-pass it at 120 Hz",
        ...whole,
        channel: 3,
      },
      {
        check: "atmos",
        severity: "pass",
        summary: "ADM BWF: 7.1.4 bed + 2 objects, with Dolby metadata",
        ...whole,
      },
      ...body.findings.filter((f) => f.check !== "format" && f.check !== "loudness"),
    ];
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/files/${id}?view=qa`);
  await settle(page, "section[aria-label='Embedded metadata'] >> text=ADM · Dolby Atmos");
  await saveScreen(page, "file-qa-atmos");
  await checkScreen(page);
  await page.locator("section[aria-label='Embedded metadata']").scrollIntoViewIfNeeded();
  await saveScreen(page, "file-qa-atmos-metadata");
  await checkScreen(page);
});

// Normalised playback as each person's choice (#240): the View menu's switch, and the level heard.
// The file's answer is amended in this page alone, so no other capture sees the project change.
test("file-normalised", async ({ page }) => {
  await page.route(`**/api/files/${seeded().dryFileId}`, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { file: Record<string, unknown> };
    body.file.normalisation = { mode: "optional", target: -14, gain: 0.5 };
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/files/${seeded().dryFileId}`);
  await settle(page, "button:has-text('View')");
  await page.getByRole("button", { name: "View" }).click();
  await page.getByRole("switch", { name: "Normalised playback" }).click();
  await settle(page, "text=Normalised to −14 LUFS");
  await saveScreen(page, "file-normalised");
  await checkScreen(page);
});

// The player's View menu (#135): the spectrogram below, behind and instead of the waveform, each
// with its own waveform look, kept by the browser as a listener left it.
for (const [place, wave] of [
  ["below", { colour: "ink", opacity: 0.5, height: 0.32 }],
  ["behind", { colour: "cool", opacity: 0.8, height: 0.5 }],
  ["instead", { colour: "warm", opacity: 0.5, height: 0.32 }],
] as const) {
  test(`player-view-${place}`, async ({ page }, info) => {
    await page.addInitScript(
      (view) => localStorage.setItem("hekate.player.view", JSON.stringify(view)),
      { split: false, spectrogram: place, wave },
    );
    await page.goto(`/files/${seeded().dryFileId}`);
    await settle(page, "[role=img][aria-label^=Spectrogram]:not(.animate-pulse) canvas");
    await page.getByRole("button", { name: "View" }).click();
    await settle(page, "section#player-view");
    // On a phone the menu runs on below the fold: shown, rather than left against the tab bar.
    if (info.project.name === "phone") {
      await page
        .locator("section#player-view")
        .evaluate((el) => el.scrollIntoView({ block: "center" }));
    }
    await saveScreen(page, `player-view-${place}`);
    await checkScreen(page);
    if (place !== "below") return;
    // Naming the view to keep it as a preset; not saved, so no other capture sees it.
    await page.getByRole("button", { name: "Save as…" }).click();
    await page.getByRole("textbox", { name: "Preset name" }).fill("Noise hunt");
    await saveScreen(page, "player-view-preset");
    await checkScreen(page);
  });
}

// "Any other options for these bars?" (#46): the takes covering a bar thread's first bar.
test("file-comment-other-takes", async ({ page }) => {
  await page.clock.setFixedTime(FIXED_TIME);
  await page.goto(`/files/${seeded().dryFileId}`);
  await settle(page, "section[aria-label=Comments] li");
  const thread = page
    .getByRole("listitem")
    .filter({ hasText: "The left hand rushes through these bars." });
  await thread.getByRole("button", { name: "Other takes" }).click();
  const panel = page.getByRole("region", { name: "Other takes for bar 9" });
  await expect(panel.getByRole("listitem")).toHaveCount(2);
  await expect(panel).toContainText("Good opening");
  // Those who triage choose which to share (#133); the one already shared says so.
  await expect(panel.getByText("shared")).toHaveCount(1);
  await panel.getByRole("checkbox", { name: "Tick take 2" }).check();
  await expect(panel.getByRole("button", { name: "Share 1" })).toBeEnabled();
  await panel.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await saveScreen(page, "file-comment-other-takes");
  await checkScreen(page);
});

// Takes shared on a thread (#133): one line in it, opening the list to hear them.
test("file-comment-shared-takes", async ({ page }) => {
  await page.clock.setFixedTime(FIXED_TIME);
  await page.goto(`/files/${seeded().dryFileId}`);
  await settle(page, "section[aria-label=Comments] li");
  await page.getByRole("button", { name: "1 take attached" }).click();
  const dialog = page.getByRole("dialog", { name: "Takes for bar 9" });
  await expect(dialog.getByRole("listitem")).toHaveCount(1);
  await expect(dialog).toContainText("Warm-up run");
  await saveScreen(page, "file-comment-shared-takes");
  await checkScreen(page);
});

// Attaching files to a comment (#133): chosen, shown before sending, and on the thread.
test("file-comment-attach", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "On a phone the composer is a sheet, captured apart");
  await page.clock.setFixedTime(FIXED_TIME);
  await page.goto(`/files/${seeded().dryFileId}`);
  await settle(page, "section[aria-label=Comments] li");
  await page.getByRole("textbox", { name: "Comment at the playhead" }).fill("Fingering as marked");
  await page.locator("input[type=file][aria-label='Files to attach']").setInputFiles({
    name: "Fingering, bars 9 to 12.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 fingering"),
  });
  await settle(page, "ul[aria-label='Files to attach'] li");
  await saveScreen(page, "file-comment-attach");
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

// A track opens in the player; its next version is checked before it lands (#131).
test("track-new-version", async ({ page }) => {
  const { trackId } = seeded();
  await page.goto(`/tracks/${trackId}`);
  await expect(page).toHaveURL(/\/files\//);
  await page.goto(`/tracks/${trackId}?view=versions`);
  await page.getByRole("button", { name: "Add version" }).click();
  const form = page.getByRole("form", { name: "Version 3" });
  await form.getByRole("button", { name: "From the project" }).first().click();
  await page.getByRole("menuitem", { name: "Maple Leaf Rag - Dry v3.wav" }).click();
  await expect(form.getByLabel("Variation name for Maple Leaf Rag - Dry v3.wav")).toHaveValue(
    "Dry v3",
  );
  await form.getByRole("button", { name: "Add version 3" }).click();
  // The project asks for an EDL: a real refusal from the server, which a producer may override.
  const refusal = form.getByRole("alert");
  await expect(refusal).toContainText("asks for an edit decision list");
  await expect(form.getByRole("button", { name: "Let it through" })).toBeVisible();
  await settle(page, "form li");
  await refusal.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await saveScreen(page, "track-new-version");
  await checkScreen(page);
});

// A track's takes (#21, #46): those covering a bar, then one take's details being edited.
test("track-takes-edit", async ({ page }) => {
  await page.goto(`/tracks/${seeded().trackId}?view=takes`);
  await page.getByLabel("Only the takes covering a bar").fill("30");
  const list = page.getByRole("list", { name: "Takes of this track" });
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list).toContainText("Keeper into the trio");
  await saveScreen(page, "track-takes-bar");
  await checkScreen(page);
  await list.getByRole("listitem").filter({ hasText: "Keeper" }).hover();
  await page.getByRole("button", { name: "Actions for take 3" }).click();
  await page.getByRole("menuitem", { name: "Edit…" }).click();
  const dialog = page.getByRole("dialog", { name: "Take 3" });
  await dialog.getByLabel("Last bar").fill("12");
  await expect(dialog.getByRole("alert")).toHaveText("The last bar comes before the first");
  await dialog.getByLabel("Last bar").fill("48");
  await dialog.getByLabel("In point").fill("0:01.5");
  await saveScreen(page, "track-takes-edit");
  await checkScreen(page);
});

// V2's edit decision list read against the takes (#56): where each edit comes from.
test("track-takes-edits", async ({ page }) => {
  await page.goto(`/tracks/${seeded().trackId}?view=takes`);
  await expect(page.getByRole("list", { name: "Takes of this track" })).toContainText("in V2");
  await page.getByRole("button", { name: "Edit decisions" }).click();
  const edits = page.getByRole("list", { name: "Edit decisions" });
  await expect(edits.getByRole("listitem")).toHaveCount(4);
  await expect(edits).toContainText("Not a take of this track");
  await saveScreen(page, "track-takes-edits");
  await checkScreen(page);
});

// Project templates (#240): saving one from the project's settings, and starting from one.
test("project-template-save", async ({ page }) => {
  await page.goto(`/projects/${seeded().musicProjectId}/settings`);
  await settle(page, "main input[aria-label=Name]");
  await page.getByRole("button", { name: "Save template…" }).click();
  const dialog = page.getByRole("dialog", { name: "Save as a template" });
  await dialog.getByLabel("Name").fill("Chamber recital");
  await saveScreen(page, "project-template-save");
  await checkScreen(page);
});

test("project-new-from-template", async ({ page }) => {
  await page.goto("/projects");
  await settle(page, "main a:has-text('Joplin Rags')");
  await page.getByRole("button", { name: "New project" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Start from").selectOption({ label: "Solo recital" });
  await saveScreen(page, "project-new-from-template");
  await checkScreen(page);
});

// Asking for a review (#130): the form inside the project, empty and then filled in turn.
test("request-review", async ({ page }) => {
  const { musicProjectId, trackId } = seeded();
  await page.goto(`/projects/${musicProjectId}/reviews/new?kind=approval&item=track:${trackId}`);
  const form = page.getByRole("form", { name: "Request a review" });
  await expect(form.getByRole("list", { name: "Chosen" })).toBeVisible();
  await settle(page, "form li");
  await saveScreen(page, "request-review");
  await checkScreen(page);
});

test("request-review-filled", async ({ page }) => {
  const { musicProjectId, trackId } = seeded();
  await page.goto(`/projects/${musicProjectId}/reviews/new?kind=approval&item=track:${trackId}`);
  const form = page.getByRole("form", { name: "Request a review" });
  await form.getByRole("button", { name: /Soloists/ }).click();
  await form.getByRole("checkbox", { name: "Alex Rivera" }).check();
  // In turn: Alex first, the soloists after.
  await form.getByRole("button", { name: "In turn" }).click();
  await form.getByRole("button", { name: "Add a step" }).click();
  await form.getByRole("button", { name: "Step 1" }).first().click();
  await page.getByRole("menuitemradio", { name: "Step 2" }).click();
  await form.getByRole("button", { name: "a share" }).click();
  await form.getByRole("button", { name: "A week" }).click();
  // A guest needs an email: the form says so rather than sending a link nowhere.
  await form.getByRole("button", { name: "Someone new" }).click();
  await form.getByLabel("Name", { exact: true }).fill("Tomas Varga");
  await form.getByRole("button", { name: "Add", exact: true }).click();
  const error = form.getByText("An email is needed: their link goes there.");
  await expect(error).toBeVisible();
  await error.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await expect(form.getByRole("button", { name: "Send the review" })).toBeEnabled();
  await saveScreen(page, "request-review-filled");
  await checkScreen(page);
});

// Comment export (#99): the file's threads as a marker list, previewed, then downloaded.
test("file-export-comments", async ({ page }) => {
  await page.goto(`/files/${seeded().dryFileId}`);
  await settle(page, "section[aria-label=Comments] li");
  await page.getByRole("button", { name: "Actions for file" }).click();
  await page.getByRole("menuitem", { name: "Export comments…" }).click();
  const dialog = page.getByRole("dialog", { name: "Export comments" });
  // Each application by its own mark, in a list a native select could not draw.
  await dialog.getByRole("button", { name: "For" }).click();
  await expect(dialog.getByRole("menuitemradio", { name: "Avid Media Composer" })).toBeVisible();
  await saveScreen(page, "file-export-comments-for");
  await checkScreen(page);
  await dialog.getByRole("menuitemradio", { name: "DaVinci Resolve" }).click();
  await dialog.getByLabel("Time base").selectOption("timecode-hour");
  await expect(dialog.getByText("FCM: NON-DROP FRAME")).toBeVisible();
  await saveScreen(page, "file-export-comments");
  await checkScreen(page);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByRole("link", { name: "Export" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/ comments\.edl$/);
  const body = await new Promise<string>((resolve, reject) => {
    void download.createReadStream().then((stream) => {
      let text = "";
      stream.on("data", (chunk) => {
        text += chunk;
      });
      stream.on("end", () => resolve(text));
      stream.on("error", reject);
    });
  });
  expect(body).toContain("FCM: NON-DROP FRAME");
  expect(body).toMatch(/\|C:ResolveColor\w+ \|M:/);
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
    ["home-compact", () => "/", "main section[aria-label=Activity] li a"],
    ["review-compact", () => `/reviews/${seeded().reviewId}`, "h1:has-text('Album masters')"],
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

// Passkeys (#39), with Chrome's virtual authenticator: one added on the account page, then
// used to sign in without a password; revoked after, so the account is as seeded.
test("account-passkeys", async ({ browser }, info) => {
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: info.project.use.viewport ?? { width: 1440, height: 900 },
    baseURL: info.project.use.baseURL,
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });
  try {
    await page.goto("/sign-in");
    await page.fill("#email", "producer@example.test");
    await page.fill("#password", "correct horse battery");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));

    await page.goto("/account/security");
    await settle(page, "main >> text=Passkeys and hardware security keys");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add a passkey or hardware security key" });
    await dialog.getByLabel("Name").fill("Studio laptop");
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("main").getByText("Studio laptop")).toBeVisible();
    await saveScreen(page, "account-passkeys");
    await checkScreen(page);

    // Signed out, the key alone signs in.
    await context.clearCookies();
    await page.goto("/sign-in");
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));
    await expect(page.getByRole("navigation").first()).toBeVisible();
  } finally {
    await page.goto("/account/security");
    await settle(page, "main >> text=Passkeys and hardware security keys");
    const actions = page.getByRole("button", { name: "Actions for Studio laptop" });
    while ((await actions.count()) > 0) {
      const before = await actions.count();
      await actions.first().click();
      await page.getByRole("menuitem", { name: "Revoke" }).click();
      await expect(actions).toHaveCount(before - 1);
    }
    await context.close();
  }
});

// Triage (#132): the open threads one at a time, single keys for each decision, then the lists.
test("file-triage", async ({ page }) => {
  await page.goto(`/files/${seeded().dryFileId}?view=triage`);
  const queue = page.getByRole("complementary", { name: "Queue" });
  await expect(queue.getByText("Queue · 4")).toBeVisible();
  await settle(page, "aside li");
  await saveScreen(page, "file-triage");
  await checkScreen(page);
  // The first takes Edit; the second, Balance; the last two, ticked, are assigned at once.
  await page.keyboard.press("2");
  await expect(queue.getByRole("button", { name: /Intentional/ })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await page.keyboard.press("3");
  // Each decision moves the queue on once the server has it.
  await expect(queue.getByRole("listitem").nth(2).locator('[aria-current="true"]')).toHaveCount(1);
  await queue.getByRole("checkbox", { name: "Tick comment 3" }).check();
  await queue.getByRole("checkbox", { name: "Tick comment 4" }).check();
  await expect(queue.getByText("2 ticked")).toBeVisible();
  await page.keyboard.press("a");
  const dialog = page.getByRole("dialog", { name: "Assign" });
  await dialog.getByLabel("To").selectOption({ index: 1 });
  await dialog.getByRole("button", { name: "Assign" }).click();
  await expect(page.getByRole("heading", { name: "Triage done" })).toBeVisible();
  await expect(page.getByText("4 of 4 comments decided.")).toBeVisible();
  await saveScreen(page, "file-triage-done");
  await checkScreen(page);
  // Assigned to yourself, the list is already yours: there is no one to send it to.
  await expect(page.getByText("Yours", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /their list/ })).toHaveCount(0);
});

// Downloads (#136): what you may take, made for you; the proxy is the stream's own AAC, whole.
test("file-download", async ({ page }) => {
  await page.goto(`/files/${seeded().dryFileId}`);
  await page.getByRole("button", { name: "Download", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Download" });
  await expect(dialog.getByText(/AAC \d+ kb\/s/)).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /Original/ })).toBeChecked();
  await saveScreen(page, "file-download");
  await checkScreen(page);
  await dialog.getByText("Proxy").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByRole("button", { name: "Download" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("Maple Leaf Rag - Dry v2.m4a");
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    void download.createReadStream().then((stream) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });
  });
  // A real MP4: the decrypted initialisation section opens with its file type box.
  expect(bytes.toString("latin1", 4, 8)).toBe("ftyp");
  expect(bytes.length).toBeGreaterThan(50_000);
});

// A document's download (#136): its pages as reviewed, or drawn again for print, each marked
// with the name of whoever asked, as a PDF.
test("file-download-document", async ({ page }) => {
  await page.goto(`/files/${seeded().scoreFileId}`);
  await page.getByRole("button", { name: "Download", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Download" });
  await expect(dialog.getByText(/at print resolution/)).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /Original/ })).toBeChecked();
  await saveScreen(page, "file-download-document");
  await checkScreen(page);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByRole("button", { name: "Download" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("Maple Leaf Rag - Score.pdf");
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    void download.createReadStream().then((stream) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });
  });
  expect(bytes.toString("latin1", 0, 5)).toBe("%PDF-");
  expect(bytes.toString("latin1").trimEnd().endsWith("%%EOF")).toBe(true);
});

// A video's download (#136): the stream as reviewed, or the original at its own size, the
// mark burned into the picture as it is sent.
test("file-download-video", async ({ page }) => {
  await page.goto(`/files/${seeded().cutFileId}`);
  await page.getByRole("button", { name: "Download", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Download" });
  await expect(dialog.getByText(/stream as reviewed, as MP4/)).toBeVisible();
  await expect(dialog.getByText(/encoded again to carry the mark/)).toBeVisible();
  await saveScreen(page, "file-download-video");
  await checkScreen(page);
  await dialog.getByText("Proxy").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByRole("button", { name: "Download" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("Opening titles - Cut 3.mp4");
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    void download.createReadStream().then((stream) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });
  });
  expect(bytes.toString("latin1", 4, 8)).toBe("ftyp");
});

// Per-reviewer permissions (#55): a guest's items, earlier versions, tools, download and plays.
test("review-reviewer-permissions", async ({ page }) => {
  await page.goto(`/reviews/${seeded().reviewId}`);
  await page.getByRole("button", { name: "Actions for Mira Solberg" }).click();
  await page.getByRole("menuitem", { name: "Override permissions for this review…" }).click();
  const form = page.getByRole("form", { name: "What Mira Solberg may do" });
  await expect(form.getByRole("group", { name: "Items they see" })).toBeVisible();
  await expect(form.getByLabel("Plays of each file, at most")).toBeVisible();
  await form.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await saveScreen(page, "review-reviewer-permissions");
  await checkScreen(page);
});

#!/usr/bin/env node
/**
 * Captures the prototype's screens to docs/screens/<name>.png at 1440 by 900, the pictures the
 * inventory links to and reviewers compare apps/web with (AGENTS.md, Design contract).
 *
 *   pnpm --filter @hekate/prototype screens                 # every screen
 *   pnpm --filter @hekate/prototype screens review files    # only these
 *   pnpm --filter @hekate/prototype screens -- --list       # the names, with their addresses
 *   pnpm --filter @hekate/prototype screens -- --dev review # from the sources, without a build
 *
 * It builds the prototype into a temporary folder and serves it with vite preview on a free port,
 * opens each screen in a fresh browser context with the switcher's choices (who you are, the
 * width, the state) already remembered, follows the screen's steps, and stops the server it
 * started. A screen fails if a step finds nothing, the page throws or it answers "Not found";
 * the rest are still taken. Look at what it wrote before committing it.
 *
 * Playwright is not a dependency of the prototype: the script uses whichever `playwright` Node
 * resolves (NODE_PATH, or a global install), and Chromium as Playwright ships it.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = join(root, "docs", "screens");

/**
 * Every capture, in inventory order. `route` is the address after the hash; `persona` is the
 * switcher's role (owner unless said); `state` and `width` are the switcher's settings;
 * `storage` adds remembered choices (raw localStorage values); `steps` run in order before the
 * picture: { click }, { press }, { type }, { fill: [selector, text] }, { select: [selector,
 * value] }, { scroll: heading text }, { wait }.
 * Selectors are Playwright's, which reach into the prototype's shadow root.
 */
const screens = [
  // 3.1 Arriving
  { name: "sign-in", route: "/sign-in" },
  { name: "sign-in-code", route: "/sign-in?view=code" },
  { name: "sign-in-sso", route: "/sign-in?view=sso" },
  { name: "sign-up", route: "/sign-up" },
  { name: "sign-up-workspace", route: "/sign-up?view=make" },
  { name: "installer", route: "/install?step=1" },
  { name: "installer-storage", route: "/install?step=3" },
  {
    name: "installer-mail",
    route: "/install?step=5",
    steps: [{ select: ['label:has-text("Provider") select', "Microsoft 365"] }],
  },
  { name: "invitation", route: "/invite" },
  { name: "guest-link", route: "/guest/link" },
  { name: "guest-home", route: "/g", persona: "guest" },
  { name: "status", route: "/status" },
  { name: "status-incident", route: "/status", state: "failed" },
  { name: "upload-request", route: "/u/req-atmos" },

  // 3.2 Home and navigation
  { name: "home", route: "/" },
  { name: "help-menu", route: "/", steps: [{ click: 'role=button[name="Help"]' }] },
  {
    name: "palette",
    route: "/projects/proj-joplin",
    steps: [{ click: 'role=button[name="Search and commands"]' }, { type: "map" }],
  },
  { name: "inbox", route: "/inbox" },

  // 3.3 Projects
  { name: "project-overview", route: "/projects/proj-joplin" },
  { name: "files", route: "/projects/proj-joplin/files" },
  {
    name: "files-columns",
    route: "/projects/proj-joplin/files",
    storage: { "hekate.prototype.files": "columns" },
  },
  {
    name: "files-upload-request",
    route: "/projects/proj-joplin/files",
    steps: [
      { click: '[aria-label="Actions for new"]' },
      { click: "text=Upload request…" },
      { select: ['role=dialog >> label:has-text("Into") select', "t-maple"] },
    ],
  },
  { name: "board", route: "/projects/proj-joplin/board" },
  {
    name: "calendar",
    route: "/projects/proj-joplin/board",
    steps: [{ click: 'role=radio[name="Calendar"]' }],
  },
  { name: "tasks", route: "/projects/proj-joplin/tasks" },
  { name: "people", route: "/projects/proj-joplin/people" },
  {
    name: "roles",
    route: "/projects/proj-joplin/settings?section=roles",
    steps: [{ scroll: "Access permissions" }],
  },
  { name: "qa-rules", route: "/projects/proj-joplin/settings?section=qa" },
  {
    name: "workflow-basic",
    route: "/projects/proj-joplin/workflow",
    steps: [{ click: 'role=tab[name="Basic"]' }],
  },
  { name: "workflow", route: "/projects/proj-joplin/workflow" },
  {
    name: "workflow-run",
    route: "/projects/proj-joplin/workflow",
    steps: [{ click: 'role=button[name="Walk through"]' }],
  },
  {
    name: "workflow-code",
    route: "/projects/proj-joplin/workflow",
    steps: [{ click: 'role=tab[name="Code"]' }],
  },

  // 3.4 Music
  { name: "takes", route: "/tracks/t-maple?view=takes" },
  { name: "recording", route: "/files/file-maple-v2-dry" },
  {
    name: "recording-spectrogram",
    route: "/files/file-maple-v2-dry",
    steps: [
      { click: "role=button[name=/^View/]" },
      { click: 'role=radio[name="Below"]' },
      { click: "text=Window, FFT size and overlap…" },
    ],
  },
  { name: "recording-qa", route: "/files/file-maple-v2-dry?view=qa" },
  { name: "phone-recording", route: "/files/file-maple-v2-dry", width: "phone" },
  { name: "triage", route: "/files/file-maple-v2-dry?view=triage" },
  {
    name: "triage-done",
    route: "/files/file-maple-v2-dry?view=triage",
    steps: [{ press: "2" }, { press: "4" }, { press: "r" }, { click: 'role=button[name="Done"]' }],
  },
  {
    name: "listen-together",
    route: "/files/file-maple-v2-dry",
    steps: [{ click: '[title="Lead or join a listening room"]' }],
  },
  {
    name: "listen-following",
    route: "/files/file-maple-v2-dry",
    steps: [
      { click: '[title="Lead or join a listening room"]' },
      { click: 'role=dialog[name="Listen together"] >> role=button[name="Join"]' },
    ],
  },
  {
    name: "listen-leading",
    route: "/files/file-maple-v2-dry",
    steps: [
      { click: '[title="Lead or join a listening room"]' },
      { click: 'role=button[name="Start leading"]' },
    ],
  },
  { name: "listening-room", route: "/listen/room-maple" },

  // 3.5 Video
  { name: "video", route: "/files/file-titles-c3" },
  {
    name: "video-captions",
    route: "/files/file-titles-c3",
    steps: [
      { click: "role=button[name=/^Captions/]" },
      { click: "role=menuitemradio >> nth=1" },
      { click: 'role=tab[name="Transcript"]' },
    ],
  },
  { name: "video-qa", route: "/files/file-titles-c3?view=qa" },

  // 3.6 Documents and other files
  { name: "document", route: "/files/file-score-maple" },
  { name: "document-versions", route: "/files/file-liner" },
  { name: "other-file", route: "/files/file-stems" },

  // 3.8 Reviews
  { name: "request-review", route: "/reviews/new?project=proj-joplin" },
  { name: "review", route: "/reviews/rev-masters" },
  { name: "guest-review", route: "/g/reviews/rev-masters", persona: "guest" },

  // 3.10 Production
  { name: "schedule", route: "/projects/proj-joplin/production?section=schedule" },
  { name: "take-log", route: "/projects/proj-joplin/production?section=takelog" },
  {
    name: "take-log-recorder",
    route: "/projects/proj-joplin/production?section=takelog",
    steps: [{ click: "role=button[name=/Recorder/]" }],
  },
  { name: "score-marking", route: "/projects/proj-joplin/production?section=marking" },
  { name: "stage-plan", route: "/projects/proj-joplin/production?section=stage" },

  // 3.11 Workspace, settings and operations
  { name: "org-general", route: "/settings/general" },
  { name: "org-export", route: "/settings/general", steps: [{ scroll: "Export" }] },
  { name: "org-branding", route: "/settings/branding" },
  { name: "design-system", route: "/settings/brand" },
  {
    name: "design-system-components",
    route: "/settings/brand",
    steps: [{ scroll: "Surfaces" }],
  },
  { name: "email-template", route: "/settings/email" },
  { name: "org-members", route: "/settings/members" },
  { name: "org-security", route: "/settings/security" },
  { name: "org-notifications", route: "/settings/notifications" },
  {
    name: "org-mcp",
    route: "/settings/notifications",
    steps: [{ scroll: "API and MCP" }],
  },
  { name: "org-api", route: "/settings/api" },
  { name: "org-billing", route: "/settings/billing" },
  { name: "org-support", route: "/settings/support" },
  { name: "org-support-new", route: "/settings/support?new=1" },
  { name: "org-support-ticket", route: "/settings/support?ticket=t-216" },
  { name: "org-transfers", route: "/settings/transfers" },
  { name: "org-storage", route: "/settings/storage" },
  { name: "org-leaks", route: "/settings/leaks" },
  { name: "org-access-log", route: "/settings/log" },
  { name: "org-operations", route: "/settings/operations" },
  { name: "account-tokens", route: "/account/tokens" },
  { name: "account-apps", route: "/account/apps" },
  { name: "account-notifications", route: "/account/notifications" },
  { name: "oauth-consent", route: "/oauth/authorize" },
  { name: "oauth-consent-refused", route: "/oauth/authorize", state: "refused" },
  { name: "suspended", route: "/suspended" },
  { name: "deleting", route: "/deleting" },

  // The instance, as its operator
  { name: "instance", route: "/instance", persona: "instance" },
  { name: "instance-workspaces", route: "/instance/workspaces", persona: "instance" },
  {
    name: "instance-workspace-quota",
    route: "/instance/workspaces",
    persona: "instance",
    steps: [{ click: 'role=tab[name="Storage and quota"]' }],
  },
  { name: "instance-operators", route: "/instance/operators", persona: "instance" },
  { name: "instance-billing", route: "/instance/billing", persona: "instance" },
  {
    name: "instance-billing-plans",
    route: "/instance/billing",
    persona: "instance",
    steps: [{ click: 'role=tab[name="Plans"]' }],
  },
  {
    name: "instance-billing-reports",
    route: "/instance/billing",
    persona: "instance",
    steps: [{ click: 'role=tab[name="Reports"]' }],
  },
  { name: "instance-support", route: "/instance/support", persona: "instance" },
  {
    name: "instance-status-page",
    route: "/instance/support",
    persona: "instance",
    state: "failed",
    steps: [{ scroll: "Status page" }],
  },
  {
    name: "instance-incident-new",
    route: "/instance/support",
    persona: "instance",
    steps: [{ click: 'role=button[name="Post an incident"]' }],
  },
  { name: "instance-health", route: "/instance/health", persona: "instance" },
  { name: "instance-queues", route: "/instance/queues", persona: "instance" },
  { name: "instance-logs", route: "/instance/logs", persona: "instance" },
  {
    name: "instance-logs-gateway",
    route: "/instance/logs",
    persona: "instance",
    steps: [{ click: 'role=tab[name="Gateway"]' }],
  },
  { name: "instance-debug", route: "/instance/debug", persona: "instance" },
  { name: "instance-system", route: "/instance/system", persona: "instance" },
  { name: "instance-settings", route: "/instance/settings", persona: "instance" },
  {
    name: "instance-telemetry",
    route: "/instance/settings",
    persona: "instance",
    steps: [{ scroll: "Address and mail" }],
  },
  { name: "instance-operations", route: "/instance/operations", persona: "instance" },
];

const args = process.argv.slice(2).filter((a) => a !== "--");
const dev = args.includes("--dev");
const names = args.filter((a) => !a.startsWith("--"));
if (args.includes("--list")) {
  for (const s of screens) console.log(`${s.name.padEnd(28)} ${s.persona ?? "owner"}  #${s.route}`);
  process.exit(0);
}
const unknown = names.filter((a) => !screens.some((s) => s.name === a));
if (unknown.length) {
  console.error(`No such screen: ${unknown.join(", ")}. --list names them.`);
  process.exit(1);
}
const chosen = names.length ? screens.filter((s) => names.includes(s.name)) : screens;

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const viteBin = join(
  dirname(require.resolve("vite/package.json", { paths: [root] })),
  "bin",
  "vite.js",
);

/** A port nobody holds now, from the system. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Runs Vite itself, not a package manager in front of it, so the PID stopped is the one started. */
function vite(argv, stdio) {
  return spawn(process.execPath, [viteBin, ...argv], { cwd: root, stdio });
}

async function waitFor(url, child) {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`Vite stopped (exit ${child.exitCode})`);
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Vite did not answer at ${url}`);
}

// A production build in a folder of its own (dist/ and the artifact are left alone), served by
// vite preview: one bundle loads quickly in every fresh context. --dev serves the sources instead.
const build = dev ? null : mkdtempSync(join(tmpdir(), "hekate-screens-"));
if (build) {
  const built = vite(
    ["build", "--outDir", build, "--emptyOutDir", "--logLevel", "warn"],
    "inherit",
  );
  const code = await new Promise((resolve) => built.on("exit", resolve));
  if (code !== 0) {
    rmSync(build, { recursive: true, force: true });
    console.error(`The build failed (exit ${code}).`);
    process.exit(1);
  }
}

const port = await freePort();
const base = `http://127.0.0.1:${port}/`;
const server = vite(
  [
    ...(build ? ["preview", "--outDir", build] : []),
    "--port",
    String(port),
    "--strictPort",
    "--host",
    "127.0.0.1",
  ],
  "ignore",
);
const stop = () => {
  if (server.exitCode === null) server.kill("SIGTERM");
  if (build) rmSync(build, { recursive: true, force: true });
};
process.on("exit", stop);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stop();
    process.exit(130);
  });

let failures = 0;
try {
  await waitFor(base, server);
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const screen of chosen) {
      try {
        const warnings = await capture(browser, screen);
        console.log(`ok    ${screen.name}`);
        for (const w of warnings) console.log(`      console: ${w.slice(0, 200)}`);
      } catch (error) {
        failures++;
        const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
        console.error(`FAIL  ${screen.name}: ${message}`);
      }
    }
  } finally {
    await browser.close();
  }
} finally {
  stop();
}
console.log(`${chosen.length - failures} of ${chosen.length} screens written to docs/screens.`);
if (failures) process.exit(1);

/** One screen in a fresh context: its remembered choices, its address, its steps, the picture. */
async function capture(browser, screen) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  context.setDefaultTimeout(10_000);
  try {
    const remembered = {
      "hekate.prototype.persona": JSON.stringify({ id: screen.persona ?? "owner" }),
      "hekate.prototype.settings": JSON.stringify({
        shadows: true,
        width: screen.width ?? "desktop",
        state: screen.state ?? "normal",
      }),
      ...screen.storage,
    };
    // Only before the first load: what the steps change is kept if the page loads again.
    await context.addInitScript((values) => {
      if (sessionStorage.getItem("hekate.screens")) return;
      sessionStorage.setItem("hekate.screens", "1");
      localStorage.clear();
      for (const [k, v] of Object.entries(values)) localStorage.setItem(k, v);
    }, remembered);
    const page = await context.newPage();
    const errors = [];
    const warnings = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") warnings.push(m.text());
    });
    await page.goto(`${base}#${screen.route}`, { waitUntil: "networkidle" });
    await settle(page);
    for (const step of screen.steps ?? []) {
      if (step.click) await page.locator(step.click).first().click();
      else if (step.press) await page.keyboard.press(step.press);
      else if (step.type) await page.keyboard.type(step.type);
      else if (step.fill) await page.locator(step.fill[0]).first().fill(step.fill[1]);
      else if (step.select) await page.locator(step.select[0]).first().selectOption(step.select[1]);
      else if (step.scroll) await scrollTo(page, step.scroll);
      else if (step.wait) await page.waitForTimeout(step.wait);
      await settle(page);
    }
    // The pointer away from the page, so nothing shows a hover it would not have.
    await page.mouse.move(1439, 899);
    await settle(page);
    if (errors.length) throw new Error(`the page threw: ${errors.join("; ")}`);
    if (await page.getByText("There is nothing at this address").count())
      throw new Error("the page answered Not found");
    await page.screenshot({ path: join(out, `${screen.name}.png`) });
    return warnings;
  } finally {
    await context.close();
  }
}

/** Fonts in, the frame painted, and a moment for anything that rises in. */
async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  await page.waitForTimeout(400);
}

/** Brings a heading near the top of the pane it scrolls in, and moves nothing else. */
async function scrollTo(page, text) {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = page
    .locator("h1, h2, h3, h4")
    .filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`) })
    .first();
  await heading.evaluate((el) => {
    let pane = el.parentElement;
    while (
      pane &&
      !(
        pane.scrollHeight > pane.clientHeight &&
        /auto|scroll/.test(getComputedStyle(pane).overflowY)
      )
    )
      pane = pane.parentElement;
    if (!pane) return el.scrollIntoView({ block: "start" });
    pane.scrollTop += el.getBoundingClientRect().top - pane.getBoundingClientRect().top - 32;
  });
}

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Page, test } from "@playwright/test";

/** Where a run keeps its sign-in, its store and what it seeded. */
export const state = join(import.meta.dirname, "../.state");

/** The moment every capture is taken at, so dates read the same in every run. */
export const FIXED_TIME = "2026-10-14T10:00:00Z";

export interface Seeded {
  musicProjectId: string;
  videoProjectId: string;
  trackId: string;
  dryFileId: string;
  scoreFileId: string;
  cutFileId: string;
  reviewId: string;
  /** A review in each state its page shows, by state. */
  reviewStates: Record<
    "decided" | "changes" | "approved" | "cancelled" | "waiting" | "overdue",
    string
  >;
  /** An invitation's page, waiting to be accepted. */
  invitationPath: string;
  /** A guest link already used, which no longer signs anyone in. */
  usedGuestPath: string;
}

export const seeded = (): Seeded =>
  JSON.parse(readFileSync(join(state, "seeded.json"), "utf8")) as Seeded;

const screens = join(import.meta.dirname, "../test-results/screens");

/** Keeps a capture of the whole page, named for the screen, for people and CI to look at. */
export async function saveScreen(page: Page, name: string) {
  mkdirSync(screens, { recursive: true });
  // The seed and the installer run once; the screens run at each width, so the width's project
  // names the file.
  const project = test.info().project.name;
  const file = project === "seed" || project === "install" ? name : `${name}-${project}`;
  // Transitions finish first, so a capture never shows a control halfway to its new state.
  await page.screenshot({
    path: join(screens, `${file}.png`),
    fullPage: true,
    animations: "disabled",
  });
}

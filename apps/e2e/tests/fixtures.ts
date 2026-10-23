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
  /** A recording session (#21, #45) with three of the track's takes. */
  sessionId: string;
  dryFileId: string;
  scoreFileId: string;
  cutFileId: string;
  /** A deliverable (#16): a track in the video project, its first cut in two renditions. */
  deliverableId: string;
  /** Its second cut (#147), to compare with the first. */
  cutTwoFileId: string;
  reviewId: string;
  /** A review in each state its page shows, by state. */
  reviewStates: Record<
    "decided" | "changes" | "approved" | "cancelled" | "waiting" | "overdue",
    string
  >;
  /** A share (#138): a track shared with a guest, nothing asked. */
  shareId: string;
  /** A task (#140): late, in progress, about the track, with notes. */
  taskId: string;
  /** An invitation's page, waiting to be accepted. */
  invitationPath: string;
  /** An operator's invitation to make a workspace (#184), registration being invite-only. */
  signUpPath: string;
  /** An upload request's page (#139), as the person sending sees it. */
  uploadLinkPath: string;
  /** A guest link already used, which no longer signs anyone in. */
  usedGuestPath: string;
  /** A general project (#149): a booklet in two proofs, a cover and print files. */
  generalProjectId: string;
  /** The booklet's second proof, replacing the first, with region comments. */
  bookletFileId: string;
  /** Print files with no viewer: the "other file" page. */
  printFileId: string;
  /** The approval the booklet went through. */
  signOffId: string;
  /** The label's logo (#185), as its public pages are told it. */
  brandLogo: { url: string; width: number; height: number };
  /** An OAuth consent screen (#447): a delivery service asking the owner for access. */
  consentPath: string;
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

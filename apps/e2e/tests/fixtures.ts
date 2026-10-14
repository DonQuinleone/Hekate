import { readFileSync } from "node:fs";
import { join } from "node:path";

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
}

export const seeded = (): Seeded =>
  JSON.parse(readFileSync(join(state, "seeded.json"), "utf8")) as Seeded;

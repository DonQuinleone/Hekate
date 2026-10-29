/**
 * What the seed (seed.ts) makes, by id, for whoever runs it next: the visual suite's screens
 * read these from `.state/seeded.json`.
 */

/** The moment the suite takes every capture at, and the clock the seed's rows are set to. */
export const FIXED_TIME = "2026-10-14T10:00:00Z";

export interface Seeded {
  musicProjectId: string;
  videoProjectId: string;
  trackId: string;
  /** A recording session (#21, #45) with three of the track's takes. */
  sessionId: string;
  /** Its third take: starred, with bars, a page and timecode, and used by V2's edit list. */
  takeId: string;
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
  /**
   * A guest link already used, which no longer signs anyone in. Empty where the seed could
   * not read the guest's link (the demo has no log to read it from).
   */
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

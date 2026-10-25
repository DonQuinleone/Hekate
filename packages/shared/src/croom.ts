import { z } from "zod";

/**
 * Importing a ControlRoom project (#57, decision 242): a `.croom` file is read, its events
 * replayed into what Hekate will create, and shown as a preview before anything is written.
 * The import itself sends the same file again with the choice made for anything already in the
 * project, so nothing of the file is kept between the two steps.
 */

/** The largest `.croom` file accepted: its embedded scores make it the size it is. */
export const CROOM_MAX_BYTES = 200 * 1024 * 1024;

/** What happens to a work, venue, person, stage plan, stage box or category the project already has. */
export const croomConflictChoices = ["merge", "new"] as const;
export type CroomConflictChoice = (typeof croomConflictChoices)[number];

/** The import's one choice: merge into what the project already has by name, or add beside it. */
export const croomImportQuery = z.object({
  conflicts: z.enum(croomConflictChoices).default("merge"),
});
export type CroomImportQuery = z.input<typeof croomImportQuery>;

/** What an import creates, in the order the preview lists it. */
export const croomKinds = [
  "work",
  "track",
  "score",
  "venue",
  "personnel",
  "session",
  "take",
  "category",
  "score-mark",
  "schedule-day",
  "schedule-row",
  "stage-plan",
  "stage-item",
  "stage-box",
  "patch-row",
] as const;
export type CroomKind = (typeof croomKinds)[number];

/** Each kind as the preview names it: one, and more than one. */
export const croomKindWords: Record<CroomKind, readonly [string, string]> = {
  work: ["Work", "Works"],
  track: ["Track", "Tracks"],
  score: ["Score PDF", "Score PDFs"],
  venue: ["Venue", "Venues"],
  personnel: ["Person on the personnel", "Personnel"],
  session: ["Session", "Sessions"],
  take: ["Take", "Takes"],
  category: ["Issue category", "Issue categories"],
  "score-mark": ["Score mark", "Score marks"],
  "schedule-day": ["Schedule day", "Schedule days"],
  "schedule-row": ["Schedule row", "Schedule rows"],
  "stage-plan": ["Stage plan", "Stage plans"],
  "stage-item": ["Stage item", "Stage items"],
  "stage-box": ["Stage box", "Stage boxes"],
  "patch-row": ["Patch row", "Patch rows"],
};

/** How many of a kind the import creates, and how many it merges into what is there. */
export interface CroomCount {
  kind: CroomKind;
  create: number;
  merge: number;
}

/** Something in the file with the name of something the project already has. */
export interface CroomConflict {
  kind: CroomKind;
  name: string;
}

/**
 * What the file held that the import does not bring over: event types it does not know, fields
 * it did not read, events it reads and sets aside (view state), and problems with particular
 * entries (a take of no track, a mark off the page), each counted.
 */
export interface CroomReport {
  unknownEvents: { type: string; count: number }[];
  unknownFields: { type: string; field: string; count: number }[];
  ignored: { type: string; count: number; reason: string }[];
  problems: string[];
}

export interface CroomPreview {
  schemaVersion: number;
  events: { replayed: number; undone: number };
  counts: CroomCount[];
  /** A few names of each kind, for the preview to show what it means. */
  names: { kind: CroomKind; names: string[] }[];
  conflicts: CroomConflict[];
  report: CroomReport;
}

export interface CroomImported {
  counts: CroomCount[];
  report: CroomReport;
}

/** The kinds a preview counts, with the words for the count: "5 Tracks", "1 Work". */
export function croomCountLine(count: CroomCount): string {
  const total = count.create + count.merge;
  const [one, many] = croomKindWords[count.kind];
  return `${total} ${total === 1 ? one : many}`;
}

/** Whether a report holds anything worth showing. */
export function croomReportEmpty(report: CroomReport): boolean {
  return (
    report.unknownEvents.length === 0 &&
    report.unknownFields.length === 0 &&
    report.ignored.length === 0 &&
    report.problems.length === 0
  );
}

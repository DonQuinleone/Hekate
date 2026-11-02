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
  "file",
  "venue",
  "personnel",
  "session",
  "take",
  "todo",
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
  file: ["Attached file", "Attached files"],
  venue: ["Venue", "Venues"],
  personnel: ["Person on the personnel", "Personnel"],
  session: ["Session", "Sessions"],
  take: ["Take", "Takes"],
  todo: ["To-do", "To-dos"],
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
 * it did not read, what it reads and sets aside with why (view state, settings of the desktop
 * app's exports, anything Hekate has no place for), and problems with particular entries (a
 * take number already used, a mark with nothing to say), each counted.
 */
export interface CroomReport {
  unknownEvents: { type: string; count: number }[];
  unknownFields: { type: string; field: string; count: number }[];
  ignored: { type: string; count: number; reason: string }[];
  /** Each a sentence about the thing, for people: no event or field ids (#551). */
  problems: string[];
  /** The same problems as the file names them, with its ids, for "Details for support". */
  support: string[];
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

/** What each kind of entry a ControlRoom event changes is, in words: "a take's rating". */
const croomSubjects: Record<string, string> = {
  annotation: "a score mark",
  annotation_note: "a score mark's note",
  annotation_status: "a score mark's state",
  annotation_takes: "the takes a score mark names",
  attachment: "an attached file",
  category: "an issue category",
  movement: "a track",
  pdf: "a score PDF",
  pdf_page_offset: "a score PDF's page numbers",
  personnel: "a person on the personnel",
  piece: "a work",
  work: "a work",
  schedule_item: "a schedule row",
  stage_plan: "a stage plan",
  stagebox: "a stage box",
  stage_element: "an element of a stage plan",
  stage_elements: "elements of a stage plan",
  take: "a take",
  take_rating: "a take's rating",
  take_notes: "a take's notes",
  take_timecode: "a take's timecode",
  take_lifecycle: "a take's place in the log",
  false_start: "a take's false start",
  todo: "a to-do",
  todos: "the to-dos",
  venue: "a venue",
  view: "a window layout of the desktop app",
  active_view: "the desktop app's window layout",
  view_layout: "a window layout of the desktop app",
  session: "the session",
  meta: "the project's details",
  notes: "the session's notes",
};
const croomVerbs =
  /^(add|update|delete|set|upsert|move|remove|replace|toggle|reorder|rename|adjust|create)_/;

/**
 * A ControlRoom event as people would name what it changes, to start a sentence: "A change to a
 * take's rating" for `set_take_rating`, "A change Hekate does not know" for anything else. A
 * nested field's event (`update_venue.address`) is its event's.
 */
export function croomChangeWords(type: string): string {
  const subject = croomSubject(type);
  return subject ? `A change to ${subject}` : "A change Hekate does not know";
}

/** What an event changes, in words ("a venue" for `update_venue.address`), or null if unknown. */
export function croomSubject(type: string): string | null {
  return croomSubjects[(type.split(/[. ]/)[0] ?? "").replace(croomVerbs, "")] ?? null;
}

/** Something already in the project, as a sentence names it: the work “Rags”, Mira Solberg on the personnel. */
export function croomConflictWords(conflict: CroomConflict): string {
  if (conflict.kind === "personnel") return `${conflict.name} on the personnel`;
  return `the ${croomKindWords[conflict.kind][0].toLowerCase()} “${conflict.name}”`;
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

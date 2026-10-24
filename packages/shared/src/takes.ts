import { z } from "zod";
import type { SessionRecorder } from "./recorders.ts";
import { timecodePattern } from "./video-time.ts";

/**
 * Takes (#21, #46): recording-session snippets made for a track, never versions of it. Each is
 * one scratch mix for now; its rating, star and notes are the producer's, and its page, bars and
 * in and out points are optional, since bars matter for a classical piece and not a pop song.
 */

export const TAKE_RATING_MAX = 5;

const bar = z.number().int().min(0).max(100_000);
const seconds = z
  .number()
  .min(0)
  .max(24 * 60 * 60);

/** Files already in the project, each made a take of the track, numbered in the order given. */
export const addTakesInput = z.object({ fileIds: z.array(z.uuid()).min(1).max(100) });

/**
 * Takes made by an import (#45), up to a hundred at a time: each a file already uploaded into
 * the project, the track it is a take of, the session it was recorded in, and its label.
 */
export const takeImportInput = z.object({
  takes: z
    .array(
      z.object({
        fileId: z.uuid(),
        trackId: z.uuid(),
        sessionId: z.uuid().nullable(),
        label: z.string().trim().max(120).nullable().optional(),
        /**
         * The take number the file was recorded as ("27", "12A"), where known. A whole number
         * that names a take logged in the session (#51) and still without a file gives it this
         * file, rather than making another take.
         */
        take: z.string().trim().max(20).nullable().optional(),
      }),
    )
    .min(1)
    .max(100),
});

/** The take a written number names in the take log: a whole number, else none ("12A"). */
export function loggedNumber(written: string | null | undefined): number | null {
  const n = /^0*(\d{1,6})$/.exec(written?.trim() ?? "")?.[1];
  return n === undefined ? null : Number(n);
}
export type TakeImport = z.infer<typeof takeImportInput>;

/** Takes of the thread's track shared on it (#133), for everyone who sees the thread to hear. */
export const shareTakesInput = z.object({ takeIds: z.array(z.uuid()).min(1).max(50) });

/**
 * Where a take is in the control room (#51): waiting, armed, rolling, done, or stopped short.
 * Takes made from files are recorded already.
 */
export const takeLifecycles = ["idle", "armed", "recording", "recorded", "aborted"] as const;
export type TakeLifecycle = (typeof takeLifecycles)[number];

/**
 * Where a take may go from each state: aborted only before it is recorded, and an aborted take
 * can be counted after all; a recorded take stays recorded.
 */
const lifecycleMoves: Record<TakeLifecycle, readonly TakeLifecycle[]> = {
  idle: ["armed", "recording", "aborted"],
  armed: ["idle", "recording", "aborted"],
  recording: ["recorded", "aborted"],
  recorded: [],
  aborted: ["recorded"],
};

/** Whether a take may move from one state to another; staying put always may. */
export const canMoveTake = (from: TakeLifecycle, to: TakeLifecycle) =>
  from === to || lifecycleMoves[from].includes(to);

/**
 * How a session numbers the takes logged in it (#51): on from the project's last take, so
 * every take of the recording has its own number; from each track's last; or as the recorder
 * numbers them.
 */
export const takeNumberings = ["continuous", "per-track", "recorder"] as const;
export type TakeNumbering = (typeof takeNumberings)[number];

/** The number the next take gets, from the highest numbers so far (0 for none). */
export function nextTakeNumber(
  numbering: TakeNumbering,
  last: { project: number; track: number },
  given?: number,
): number {
  if (numbering === "recorder" && given !== undefined) return given;
  return (numbering === "continuous" ? last.project : last.track) + 1;
}

const timecode = z.string().regex(timecodePattern, "A timecode such as 10:00:00:00");
const moment = z.iso.datetime({ offset: true });

/**
 * A take started in the take log (#51): the track it is of, and optionally the recorder's
 * number and timecode. It starts rolling, or armed to roll.
 */
export const startTakeInput = z.object({
  trackId: z.uuid(),
  lifecycle: z.enum(["armed", "recording"]).default("recording"),
  /** The recorder's number, for a session numbered by the recorder. */
  number: z.number().int().min(1).max(100_000).optional(),
  timecodeIn: timecode.optional(),
  /**
   * Made by the take log (UUIDv7), so a start written offline and sent again when the
   * connection returns makes the one take, not two.
   */
  id: z.uuid({ version: "v7" }).optional(),
  /** When it started, by the log's clock: earlier than now for a take logged offline. */
  at: moment.optional(),
});
export type StartTake = z.infer<typeof startTakeInput>;

/** What changes on a take; anything left out stays as it is. */
export const takeChangeInput = z.object({
  label: z.string().trim().max(120).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
  rating: z.number().int().min(0).max(TAKE_RATING_MAX).optional(),
  starred: z.boolean().optional(),
  page: z.number().int().min(1).max(10_000).nullable().optional(),
  barFrom: bar.nullable().optional(),
  barTo: bar.nullable().optional(),
  inPoint: seconds.nullable().optional(),
  outPoint: seconds.nullable().optional(),
  /** The session it was recorded in, of the same project; null for none. */
  sessionId: z.uuid().nullable().optional(),
  // The take log's (#51).
  lifecycle: z.enum(takeLifecycles).optional(),
  falseStarts: z.number().int().min(0).max(99).optional(),
  timecodeIn: timecode.nullable().optional(),
  timecodeOut: timecode.nullable().optional(),
  wallIn: moment.nullable().optional(),
  wallOut: moment.nullable().optional(),
  /** The page the take ends on, where it turns one. */
  pageTo: z.number().int().min(1).max(10_000).nullable().optional(),
  /**
   * What the writer last saw of the fields it changes. Where the take holds something else,
   * someone changed it meanwhile: the write still stands, and the history says it overwrote.
   */
  base: z.record(z.string(), z.unknown()).optional(),
  /** When it was written, by the writer's clock: earlier than now for a change made offline. */
  at: moment.optional(),
});
export type TakeChange = z.infer<typeof takeChangeInput>;

/** A field of a take that the history records (everything a change can set). */
export const takeHistoryFields = [
  "label",
  "notes",
  "rating",
  "starred",
  "page",
  "barFrom",
  "barTo",
  "inPoint",
  "outPoint",
  "sessionId",
  "lifecycle",
  "falseStarts",
  "timecodeIn",
  "timecodeOut",
  "wallIn",
  "wallOut",
  "pageTo",
] as const;
export type TakeHistoryField = (typeof takeHistoryFields)[number];

/** One field's change on a take, as the history shows it. */
export interface TakeHistoryEntry {
  id: string;
  field: TakeHistoryField;
  before: unknown;
  after: unknown;
  by: { id: string; name: string } | null;
  writtenAt: string;
  savedAt: string;
  overwrote: boolean;
}

/**
 * The fields a change sets, each with the value it replaces and whether that was someone
 * else's: the take held something other than the writer's `base`. Fields that do not change
 * are left out. Values compare as JSON, so a date and its ISO string are the same value.
 */
export function fieldChanges(
  current: Partial<Record<TakeHistoryField, unknown>>,
  change: Partial<Record<TakeHistoryField, unknown>>,
  base?: Record<string, unknown>,
): { field: TakeHistoryField; before: unknown; after: unknown; overwrote: boolean }[] {
  // A moment in one form, whether it came as a date or as an ISO string with any offset.
  const plain = (field: string, v: unknown): unknown =>
    v instanceof Date
      ? v.toISOString()
      : (field === "wallIn" || field === "wallOut") && typeof v === "string"
        ? new Date(v).toISOString()
        : (v ?? null);
  const same = (field: string, a: unknown, b: unknown) =>
    JSON.stringify(plain(field, a)) === JSON.stringify(plain(field, b));
  const out = [];
  for (const field of takeHistoryFields) {
    if (!(field in change) || change[field] === undefined) continue;
    const before = plain(field, current[field]);
    const after = plain(field, change[field]);
    if (same(field, before, after)) continue;
    const overwrote = base !== undefined && field in base && !same(field, base[field], before);
    out.push({ field, before, after, overwrote });
  }
  return out;
}

/**
 * A recording session (#21, #45): a day or a sitting, where it was, and the tracks it
 * recorded. The tracks are given in full, replacing those it had.
 */
export const sessionInput = z.object({
  name: z.string().trim().min(1).max(120),
  /** The day it was recorded: 2026-10-14. */
  recordedOn: z.iso.date().nullable().optional(),
  venue: z.string().trim().max(200).nullable().optional(),
  trackIds: z.array(z.uuid()).max(200).optional(),
  /** How the take log numbers its takes (#51). */
  numbering: z.enum(takeNumberings).optional(),
  /** The booked slot, which the take log counts down to. */
  slotStart: moment.nullable().optional(),
  slotEnd: moment.nullable().optional(),
  /** The room's notes on the day, and the producer's quick reference (#51). */
  notes: z.string().trim().max(4000).nullable().optional(),
  reference: z.string().trim().max(2000).nullable().optional(),
});
export type SessionInput = z.infer<typeof sessionInput>;
export const sessionChangeInput = sessionInput.partial();
export type SessionChange = z.infer<typeof sessionChangeInput>;

/** A session as the project's list shows it. */
export interface SessionSummary {
  id: string;
  projectId: string;
  name: string;
  recordedOn: string | null;
  venue: string | null;
  numbering: TakeNumbering;
  slotStart: string | null;
  slotEnd: string | null;
  notes: string | null;
  reference: string | null;
  /** The tracks it recorded, each with the score it follows, if any. */
  tracks: { id: string; name: string; scoreFileId: string | null }[];
  /** The takes recorded in it, how many are starred, and how long they run together. */
  takes: number;
  starred: number;
  duration: number;
}

/** A session in full: its takes, each with the track it belongs to. */
export interface SessionDetail extends SessionSummary {
  takeRows: (TakeRow & { track: { id: string; name: string } })[];
  /** The number the next take of each of its tracks would get, as the session numbers them (#51). */
  nextNumbers: Record<string, number>;
  /** The take log's to-do list, oldest first. */
  todos: SessionTodo[];
  /** Who drives its takes from a recorder now (decision 240); null when no one does. */
  recorder: SessionRecorder | null;
}

/** One thing to do in a session (#51). */
export interface SessionTodo {
  id: string;
  text: string;
  done: boolean;
}

/** A new thing to do, and a change to one. */
export const sessionTodoInput = z.object({
  /** Named by the take log (a UUIDv7), so one sent twice, written offline, is made once. */
  id: z.uuid({ version: "v7" }).optional(),
  text: z.string().trim().min(1).max(200),
});
export const sessionTodoChangeInput = z
  .object({ text: z.string().trim().min(1).max(200).optional(), done: z.boolean().optional() })
  .refine((c) => c.text !== undefined || c.done !== undefined, { message: "Nothing to change" });
export type SessionTodoChange = z.infer<typeof sessionTodoChangeInput>;

/** A take's place, as it would be once a change is made. */
export interface TakePlace {
  /** The pages it starts and ends on, where those are given. */
  page?: number | null;
  pageTo?: number | null;
  barFrom: number | null;
  barTo: number | null;
  inPoint: number | null;
  outPoint: number | null;
}

/** Why a session's slot cannot be, or null when it can. */
export function slotProblem(start: string | null, end: string | null): string | null {
  if (start && end && Date.parse(end) <= Date.parse(start)) return "The slot ends before it starts";
  return null;
}

/** Why a take's bars or in and out points cannot be, or null when they can. */
export function takeProblem(t: TakePlace): string | null {
  if (t.barFrom !== null && t.barTo !== null && t.barFrom > t.barTo)
    return "The last bar comes before the first";
  if (t.barFrom === null && t.barTo !== null) return "Give the first bar too";
  if ((t.page ?? null) === null && (t.pageTo ?? null) !== null) return "Give the first page too";
  if (t.page != null && t.pageTo != null && t.pageTo < t.page)
    return "The last page comes before the first";
  if (t.inPoint !== null && t.outPoint !== null && t.inPoint >= t.outPoint)
    return "The out point comes before the in point";
  return null;
}

/** A take as the take manager shows it. */
export interface TakeRow extends TakePlace {
  id: string;
  number: number;
  label: string | null;
  notes: string | null;
  rating: number;
  starred: boolean;
  page: number | null;
  /** The session it was recorded in, if any. */
  sessionId: string | null;
  lifecycle: TakeLifecycle;
  falseStarts: number;
  timecodeIn: string | null;
  timecodeOut: string | null;
  /** When it started and stopped rolling, by the wall clock. */
  wallIn: string | null;
  wallOut: string | null;
  pageTo: number | null;
  /** Its scratch mix; null once the file is gone. */
  file: { id: string; name: string; duration: number | null; streamStatus: string } | null;
  createdAt: string;
}

/** A take shared on a thread: what a reviewer is shown of it, and the file to hear. */
export type SharedTake = Pick<
  TakeRow,
  | "id"
  | "number"
  | "label"
  | "notes"
  | "rating"
  | "starred"
  | "barFrom"
  | "barTo"
  | "inPoint"
  | "outPoint"
  | "file"
>;

/** The bars a take covers: its range, or the one bar when only the first is given. */
export const barsOf = (t: Pick<TakePlace, "barFrom" | "barTo">): [number, number] | null =>
  t.barFrom === null ? null : [t.barFrom, t.barTo ?? t.barFrom];

/**
 * Where a bar lies in a take, in seconds (#46): its bars spread evenly over the part that
 * counts (its in to out points, or the whole file), as an edit decision list's bars are read
 * (`barsUsed`). Null where the take does not cover the bar or its length is unknown.
 */
export function barSpan(
  take: TakePlace & { duration: number | null },
  bar: number,
): [number, number] | null {
  const range = barsOf(take);
  if (!range || bar < range[0] || bar > range[1]) return null;
  const start = take.inPoint ?? 0;
  const end = take.outPoint ?? take.duration;
  if (end === null || end <= start) return null;
  const each = (end - start) / (range[1] - range[0] + 1);
  return [start + (bar - range[0]) * each, start + (bar - range[0] + 1) * each];
}

/** Whether a take covers a bar. */
export function covers(t: Pick<TakePlace, "barFrom" | "barTo">, bar: number): boolean {
  const range = barsOf(t);
  return range !== null && range[0] <= bar && bar <= range[1];
}

/** Every take covering a bar: starred first, then by rating, then in order. */
export function takesCovering<
  T extends Pick<TakeRow, "barFrom" | "barTo" | "starred" | "rating" | "number">,
>(all: T[], bar: number): T[] {
  return all
    .filter((t) => covers(t, bar))
    .sort(
      (a, b) => Number(b.starred) - Number(a.starred) || b.rating - a.rating || a.number - b.number,
    );
}

/**
 * The bars no take covers, as ranges, from bar 1 to the last bar any take reaches. An upbeat
 * (bar 0) counts only when a take covers it.
 */
export function coverageGaps(all: Pick<TakePlace, "barFrom" | "barTo">[]): [number, number][] {
  const ranges = all.flatMap((t) => {
    const r = barsOf(t);
    return r ? [r] : [];
  });
  if (ranges.length === 0) return [];
  const last = Math.max(...ranges.map((r) => r[1]));
  const gaps: [number, number][] = [];
  let start: number | null = null;
  for (let bar = 1; bar <= last; bar++) {
    const covered = ranges.some(([a, b]) => a <= bar && bar <= b);
    if (!covered && start === null) start = bar;
    if (covered && start !== null) {
      gaps.push([start, bar - 1]);
      start = null;
    }
  }
  if (start !== null) gaps.push([start, last]);
  return gaps;
}

/** Uncovered bars as said: "bars 33 to 40 and 52", or "bars 9 to 12, 20 and 33 to 40". */
export function gapsLabel(gaps: [number, number][]): string {
  const parts = gaps.map(([a, b]) => (a === b ? `${a}` : `${a} to ${b}`));
  const single = gaps.length === 1 && gaps[0]?.[0] === gaps[0]?.[1];
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `${single ? "bar" : "bars"} ${list}`;
}

/** "bars 64 to 88", "bar 12", or null for a take without bars. */
export function barsLabel(t: Pick<TakePlace, "barFrom" | "barTo">): string | null {
  const r = barsOf(t);
  if (!r) return null;
  return r[0] === r[1] ? `bar ${r[0]}` : `bars ${r[0]} to ${r[1]}`;
}

/** A point in a take as typed: seconds ("92.5") or a clock ("1:32.5", "1:02:03"); null if neither. */
export function parseClock(input: string): number | null {
  const parts = input.trim().split(":");
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  const numbers = parts.map(Number);
  if (numbers.slice(1).some((n) => n >= 60)) return null;
  if (numbers.slice(0, -1).some((n) => !Number.isInteger(n))) return null;
  return numbers.reduce((total, n) => total * 60 + n, 0);
}

/** A point as a clock to the tenth of a second: "1:32.5", or "1:32" on the second. */
export function clockOf(seconds: number): string {
  const tenths = Math.round(seconds * 10);
  const whole = Math.floor(tenths / 10);
  const h = Math.floor(whole / 3600);
  const m = Math.floor(whole / 60) % 60;
  const s = String(whole % 60).padStart(2, "0");
  const fraction = tenths % 10 ? `.${tenths % 10}` : "";
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}${fraction}` : `${m}:${s}${fraction}`;
}

const csvCell = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
/** People's words in a spreadsheet cell: never read as a formula (OWASP's CSV injection). */
const spreadsheetText = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);

/** How each state is said, in the take log and its export. */
export const takeLifecycleNames: Record<TakeLifecycle, string> = {
  idle: "Waiting",
  armed: "Armed",
  recording: "Recording",
  recorded: "Recorded",
  aborted: "Aborted",
};

/** A session's take log as a spreadsheet (#51), one take a row, in the order given. */
export function takeLogCsv(rows: SessionDetail["takeRows"]): string {
  const header = [
    "Take",
    "Track",
    "State",
    "Rating",
    "Starred",
    "False starts",
    "Timecode in",
    "Timecode out",
    "Wall clock in",
    "Wall clock out",
    "Page",
    "Bars",
    "Notes",
  ];
  const pages = (t: TakeRow) =>
    t.page === null
      ? ""
      : t.pageTo && t.pageTo !== t.page
        ? `${t.page}–${t.pageTo}`
        : String(t.page);
  const bars = (t: TakeRow) =>
    t.barFrom === null ? "" : t.barTo === null ? String(t.barFrom) : `${t.barFrom}–${t.barTo}`;
  const body = rows.map((t) => [
    String(t.number),
    spreadsheetText(t.track.name),
    takeLifecycleNames[t.lifecycle],
    t.rating ? String(t.rating) : "",
    t.starred ? "Yes" : "",
    t.falseStarts ? String(t.falseStarts) : "",
    t.timecodeIn ?? "",
    t.timecodeOut ?? "",
    t.wallIn ?? "",
    t.wallOut ?? "",
    pages(t),
    bars(t),
    spreadsheetText(t.notes ?? ""),
  ]);
  return `${[header, ...body].map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

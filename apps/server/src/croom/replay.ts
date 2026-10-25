import { categories } from "./families/categories.ts";
import { pdfs } from "./families/pdfs.ts";
import { personnel } from "./families/personnel.ts";
import { repertoire } from "./families/repertoire.ts";
import { schedule } from "./families/schedule.ts";
import { scoreMarks } from "./families/score-marks.ts";
import { sessions } from "./families/sessions.ts";
import { stage } from "./families/stage.ts";
import { takes } from "./families/takes.ts";
import { venues } from "./families/venues.ts";
import { views } from "./families/views.ts";
import type { Family, Handler, ReplayContext } from "./family.ts";
import { fieldsOf } from "./fields.ts";
import { type CroomModel, emptyModel, ReportCollector } from "./model.ts";
import type { CroomEvent, CroomFile } from "./reader.ts";
import { KNOWN_SCHEMA_VERSIONS } from "./reader.ts";

/**
 * Replaying a `.croom` file's events into the neutral model (#57, decision 242). Branch 0 is
 * replayed in `seq` order; undone events (branch 1) never are. Each event goes to the family
 * that reads it (`families/`); an event no family knows, or a field none read, is counted in
 * the report and the replay carries on.
 */
export const families: readonly Family[] = [
  sessions,
  categories,
  views,
  repertoire,
  pdfs,
  takes,
  scoreMarks,
  personnel,
  venues,
  schedule,
  stage,
];

type Verb = "add" | "update" | "remove";

const verbs: Record<string, Verb> = {
  add: "add",
  added: "add",
  create: "add",
  created: "add",
  new: "add",
  insert: "add",
  inserted: "add",
  update: "update",
  updated: "update",
  edit: "update",
  edited: "update",
  set: "update",
  change: "update",
  changed: "update",
  rename: "update",
  renamed: "update",
  modify: "update",
  modified: "update",
  remove: "remove",
  removed: "remove",
  delete: "remove",
  deleted: "remove",
};

/** An event type in one form: lower case, words joined by underscores ("Take.Add" is "take_add"). */
export const normalType = (type: string) =>
  type
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

/** A type as a verb and a noun: `add_take`, `take_add` and `take_added` all read as add take. */
export function verbAndNoun(normal: string): { verb: Verb; noun: string } | null {
  const parts = normal.split("_");
  if (parts.length < 2) return null;
  const first = verbs[parts[0] as string];
  if (first) return { verb: first, noun: parts.slice(1).join("_") };
  const last = verbs[parts.at(-1) as string];
  if (last) return { verb: last, noun: parts.slice(0, -1).join("_") };
  return null;
}

interface Route {
  handler?: Handler;
  ignored?: string;
}

function routes() {
  const exact = new Map<string, Handler>();
  const nouns = new Map<string, Record<string, Handler | undefined>>();
  const ignored = new Map<string, string>();
  for (const family of families) {
    for (const [type, handler] of Object.entries(family.exact ?? {})) exact.set(type, handler);
    for (const [noun, handlers] of Object.entries(family.nouns))
      nouns.set(noun, { add: handlers.add, update: handlers.update, remove: handlers.remove });
    for (const [noun, reason] of Object.entries(family.ignoredNouns ?? {}))
      ignored.set(noun, reason);
  }
  return (normal: string): Route => {
    const outright = exact.get(normal);
    if (outright) return { handler: outright };
    const parsed = verbAndNoun(normal);
    if (!parsed) return ignored.has(normal) ? { ignored: ignored.get(normal) } : {};
    const reason = ignored.get(parsed.noun);
    if (reason) return { ignored: reason };
    return { handler: nouns.get(parsed.noun)?.[parsed.verb] };
  };
}

export interface ReplayResult {
  model: CroomModel;
  report: ReportCollector;
  replayed: number;
}

export interface ReplayOptions {
  /** Where the shared id counter starts; ControlRoom's first entry is provisionally 1. */
  firstId?: number;
}

/** The counter after an add_* event that is not read: past its own id if it has one, else on by one. */
export function skipId(payload: unknown, counter: number): number {
  const own =
    payload && typeof payload === "object" ? Number((payload as { id?: unknown }).id) : Number.NaN;
  if (Number.isInteger(own)) return own >= counter ? own + 1 : counter;
  return counter + 1;
}

/** Replays events, already filtered to branch 0 and in order, into the model. Pure. */
export function replay(events: readonly CroomEvent[], options: ReplayOptions = {}): ReplayResult {
  const model = emptyModel();
  const report = new ReportCollector();
  const route = routes();
  let counter = options.firstId ?? 1;
  let replayed = 0;
  for (const event of events) {
    if (event.payloadError) {
      report.problem(
        `Event ${event.seq} (${event.type}): ${event.payloadError}, so it was skipped`,
      );
      continue;
    }
    const normal = normalType(event.type);
    const found = route(normal);
    if (found.ignored || !found.handler) {
      // Every add_* event takes an id from the shared counter, read or not, or the entries
      // after it would be numbered differently from the file's own references to them.
      if (verbAndNoun(normal)?.verb === "add") counter = skipId(event.payload, counter);
      if (found.ignored) report.ignore(event.type, found.ignored);
      else report.unknownEvent(event.type || "(no type)");
      continue;
    }
    const f = fieldsOf(event.payload, event.type, report);
    const ctx: ReplayContext = {
      model,
      report,
      type: event.type,
      newId(fields) {
        const own = fields.id("id");
        if (own) {
          ctx.bump(own);
          return own;
        }
        return String(counter++);
      },
      bump(id) {
        const n = Number(id);
        if (Number.isInteger(n) && n >= counter) counter = n + 1;
      },
    };
    found.handler(ctx, f);
    f.done();
    replayed += 1;
  }
  return { model, report, replayed };
}

/** A whole file replayed, with what the reader itself found for the report. */
export function replayFile(file: CroomFile, options?: ReplayOptions): ReplayResult {
  const result = replay(file.events, options);
  if (!KNOWN_SCHEMA_VERSIONS.includes(file.schemaVersion))
    result.report.problem(
      `The file is in ControlRoom schema ${file.schemaVersion}, which this import has not been checked against: look over what it brings before importing`,
    );
  if (file.viewState > 0)
    for (let i = 0; i < file.viewState; i += 1)
      result.report.ignore("meta ui.*", "The desktop app's own view, not part of the project");
  if (file.otherBranches > 0)
    result.report.problem(
      `${file.otherBranches} events are on a branch other than the project and its undone events, so they were not replayed`,
    );
  const last = file.events.at(-1)?.seq;
  if (file.head !== null && last !== undefined && Number(file.head) !== last)
    result.report.problem(
      `The file's head (${file.head}) is not its last event (${last}): every event on the project's branch was replayed`,
    );
  return result;
}

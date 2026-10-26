import { attachments } from "./families/attachments.ts";
import { categories } from "./families/categories.ts";
import { pdfs } from "./families/pdfs.ts";
import { personnel } from "./families/personnel.ts";
import { repertoire } from "./families/repertoire.ts";
import { schedule } from "./families/schedule.ts";
import { scoreMarks } from "./families/score-marks.ts";
import { session } from "./families/session.ts";
import { stage } from "./families/stage.ts";
import { takes } from "./families/takes.ts";
import { todos } from "./families/todos.ts";
import { venues } from "./families/venues.ts";
import { views } from "./families/views.ts";
import type { Family, Handler, ReplayContext } from "./family.ts";
import { fieldsOf, isRecord } from "./fields.ts";
import { type CroomModel, emptyModel, ReportCollector } from "./model.ts";
import type { CroomEvent, CroomFile } from "./reader.ts";
import { KNOWN_SCHEMA_VERSIONS } from "./reader.ts";

/**
 * Replaying a `.croom` file's events into the model, as ControlRoom rebuilds a session when it
 * opens one (`Session::rebuild` in its `session.cpp`; #57, decision 242). The events replayed
 * are the reader's: the project's branch up to its head, in `seq` order. Each event's type is
 * the one its payload names, as ControlRoom reads it, and it goes to the family that reads it
 * (`families/`). An event no family knows is counted in the report and changes nothing, as in
 * ControlRoom: it draws no id.
 */
export const families: readonly Family[] = [
  session,
  categories,
  views,
  pdfs,
  repertoire,
  takes,
  scoreMarks,
  personnel,
  venues,
  schedule,
  stage,
  todos,
  attachments,
];

const handlers = new Map<string, Handler>(
  families.flatMap((family) => Object.entries(family.events)),
);

/** Every event type the replay reads, by the name ControlRoom writes. */
export const knownEventTypes: readonly string[] = [...handlers.keys()];

export interface ReplayResult {
  model: CroomModel;
  report: ReportCollector;
  replayed: number;
}

/** Replays events, already the project's branch to its head and in order, into the model. Pure. */
export function replay(events: readonly CroomEvent[]): ReplayResult {
  const model = emptyModel();
  const report = new ReportCollector();
  // ControlRoom's one counter: the first entry is 1, and each entry made takes the next.
  let counter = 1;
  let replayed = 0;
  let unknownMaker: string | null = null;
  for (const event of events) {
    if (event.payloadError || !isRecord(event.payload)) {
      report.problem(
        `Event ${event.seq} (${event.type}): ${event.payloadError ?? "its payload is not a set of fields"}, so it was skipped, as ControlRoom skips it`,
      );
      continue;
    }
    // ControlRoom reads the type from the payload, not from the events table's column.
    const written = event.payload.type;
    if (typeof written !== "string") {
      report.problem(
        `Event ${event.seq} (${event.type}): its payload names no type, so it was skipped, as ControlRoom skips it`,
      );
      continue;
    }
    if (written !== event.type)
      report.problem(
        `Event ${event.seq} is ${event.type} in the events table and ${written} in its payload: it was read as ControlRoom reads it, as ${written}`,
      );
    const handler = handlers.get(written);
    if (!handler) {
      report.unknownEvent(written || "(no type)");
      if (/^(add|upsert)_/.test(written)) unknownMaker = written;
      continue;
    }
    if (unknownMaker) {
      // An unknown event that makes something may have drawn an id in the ControlRoom that
      // wrote it; this one does not know it, so every id after it may be one out.
      report.problem(
        `The file was written by a newer ControlRoom (it has ${unknownMaker}): what comes after it may be linked to the wrong entries, so look it over before importing`,
      );
      unknownMaker = null;
    }
    const f = fieldsOf(event.payload, written, report);
    f.skip("type");
    const ctx: ReplayContext = {
      model,
      report,
      type: written,
      ts: event.ts,
      nextId: () => String(counter++),
      frameRate: () => model.meta.frameRate,
    };
    handler(ctx, f);
    f.done();
    replayed += 1;
  }
  return { model, report, replayed };
}

/** A whole file replayed, with what the reader itself found for the report. */
export function replayFile(file: CroomFile): ReplayResult {
  const result = replay(file.events);
  const { report } = result;
  if (!KNOWN_SCHEMA_VERSIONS.includes(file.schemaVersion))
    report.problem(
      `The file is in ControlRoom schema ${file.schemaVersion}, which this import has not been checked against: look over what it brings before importing`,
    );
  for (let i = 0; i < file.viewState; i += 1)
    report.ignore("meta ui.*", "The desktop app's own view of the score, not part of the project");
  for (const key of file.unknownMeta) report.unknownField("meta", key);
  if (file.head === null)
    report.problem(
      "The file says no head, as ControlRoom always writes one: every event on the project's branch was replayed",
    );
  if (file.otherBranches > 0)
    report.problem(
      `${file.otherBranches} events are on a branch ControlRoom never writes, so they were not replayed`,
    );
  return result;
}

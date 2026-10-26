import type { Fields } from "./fields.ts";
import type { CroomModel, FrameRate, ReportCollector } from "./model.ts";

/**
 * One family of ControlRoom events (the take log, the score's marks, the stage …), read by a
 * small module of its own under `families/` (decision 242). Each module names the event types
 * it reads exactly as ControlRoom writes them (`event_type_name` in its `events_json.cpp`) and
 * changes the model as ControlRoom's `apply()` changes its state (`events_apply.cpp`).
 */

export interface ReplayContext {
  model: CroomModel;
  report: ReportCollector;
  /** The event type, for the report. */
  type: string;
  /** When the event was written: ms since 1970, from the events table. */
  ts: number | null;
  /**
   * The next id from ControlRoom's one counter, which starts at 1 and moves on once for each
   * entry an event makes. Only an event that makes an entry draws one, and only where it makes
   * it: a stage element given to a plan the file does not have draws none.
   */
  nextId(): string;
  /** The frame rate set at this point of the file, which its timecodes are read against. */
  frameRate(): FrameRate;
}

export type Handler = (ctx: ReplayContext, f: Fields) => void;

export interface Family {
  name: string;
  /** The event types it reads, by the name ControlRoom writes, and how each changes the model. */
  events: Record<string, Handler>;
}

/** Said where an event names an entry the project does not hold: ControlRoom ignores it too. */
export function absent(ctx: ReplayContext, what: string) {
  ctx.report.problem(
    `${ctx.type}: names ${what} that is not in the project, so it changes nothing (as in ControlRoom)`,
  );
}

/** Removes the entry an event names by `name` from `map`, as ControlRoom's delete events do. */
export function removeFrom<V>(
  ctx: ReplayContext,
  f: Fields,
  map: Map<string, V>,
  what: string,
  name = "id",
): string | null {
  const id = f.id(name);
  if (!id || !map.delete(id)) {
    absent(ctx, what);
    return null;
  }
  return id;
}

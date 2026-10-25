import type { Fields } from "./fields.ts";
import type { CroomModel, ReportCollector } from "./model.ts";

/**
 * One family of ControlRoom events (sessions, takes, the stage …), mapped by a small module of
 * its own under `families/` so a wrong guess about one family's names is corrected there and
 * nowhere else (decision 242). Every event type and field name in those modules is provisional
 * until checked against a real file.
 */

export interface ReplayContext {
  model: CroomModel;
  report: ReportCollector;
  /** The event type as written, for the report. */
  type: string;
  /**
   * The id an added entry takes: its own where the payload names one (which moves the shared
   * counter past it), else the counter's next. Every `add_*` event draws from one counter.
   */
  newId(f: Fields): string;
  /** Moves the shared counter past an id an entry carries of its own (a stage element's). */
  bump(id: string): void;
}

export type Handler = (ctx: ReplayContext, f: Fields) => void;

export interface NounHandlers {
  add?: Handler;
  update?: Handler;
  remove?: Handler;
}

export interface Family {
  name: string;
  /** The nouns of `add_<noun>`, `update_<noun>` and `remove_<noun>` this family reads, aliases included. */
  nouns: Record<string, NounHandlers>;
  /** Whole event types read outright, written as the replay normalises them (`rate_take`). */
  exact?: Record<string, Handler>;
  /** Nouns whose every event is read and set aside, with why. */
  ignoredNouns?: Record<string, string>;
}

/** The id an update or removal names. */
export const targetId = (f: Fields, noun: string) => f.id("id", `${noun}_id`) ?? null;

/**
 * Add, update and remove for entries kept in one of the model's maps: `read` builds an entry
 * from the payload over a base (the defaults, or the entry as it stands), so an update changes
 * only what its payload says.
 */
export function crud<E>(
  noun: string,
  mapOf: (model: CroomModel) => Map<string, E>,
  defaults: (id: string) => E,
  read: (f: Fields, base: E, ctx: ReplayContext) => E,
  onRemove?: (ctx: ReplayContext, id: string) => void,
): NounHandlers {
  return {
    add(ctx, f) {
      const id = ctx.newId(f);
      mapOf(ctx.model).set(id, read(f, defaults(id), ctx));
    },
    update(ctx, f) {
      const id = targetId(f, noun);
      const held = id ? mapOf(ctx.model).get(id) : undefined;
      if (!id || held === undefined) {
        ctx.report.problem(`${ctx.type}: changes a ${noun} the file never added, so it was skipped`);
        f.skipAll();
        return;
      }
      mapOf(ctx.model).set(id, read(f, held, ctx));
    },
    remove(ctx, f) {
      const id = targetId(f, noun);
      // A removal says what it removes; whatever else it carries changes nothing.
      f.skipAll();
      if (!id || !mapOf(ctx.model).delete(id)) {
        ctx.report.problem(`${ctx.type}: removes a ${noun} the file never added`);
        return;
      }
      onRemove?.(ctx, id);
    },
  };
}

/** The same handlers under several names: `piece` and `work`. */
export function aliases(names: string[], handlers: NounHandlers): Record<string, NounHandlers> {
  return Object.fromEntries(names.map((n) => [n, handlers]));
}

/** Text, with a fallback where the payload says nothing. */
export const or = <T>(value: T | undefined, fallback: T): T =>
  value === undefined ? fallback : value;

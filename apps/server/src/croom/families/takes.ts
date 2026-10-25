import { aliases, crud, type Family, type Handler, or, targetId } from "../family.ts";
import type { Fields } from "../fields.ts";
import type { CrTake } from "../model.ts";
import { placeOf } from "./place.ts";
import { instantOf, within } from "./values.ts";

/**
 * Takes (provisional, decision 242): `add_take` with `piece_id` or `movement_id`, `session_id`,
 * `number`, `rating` (1 to 5), `starred`, `notes`, `false_starts`, `timecode_in`, `timecode_out`,
 * `started_at`, `ended_at`, `page`, `page_to`, `bar_from`, `bar_to` and `status`; changed by
 * `update_take`, or by the live log's own events: `rate_take`, `star_take`, `note_take`,
 * `abort_take` and `add_false_start`.
 */
function readTake(f: Fields, base: CrTake, ctx: Parameters<Handler>[0]): CrTake {
  const place = placeOf(f, ctx, base);
  const status = f.str("status", "state", "lifecycle");
  const rating = f.int("rating", "stars", "rate");
  return {
    ...base,
    ...place,
    sessionId: or(f.id("session_id", "session"), base.sessionId),
    number: or(f.intOrNull("number", "take_number", "take", "num"), base.number),
    rating: rating === undefined ? base.rating : (within(rating, 0, 5) ?? 0),
    starred: or(f.bool("starred", "circled", "favourite", "favorite", "keep"), base.starred),
    notes: or(f.str("notes", "note", "comment"), base.notes),
    falseStarts: or(
      f.int("false_starts", "falsestarts", "false_start_count", "fs"),
      base.falseStarts,
    ),
    timecodeIn: or(f.strOrNull("timecode_in", "tc_in", "start_tc", "tc_start"), base.timecodeIn),
    timecodeOut: or(f.strOrNull("timecode_out", "tc_out", "end_tc", "tc_end"), base.timecodeOut),
    wallIn: or(instantOrKeep(f.str("started_at", "wall_in", "start_time", "start")), base.wallIn),
    wallOut: or(instantOrKeep(f.str("ended_at", "wall_out", "end_time", "end")), base.wallOut),
    page: or(f.intOrNull("page", "start_page", "page_from"), base.page),
    pageTo: or(f.intOrNull("page_to", "end_page"), base.pageTo),
    barFrom: or(f.intOrNull("bar_from", "start_bar", "bar_start", "bar"), base.barFrom),
    barTo: or(f.intOrNull("bar_to", "end_bar", "bar_end"), base.barTo),
    aborted: status === undefined ? base.aborted : /abort|discard|cancel/i.test(status),
  };
}

const instantOrKeep = (value: string | undefined) =>
  value === undefined ? undefined : instantOf(value);

const blank = (id: string): CrTake => ({
  id,
  workId: null,
  movementId: null,
  sessionId: null,
  number: null,
  rating: 0,
  starred: false,
  notes: "",
  falseStarts: 0,
  timecodeIn: null,
  timecodeOut: null,
  wallIn: null,
  wallOut: null,
  page: null,
  pageTo: null,
  barFrom: null,
  barTo: null,
  aborted: false,
});

const take = crud<CrTake>("take", (m) => m.takes, blank, readTake);

/** A live-log event on one take: the take it names, changed as `change` says. */
const onTake =
  (change: (t: CrTake, f: Fields) => void): Handler =>
  (ctx, f) => {
    const id = targetId(f, "take");
    const held = id ? ctx.model.takes.get(id) : undefined;
    if (!held) {
      ctx.report.problem(`${ctx.type}: names a take the file never added`);
      f.skipAll();
      return;
    }
    change(held, f);
  };

const falseStart = onTake((t, f) => {
  const count = f.int("count", "false_starts");
  t.falseStarts = count === undefined ? t.falseStarts + 1 : Math.max(0, count);
});

export const takes: Family = {
  name: "takes",
  nouns: {
    ...aliases(["take"], take),
    false_start: { add: falseStart },
  },
  exact: {
    rate_take: onTake((t, f) => {
      t.rating = within(f.int("rating", "stars", "value"), 0, 5) ?? 0;
    }),
    set_take_rating: onTake((t, f) => {
      t.rating = within(f.int("rating", "stars", "value"), 0, 5) ?? 0;
    }),
    star_take: onTake((t, f) => {
      t.starred = f.bool("starred", "value") ?? true;
    }),
    circle_take: onTake((t, f) => {
      t.starred = f.bool("circled", "starred", "value") ?? true;
    }),
    note_take: onTake((t, f) => {
      t.notes = f.str("notes", "note", "text", "value") ?? t.notes;
    }),
    set_take_notes: onTake((t, f) => {
      t.notes = f.str("notes", "note", "text", "value") ?? t.notes;
    }),
    abort_take: onTake((t) => {
      t.aborted = true;
    }),
    false_start: falseStart,
    add_false_start: falseStart,
  },
};

import { aliases, crud, type Family, or } from "../family.ts";
import type { CrDay, CrRow } from "../model.ts";
import { clockOf, dateOf, keyOf, within } from "./values.ts";

/**
 * The schedule (provisional, decision 242). `add_schedule_day` has `label`, `date`, `venue_id`
 * and `start`; `add_schedule_entry` has `day_id` (or a `date`, which finds or makes its day),
 * `kind`, `start`, `minutes` (or `duration`), `label`, `all_repertoire`, `piece_ids`,
 * `movement_ids`, `personnel` (text, or a list of people), `notes` and `done`.
 */
const rowKinds: Record<string, CrRow["kind"]> = {
  slot: "slot",
  session: "slot",
  recording: "slot",
  repertoire: "slot",
  rehearsal: "slot",
  break: "break",
  lunch: "break",
  tea: "break",
  dinner: "break",
  pause: "break",
  "get-in": "get-in",
  getin: "get-in",
  setup: "get-in",
  "set-up": "get-in",
  rig: "get-in",
  venue: "venue",
  "venue-change": "venue",
  move: "venue",
  travel: "venue",
  custom: "custom",
  other: "custom",
};

const day = crud<CrDay>(
  "schedule_day",
  (m) => m.days,
  (id) => ({ id, label: "", date: null, venueId: null, start: null }),
  (f, base, ctx) => {
    const date = f.strOrNull("date", "day");
    const start = f.strOrNull("start", "start_time", "starts");
    return {
      ...base,
      label: or(f.str("label", "name", "title"), base.label),
      date: date === undefined ? base.date : dateOf(date, ctx),
      venueId: or(f.id("venue_id", "venue"), base.venueId),
      start: start === undefined ? base.start : clockOf(start, ctx),
    };
  },
);

const entry = crud<CrRow>(
  "schedule_entry",
  (m) => m.rows,
  (id) => ({
    id,
    dayId: null,
    date: null,
    kind: "custom",
    start: null,
    minutes: 0,
    label: "",
    allRepertoire: false,
    workIds: [],
    movementIds: [],
    personnel: "",
    notes: "",
    done: false,
  }),
  (f, base, ctx) => {
    const kindWritten = f.str("kind", "type", "category");
    let kind = base.kind;
    if (kindWritten !== undefined) {
      const found = rowKinds[keyOf(kindWritten)];
      if (!found)
        ctx.report.problem(
          `${ctx.type}: a "${kindWritten.slice(0, 30)}" row is not a kind Hekate has, so it is an other row`,
        );
      kind = found ?? "custom";
    }
    const date = f.strOrNull("date", "day_date");
    const start = f.strOrNull("start", "start_time", "time", "starts");
    const minutes = f.num("minutes", "duration_minutes", "duration", "length");
    // People named on a row: written out, or a list of names or ids on the personnel.
    const who = f.raw("personnel", "people", "who");
    const personnel =
      who === undefined || who === null
        ? undefined
        : Array.isArray(who)
          ? who
              .map((p) =>
                typeof p === "string" || typeof p === "number"
                  ? (ctx.model.personnel.get(String(p))?.name ?? String(p))
                  : "",
              )
              .filter(Boolean)
              .join(", ")
          : String(who);
    const pieces = f.ids("piece_ids", "pieces", "works", "work_ids");
    const movements = f.ids("movement_ids", "movements", "tracks");
    return {
      ...base,
      kind: kind === "custom" && (pieces?.length || movements?.length) ? "slot" : kind,
      dayId: or(f.id("day_id", "schedule_day_id", "day"), base.dayId),
      date: date === undefined ? base.date : dateOf(date, ctx),
      start: start === undefined ? base.start : clockOf(start, ctx),
      minutes: minutes === undefined ? base.minutes : (within(Math.round(minutes), 0, 1440) ?? 0),
      label: or(f.str("label", "title", "name", "text"), base.label),
      allRepertoire: or(f.bool("all_repertoire", "tutti", "everything"), base.allRepertoire),
      workIds: or(pieces, base.workIds),
      movementIds: or(movements, base.movementIds),
      personnel: or(personnel, base.personnel),
      notes: or(f.str("notes", "note"), base.notes),
      done: or(f.bool("done", "completed", "ticked", "checked"), base.done),
    };
  },
);

export const schedule: Family = {
  name: "schedule",
  nouns: {
    ...aliases(["schedule_day", "day"], day),
    ...aliases(
      ["schedule_entry", "schedule_row", "schedule_item", "schedule_slot", "schedule", "slot"],
      entry,
    ),
  },
};

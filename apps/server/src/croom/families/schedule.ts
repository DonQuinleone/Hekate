import { absent, type Family, type ReplayContext } from "../family.ts";
import { idOf, wholeOf } from "../fields.ts";
import { type CrScheduleItem, type CrScheduleKind, scheduleKinds } from "../model.ts";

/**
 * The schedule (decision 242): one ordered list, in which a day row starts each day.
 * `add_schedule_item` has `kind` (day, slot, break or venue; any other word ControlRoom reads as
 * a slot) and `index`, where it goes (-1 or past the end appends). `update_schedule_item` then
 * writes the whole row but its kind: `id`, `start` ("HH:MM", or empty to follow the row before),
 * `dur` (minutes), `done`, `title`, `notes`, `personnel` (text), `refs` (a slot's works and
 * movements as [piece, movement] pairs, movement 0 for the whole work and the largest id there
 * is for the whole repertoire), and for a day `label`, `date` ("YYYY-MM-DD") and `venue_id`
 * (also a venue row's venue). Older files write a single `piece` and `movement` instead of
 * `refs`, and `composer`, `arranger`, `forces`, `venue` and `pdf` on the row itself.
 * `delete_schedule_item` and `move_schedule_item` (`id`, `to`) remove and move a row.
 */

/** ControlRoom's id for the whole repertoire: the largest unsigned 64-bit number. */
const isAll = (value: unknown) => typeof value === "number" && value > Number.MAX_SAFE_INTEGER;

/** A piece a slot names: an id, the whole repertoire, or null for none. */
function pieceOf(value: unknown, ctx: ReplayContext): string | "all" | null {
  if (isAll(value)) return "all";
  const id = idOf(value);
  if (id === undefined) {
    ctx.report.problem(`${ctx.type}: a slot names a work that is not an id, so it was left off`);
    return null;
  }
  return id;
}

const kindOf = (value: string): CrScheduleKind =>
  (scheduleKinds as readonly string[]).includes(value) ? (value as CrScheduleKind) : "slot";

export const schedule: Family = {
  name: "schedule",
  events: {
    add_schedule_item(ctx, f) {
      const id = ctx.nextId();
      const kind = kindOf(f.str("kind", "slot"));
      const index = f.int("index", -1);
      const item: CrScheduleItem = {
        id,
        kind,
        start: "",
        minutes: 0,
        done: false,
        title: "",
        notes: "",
        personnel: "",
        refs: [],
        label: "",
        date: "",
        venueId: null,
        legacy: { composer: "", arranger: "", forces: "", venue: "", pdfId: null },
      };
      const list = ctx.model.schedule;
      list.splice(index < 0 || index > list.length ? list.length : index, 0, item);
    },
    update_schedule_item(ctx, f) {
      const id = f.id("id");
      f.skip("kind");
      const refs: CrScheduleItem["refs"] = [];
      for (const r of f.list("refs") ?? []) {
        if (!Array.isArray(r) || r.length < 2) continue;
        const piece = pieceOf(r[0], ctx);
        const movement = wholeOf(r[1]);
        if (piece && movement !== undefined) refs.push({ piece, movement });
      }
      // Files from before a slot could hold several works name one.
      const single = f.raw("piece");
      const movement = f.int("movement", 0);
      if (refs.length === 0 && single !== null && single !== undefined && single !== 0) {
        const piece = pieceOf(single, ctx);
        if (piece) refs.push({ piece, movement });
      }
      const next = {
        start: f.str("start"),
        minutes: f.int("dur", 0),
        done: f.bool("done", false),
        title: f.str("title"),
        notes: f.str("notes"),
        personnel: f.str("personnel"),
        refs,
        label: f.str("label"),
        date: f.str("date"),
        venueId: f.id("venue_id"),
        legacy: {
          composer: f.str("composer"),
          arranger: f.str("arranger"),
          forces: f.str("forces"),
          venue: f.str("venue"),
          pdfId: f.id("pdf"),
        },
      };
      const held = ctx.model.schedule.find((item) => item.id === id);
      if (!held) return absent(ctx, "a schedule row");
      Object.assign(held, next);
    },
    delete_schedule_item(ctx, f) {
      const id = f.id("id");
      const at = ctx.model.schedule.findIndex((item) => item.id === id);
      if (at < 0) return absent(ctx, "a schedule row");
      ctx.model.schedule.splice(at, 1);
    },
    move_schedule_item(ctx, f) {
      const id = f.id("id");
      const to = f.int("to", 0);
      const list = ctx.model.schedule;
      const at = list.findIndex((item) => item.id === id);
      if (at < 0) return absent(ctx, "a schedule row");
      const [item] = list.splice(at, 1) as [CrScheduleItem];
      list.splice(Math.min(Math.max(0, to), list.length), 0, item);
    },
  },
};

import type { Fields } from "../fields.ts";
import { absent, type Family, type ReplayContext, removeFrom } from "../family.ts";
import { type CrAnnotation, type CrAnnotationKind, annotationKinds } from "../model.ts";

/**
 * Marks on a score (decision 242). `add_annotation` has `kind` (issue, tedit, take_begin,
 * take_end, spot_x, circled_dynamic, punch_in, note or ink; any other word ControlRoom reads as
 * an issue), `loc` (`pdf`, the 0-based `page`, `geom` "point" or "rect", and `x`, `y`, `w`, `h`
 * as fractions of the page), `category`, `note`, `takes_affected`, `take_resolved` (a number or
 * null), `tedit` (`takes` in order, so [3, 4] is 3T4; `overdub`; `lead`, a lead-in with no
 * take before it) and, for ink, `ink`: the stroke's points as offsets from the corner in `loc`.
 * A mark is placed on its score, never on a piece: the import finds its track by page.
 *
 * It is changed by `set_annotation_status` (`id`, `status`: open or resolved),
 * `set_annotation_note` (`id`, `note`), `set_annotation_takes` (`id`, `affected`, `resolved`)
 * and `move_annotation` (`id`, `page`, `x`, `y`), and removed by `delete_annotation` (`id`).
 */
function pairsOf(values: unknown[] | undefined, ctx: ReplayContext): [number, number][] {
  const points: [number, number][] = [];
  for (const v of values ?? []) {
    if (Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "number")
      points.push([v[0], v[1]]);
    else ctx.report.problem(`${ctx.type}: ink holds a point that is not two numbers, so it was left out`);
  }
  return points;
}

/** The mark an event names by `id`, changed as `change` says, at the event's time. */
const onMark =
  (change: (mark: CrAnnotation, f: Fields, ctx: ReplayContext) => void) =>
  (ctx: ReplayContext, f: Fields) => {
    const held = ctx.model.annotations.get(f.id("id") ?? "");
    if (!held) {
      change(blank("0", null), f, ctx);
      return absent(ctx, "a mark");
    }
    change(held, f, ctx);
    held.updatedAt = ctx.ts;
  };

const blank = (id: string, ts: number | null): CrAnnotation => ({
  id,
  kind: "issue",
  pdfId: null,
  page: 0,
  rect: false,
  x: 0,
  y: 0,
  w: 0,
  h: 0,
  categoryId: null,
  note: "",
  resolved: false,
  takesAffected: [],
  takeResolved: null,
  tedit: { takes: [], overdub: false, lead: false },
  ink: [],
  createdAt: ts,
  updatedAt: ts,
  resolvedAt: null,
});

export const scoreMarks: Family = {
  name: "score marks",
  events: {
    add_annotation(ctx, f) {
      const id = ctx.nextId();
      const mark = blank(id, ctx.ts);
      const kind = f.str("kind", "issue");
      if ((annotationKinds as readonly string[]).includes(kind))
        mark.kind = kind as CrAnnotationKind;
      else
        ctx.report.problem(
          `${ctx.type}: "${kind.slice(0, 30)}" is not a kind of mark ControlRoom knows, so it is an issue (as in ControlRoom)`,
        );
      const loc = f.object("loc");
      if (loc) {
        mark.pdfId = loc.id("pdf");
        mark.page = loc.int("page", 0);
        mark.rect = loc.str("geom", "point") === "rect";
        mark.x = loc.num("x", 0);
        mark.y = loc.num("y", 0);
        mark.w = loc.num("w", 0);
        mark.h = loc.num("h", 0);
      }
      mark.categoryId = f.id("category");
      mark.note = f.str("note");
      mark.takesAffected = f.ints("takes_affected");
      mark.takeResolved = f.intOrNull("take_resolved");
      const tedit = f.object("tedit");
      if (tedit)
        mark.tedit = {
          takes: tedit.ints("takes"),
          overdub: tedit.bool("overdub", false),
          lead: tedit.bool("lead", false),
        };
      mark.ink = pairsOf(f.list("ink"), ctx);
      ctx.model.annotations.set(id, mark);
    },
    set_annotation_status: onMark((m, f, ctx) => {
      m.resolved = f.str("status", "open") === "resolved";
      m.resolvedAt = m.resolved ? ctx.ts : null;
    }),
    set_annotation_note: onMark((m, f) => {
      m.note = f.str("note");
    }),
    set_annotation_takes: onMark((m, f) => {
      m.takesAffected = f.ints("affected");
      m.takeResolved = f.intOrNull("resolved");
    }),
    move_annotation: onMark((m, f) => {
      m.page = f.int("page", 0);
      m.x = f.num("x", 0);
      m.y = f.num("y", 0);
    }),
    delete_annotation(ctx, f) {
      removeFrom(ctx, f, ctx.model.annotations, "a mark");
    },
  },
};

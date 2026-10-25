import type { ScoreMarkKind } from "@hekate/shared";
import type { Fields } from "../fields.ts";
import {
  aliases,
  crud,
  type Family,
  type Handler,
  or,
  type ReplayContext,
  targetId,
} from "../family.ts";
import type { CrMark } from "../model.ts";
import { placeOf } from "./place.ts";
import { keyOf, within } from "./values.ts";

/**
 * Score annotations and their take edits (provisional, decision 242). `add_annotation` has
 * `piece_id` or `movement_id`, `kind`, `page`, `x`, `y`, `width`, `height`, `points`, `bar_from`,
 * `bar_to`, `text`, `category_id`, `takes` (those an issue occurred in), `fixed_by`, `resolved`,
 * and for an edit point `from`, `to` and `overdub`, or a `take_edit` set of those. A separate
 * `add_take_edit` with `annotation_id` makes that annotation an edit point. Positions are read as
 * fractions of the page (0 to 1), or as points where the page's `page_width` and `page_height`
 * are given.
 */

/** ControlRoom's kinds of annotation, as far as they can be guessed, in Hekate's words. */
const kinds: Record<string, ScoreMarkKind> = {
  issue: "issue",
  problem: "issue",
  error: "issue",
  region: "issue",
  edit: "edit",
  "t-edit": "edit",
  tedit: "edit",
  "take-edit": "edit",
  "edit-point": "edit",
  splice: "edit",
  "take-start": "take-start",
  start: "take-start",
  "take-in": "take-start",
  "take-end": "take-end",
  end: "take-end",
  "take-out": "take-end",
  "punch-in": "punch-in",
  punch: "punch-in",
  "drop-in": "punch-in",
  "wrong-note": "wrong-note",
  cross: "wrong-note",
  x: "wrong-note",
  dynamic: "dynamic",
  circle: "dynamic",
  "circled-dynamic": "dynamic",
  note: "note",
  sticky: "note",
  "sticky-note": "note",
  text: "note",
  comment: "note",
  ink: "ink",
  freehand: "ink",
  pen: "ink",
  pencil: "ink",
  drawing: "ink",
  stroke: "ink",
};

/** An edit as Hekate writes it: "T7" (a lead-in), "3T12 into T7", "T9 over 3T7". */
export function editNotation(
  written: string,
): { from: number | null; to: number; bar: number | null; overdub: boolean } | null {
  const text = written.trim().replace(/\s+/g, " ");
  const lead = /^T(\d+)$/i.exec(text);
  if (lead) return { from: null, to: Number(lead[1]), bar: null, overdub: false };
  const into = /^(\d+)?T(\d+) (?:into|>|->) T?(\d+)$/i.exec(text);
  if (into)
    return {
      from: Number(into[2]),
      to: Number(into[3]),
      bar: into[1] ? Number(into[1]) : null,
      overdub: false,
    };
  const over = /^T(\d+) over (\d+)?T(\d+)$/i.exec(text);
  if (over)
    return {
      from: Number(over[3]),
      to: Number(over[1]),
      bar: over[2] ? Number(over[2]) : null,
      overdub: true,
    };
  return null;
}

/** An edit point's fields, from a payload or a nested take edit. */
function readEdit(f: Fields, mark: CrMark, ctx: ReplayContext): CrMark {
  const next = { ...mark };
  const notation = f.str("notation", "t_notation", "label_text");
  if (notation !== undefined) {
    const read = editNotation(notation);
    if (read) {
      next.from = read.from;
      next.to = read.to;
      next.overdub = read.overdub;
      if (read.bar !== null) next.barFrom = read.bar;
    } else ctx.report.problem(`${ctx.type}: the edit "${notation.slice(0, 20)}" was not understood`);
  }
  next.from = or(f.intOrNull("from", "from_take", "take_from", "out_of"), next.from);
  next.to = or(f.intOrNull("to", "to_take", "take_to", "into"), next.to);
  next.overdub = or(f.bool("overdub", "over"), next.overdub);
  const bar = f.intOrNull("bar", "at_bar");
  if (bar !== undefined) next.barFrom = bar;
  return next;
}

function pointsOf(values: unknown[] | undefined, scale: { w: number; h: number }) {
  if (!values) return undefined;
  const points: [number, number][] = [];
  for (const v of values) {
    const pair = Array.isArray(v)
      ? [Number(v[0]), Number(v[1])]
      : typeof v === "object" && v !== null
        ? [Number((v as { x?: unknown }).x), Number((v as { y?: unknown }).y)]
        : null;
    if (!pair || !Number.isFinite(pair[0]) || !Number.isFinite(pair[1])) continue;
    points.push([
      within((pair[0] as number) / scale.w, 0, 1) ?? 0,
      within((pair[1] as number) / scale.h, 0, 1) ?? 0,
    ]);
  }
  return points;
}

function readMark(f: Fields, base: CrMark, ctx: ReplayContext): CrMark {
  const place = placeOf(f, ctx, base);
  const kindWritten = f.str("kind", "type", "tool", "mark_type");
  let kind = base.kind;
  if (kindWritten !== undefined) {
    kind = kinds[keyOf(kindWritten)] ?? null;
    if (!kind)
      ctx.report.problem(
        `${ctx.type}: a "${kindWritten.slice(0, 30)}" annotation has no kind in Hekate, so it was left out`,
      );
  }
  const scale = { w: f.num("page_width") ?? 1, h: f.num("page_height") ?? 1 };
  const coordinate = (value: number | null | undefined, by: number, name: string) => {
    if (value == null) return value;
    const n = value / by;
    if (n < 0 || n > 1) {
      ctx.report.problem(`${ctx.type}: ${name} lies off the page, so it was moved to its edge`);
      return within(n, 0, 1);
    }
    return n;
  };
  let mark: CrMark = {
    ...base,
    ...place,
    kind,
    page: or(f.intOrNull("page", "page_number", "pdf_page"), base.page),
    x: coordinate(f.num("x", "left"), scale.w, "x") ?? base.x,
    y: coordinate(f.num("y", "top"), scale.h, "y") ?? base.y,
    width: or(coordinate(f.num("width", "w"), scale.w, "width"), base.width),
    height: or(coordinate(f.num("height", "h"), scale.h, "height"), base.height),
    points: or(pointsOf(f.list("points", "path", "stroke"), scale), base.points),
    barFrom: or(f.intOrNull("bar_from", "start_bar", "bar_start"), base.barFrom),
    barTo: or(f.intOrNull("bar_to", "end_bar", "bar_end"), base.barTo),
    text: or(f.strOrNull("text", "label", "note", "comment", "description"), base.text),
    categoryId: or(f.id("category_id", "category"), base.categoryId),
    takes: or(f.ints("takes", "take_numbers", "occurred_in", "in_takes"), base.takes),
    fixedBy: or(f.intOrNull("fixed_by", "fixed_in", "fix_take", "fixed_take"), base.fixedBy),
    resolved: or(f.bool("resolved", "done", "fixed"), base.resolved),
  };
  mark = readEdit(f, mark, ctx);
  const nested = f.object("take_edit", "t_edit", "edit");
  if (nested) {
    mark = readEdit(nested, mark, ctx);
    if (kindWritten === undefined) mark.kind = "edit";
  }
  return mark;
}

const blank = (id: string): CrMark => ({
  id,
  workId: null,
  movementId: null,
  kind: "issue",
  page: null,
  x: 0,
  y: 0,
  width: null,
  height: null,
  points: null,
  barFrom: null,
  barTo: null,
  text: null,
  categoryId: null,
  takes: [],
  fixedBy: null,
  from: null,
  to: null,
  overdub: false,
  resolved: false,
});

const annotation = crud<CrMark>("annotation", (m) => m.marks, blank, readMark);

/** A take edit on an annotation: that annotation becomes an edit point, its hand-over as given. */
const takeEdit: Handler = (ctx, f) => {
  const annotationId = f.id("annotation_id", "mark_id", "annotation");
  const held = annotationId ? ctx.model.marks.get(annotationId) : undefined;
  if (annotationId && !held) {
    ctx.report.problem(`${ctx.type}: names an annotation the file never added`);
    f.skipAll();
    return;
  }
  if (held) {
    ctx.model.marks.set(held.id, { ...readEdit(f, held, ctx), kind: "edit" });
    f.skip("id");
    return;
  }
  // A take edit of its own, placed where it says.
  const id = ctx.newId(f);
  const mark = readMark(f, { ...blank(id), kind: "edit" }, ctx);
  ctx.model.marks.set(id, { ...mark, kind: "edit" });
};

const removeTakeEdit: Handler = (ctx, f) => {
  const id = f.id("annotation_id", "mark_id") ?? targetId(f, "take_edit");
  f.skipAll();
  const held = id ? ctx.model.marks.get(id) : undefined;
  if (!held) {
    ctx.report.problem(`${ctx.type}: removes a take edit the file never added`);
    return;
  }
  // The edit goes; the annotation it was on stays, as the issue or note it was.
  if (held.kind === "edit" && held.text) ctx.model.marks.set(held.id, { ...held, kind: "note" });
  else ctx.model.marks.delete(held.id);
};

export const scoreMarks: Family = {
  name: "score marks",
  nouns: {
    ...aliases(["annotation", "score_annotation", "mark", "score_mark", "marking"], annotation),
    ...aliases(["take_edit", "t_edit", "edit_point"], {
      add: takeEdit,
      update: takeEdit,
      remove: removeTakeEdit,
    }),
  },
};

import { type Fields, fieldsOf, isRecord } from "../fields.ts";
import { absent, type Family, type ReplayContext, removeFrom } from "../family.ts";
import type { CrElement, CrPatchRow, CrStagePlan } from "../model.ts";

/**
 * Stage boxes, stage plans and what stands on them (decision 242).
 *
 * - `add_stagebox` carries nothing: a box named by the next letter ("A", "B" …) with 32 empty
 *   inputs and 8 empty outputs. `update_stagebox` writes it whole: `id`, `name`, and `ins` and
 *   `outs`, each row `[source, device, cable, notes]`, channel n being row n.
 *   `delete_stagebox` removes one by `id`.
 * - `add_stage_plan` carries nothing: "Stage Plan n", 20 by 12 metres. `update_stage_plan`
 *   writes everything but its elements: `id`, `name`, `w` and `d` (metres), `paper`,
 *   `venue_id`, the floor-plan underlay (`blob`, `blob_name`, its offset `ulx` and `uly` in
 *   metres, `uls` in metres a pixel, `ulo` its opacity) and `lmask`, the label groups drawn.
 *   `delete_stage_plan` removes one by `id`.
 * - `upsert_stage_element` (`plan`, `el`) and `upsert_stage_elements` (`plan`, `els`, one undo
 *   step for a group) put elements on a plan: one with `id` 0 is new and draws its id from the
 *   counter, one with an id replaces that element (or is added under it). An element has `k`
 *   (its kind, an open word: mic, person, block, piano, timp, cable, wall, label, stagebox …),
 *   `x`, `y` (its centre, metres from the stage's top-left, y towards the audience), `w`, `h`,
 *   `r` (degrees clockwise), `lb` (its label), `c` (colour, 0 for automatic), `per`, `sec` and
 *   `mem` (a person, and a section and member of an ensemble), `box` and `ch` (the stage box
 *   and input it is plugged into) and `pts` (a cable's or wall's corners). An element for a plan
 *   the file does not have is dropped before it draws an id. `delete_stage_element` (`plan`,
 *   `el`) and `delete_stage_elements` (`plan`, `els`) remove them.
 */
function rowsOf(values: unknown[] | undefined, ctx: ReplayContext): CrPatchRow[] {
  return (values ?? []).map((r) => {
    const cells = Array.isArray(r) ? r : [];
    const cell = (i: number) => {
      const v = cells[i];
      if (v === undefined) return "";
      if (typeof v === "string") return v;
      ctx.report.problem(`${ctx.type}: a patch row holds a cell that is not text, so it was left out`);
      return "";
    };
    return { source: cell(0), device: cell(1), cable: cell(2), notes: cell(3) };
  });
}

function elementOf(f: Fields, ctx: ReplayContext): CrElement {
  const points: [number, number][] = [];
  for (const p of f.list("pts") ?? [])
    if (Array.isArray(p) && p.length >= 2 && typeof p[0] === "number" && typeof p[1] === "number")
      points.push([p[0], p[1]]);
    else ctx.report.problem(`${ctx.type}: a cable or wall holds a corner that is not two numbers`);
  return {
    id: f.id("id") ?? "0",
    kind: f.str("k"),
    x: f.num("x", 0),
    y: f.num("y", 0),
    w: f.num("w", 1),
    h: f.num("h", 1),
    rot: f.num("r", 0),
    label: f.str("lb"),
    colour: f.num("c", 0),
    personId: f.id("per"),
    section: f.int("sec", -1),
    member: f.int("mem", -1),
    boxId: f.id("box"),
    channel: f.int("ch", 0),
    points,
  };
}

/** Elements put on a plan, as ControlRoom's upsert puts them. */
function upsert(ctx: ReplayContext, planId: string | null, elements: CrElement[]) {
  const plan = planId ? ctx.model.stagePlans.get(planId) : undefined;
  if (!plan) return absent(ctx, "a stage plan");
  for (const element of elements) {
    if (element.id === "0") {
      plan.elements.push({ ...element, id: ctx.nextId() });
      continue;
    }
    const at = plan.elements.findIndex((e) => e.id === element.id);
    if (at >= 0) plan.elements[at] = element;
    else plan.elements.push(element);
  }
}

function removeElements(ctx: ReplayContext, planId: string | null, ids: string[]) {
  const plan = planId ? ctx.model.stagePlans.get(planId) : undefined;
  if (!plan) return absent(ctx, "a stage plan");
  plan.elements = plan.elements.filter((e) => !ids.includes(e.id));
}

export const stage: Family = {
  name: "stage",
  events: {
    add_stagebox(ctx) {
      const id = ctx.nextId();
      const empty = (n: number) =>
        Array.from({ length: n }, () => ({ source: "", device: "", cable: "", notes: "" }));
      ctx.model.stageBoxes.set(id, {
        id,
        name: String.fromCharCode(65 + (ctx.model.stageBoxes.size % 26)),
        inputs: empty(32),
        outputs: empty(8),
      });
    },
    update_stagebox(ctx, f) {
      const id = f.id("id");
      const name = f.str("name");
      const ins = f.list("ins");
      const outs = f.list("outs");
      const held = id ? ctx.model.stageBoxes.get(id) : undefined;
      if (!held) return absent(ctx, "a stage box");
      // The whole box is written: rows it leaves out are gone.
      held.name = name;
      held.inputs = rowsOf(ins, ctx);
      held.outputs = rowsOf(outs, ctx);
    },
    delete_stagebox(ctx, f) {
      removeFrom(ctx, f, ctx.model.stageBoxes, "a stage box");
    },
    add_stage_plan(ctx) {
      const id = ctx.nextId();
      ctx.model.stagePlans.set(id, {
        id,
        name: `Stage Plan ${ctx.model.stagePlans.size + 1}`,
        width: 20,
        depth: 12,
        paper: "A4",
        venueId: null,
        underlayBlobId: null,
        underlayName: "",
        underlayX: 0,
        underlayY: 0,
        underlayScale: 0.01,
        underlayOpacity: 0.35,
        labelMask: 0xffffffff,
        elements: [],
      });
    },
    update_stage_plan(ctx, f) {
      const id = f.id("id");
      const next: Omit<CrStagePlan, "id" | "elements"> = {
        name: f.str("name"),
        width: f.num("w", 20),
        depth: f.num("d", 12),
        paper: f.str("paper", "A4"),
        venueId: f.id("venue_id"),
        underlayBlobId: f.id("blob"),
        underlayName: f.str("blob_name"),
        underlayX: f.num("ulx", 0),
        underlayY: f.num("uly", 0),
        underlayScale: f.num("uls", 0.01),
        underlayOpacity: f.num("ulo", 0.35),
        labelMask: f.num("lmask", 0xffffffff),
      };
      const held = id ? ctx.model.stagePlans.get(id) : undefined;
      if (!held) return absent(ctx, "a stage plan");
      Object.assign(held, next);
    },
    delete_stage_plan(ctx, f) {
      removeFrom(ctx, f, ctx.model.stagePlans, "a stage plan");
    },
    upsert_stage_element(ctx, f) {
      const plan = f.id("plan");
      const el = f.object("el");
      upsert(ctx, plan, [elementOf(el ?? fieldsOf({}, ctx.type, ctx.report), ctx)]);
    },
    upsert_stage_elements(ctx, f) {
      const plan = f.id("plan");
      const elements: CrElement[] = [];
      for (const value of f.list("els") ?? []) {
        const el = fieldsOf(isRecord(value) ? value : {}, `${ctx.type}.els`, ctx.report);
        elements.push(elementOf(el, ctx));
        el.done();
      }
      upsert(ctx, plan, elements);
    },
    delete_stage_element(ctx, f) {
      const plan = f.id("plan");
      const id = f.id("el");
      removeElements(ctx, plan, id ? [id] : []);
    },
    delete_stage_elements(ctx, f) {
      const plan = f.id("plan");
      const ids = (f.list("els") ?? []).map((v) => String(v));
      removeElements(ctx, plan, ids);
    },
  },
};

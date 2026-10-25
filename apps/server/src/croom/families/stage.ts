import { eachFields, type Fields } from "../fields.ts";
import {
  aliases,
  crud,
  type Family,
  type NounHandlers,
  or,
  type ReplayContext,
  targetId,
} from "../family.ts";
import type { CrPatch, CrStageBox, CrStageElement, CrStagePlan } from "../model.ts";
import { keyOf } from "./values.ts";

/**
 * Stage plans, their elements and the stage boxes (provisional, decision 242).
 *
 * - `add_stage_plan`: `name`, `width`, `depth`, `grid`, `venue_id`, and its `elements` inline.
 * - `add_stage_element`: its own `id` (which moves the shared id counter past it), `plan_id`,
 *   `kind`, `label`, `x`, `y`, `width`, `height` (metres from the stage's back-left corner),
 *   `rotation`, `person_id`, and the patch channel it is plugged into: `box_id` and `channel`.
 * - `add_stage_box`: `name`, and `inputs` and `outputs`, each a list of channels with `channel`,
 *   `source`, `device`, `cable` and `notes`.
 */

/** ControlRoom's kinds of stage element in Hekate's words; others keep their own (the set is open). */
const kinds: Record<string, string> = {
  performer: "performer",
  player: "performer",
  person: "performer",
  musician: "performer",
  chair: "performer",
  ensemble: "ensemble",
  block: "ensemble",
  section: "ensemble",
  mic: "mic",
  microphone: "mic",
  piano: "piano",
  "grand-piano": "piano",
  timpani: "timpani",
  instrument: "instrument",
  riser: "riser",
  platform: "riser",
  "stage-box": "stage-box",
  stagebox: "stage-box",
  box: "stage-box",
  cable: "cable",
  "cable-run": "cable",
  wall: "wall",
  label: "label",
  text: "label",
  rect: "rect",
  rectangle: "rect",
  ellipse: "ellipse",
  circle: "ellipse",
};

function readElement(f: Fields, base: CrStageElement): CrStageElement {
  const kindWritten = f.str("kind", "type", "shape");
  return {
    ...base,
    planId: or(f.id("plan_id", "stage_plan_id", "stage_id", "plan"), base.planId),
    kind: kindWritten === undefined ? base.kind : (kinds[keyOf(kindWritten)] ?? keyOf(kindWritten)),
    label: or(f.str("label", "name", "text", "title"), base.label),
    x: or(f.num("x"), base.x),
    y: or(f.num("y"), base.y),
    w: or(f.num("width", "w"), base.w),
    h: or(f.num("height", "h", "depth"), base.h),
    rotation: or(f.num("rotation", "angle", "rot"), base.rotation),
    personId: or(f.id("person_id", "personnel_id", "person"), base.personId),
    boxId: or(f.id("box_id", "stage_box_id", "stagebox_id"), base.boxId),
    channel: or(f.intOrNull("channel", "input", "box_channel"), base.channel),
    group: or(f.str("group", "label_group", "layer"), base.group),
  };
}

const blankElement = (id: string, planId: string | null = null): CrStageElement => ({
  id,
  planId,
  kind: "rect",
  label: "",
  x: 0,
  y: 0,
  w: 0,
  h: 0,
  rotation: 0,
  personId: null,
  boxId: null,
  channel: null,
  group: "",
});

/** An element's id is its own: it never draws from the counter, but moves it on. */
function elementId(f: Fields, ctx: ReplayContext): string {
  const own = f.id("id", "element_id");
  if (own) {
    ctx.bump(own);
    return own;
  }
  return ctx.newId(f);
}

const element: NounHandlers = {
  ...crud<CrStageElement>("stage_element", (m) => m.stageElements, blankElement, readElement),
  add(ctx, f) {
    const id = elementId(f, ctx);
    ctx.model.stageElements.set(id, readElement(f, blankElement(id)));
  },
};

const plan = crud<CrStagePlan>(
  "stage_plan",
  (m) => m.stagePlans,
  (id) => ({ id, name: "", width: 12, depth: 8, grid: 0.5, venueId: null }),
  (f, base, ctx) => {
    const next: CrStagePlan = {
      ...base,
      name: or(f.str("name", "title", "label"), base.name),
      width: or(f.num("width", "w"), base.width),
      depth: or(f.num("depth", "height", "h", "d"), base.depth),
      grid: or(f.num("grid", "grid_size", "snap"), base.grid),
      venueId: or(f.id("venue_id", "venue"), base.venueId),
    };
    for (const e of eachFields(f.list("elements", "items"), `${ctx.type}.elements`, ctx.report)) {
      const id = elementId(e, ctx);
      ctx.model.stageElements.set(id, readElement(e, blankElement(id, base.id)));
      e.done();
    }
    return next;
  },
  (ctx, id) => {
    for (const [elementKey, e] of ctx.model.stageElements)
      if (e.planId === id) ctx.model.stageElements.delete(elementKey);
  },
);

function readChannels(listed: unknown[] | undefined, type: string, ctx: ReplayContext) {
  if (listed === undefined) return undefined;
  const channels: CrPatch[] = [];
  eachFields(listed, type, ctx.report).forEach((c, i) => {
    channels.push({
      channel: c.int("channel", "ch", "number", "index") ?? i + 1,
      source: c.str("source", "name", "label") ?? "",
      device: c.str("device", "mic", "model") ?? "",
      cable: c.str("cable", "line", "multicore") ?? "",
      notes: c.str("notes", "note") ?? "",
    });
    c.done();
  });
  return channels;
}

const box = crud<CrStageBox>(
  "stage_box",
  (m) => m.stageBoxes,
  (id) => ({ id, name: "", inputs: [], outputs: [] }),
  (f, base, ctx) => ({
    ...base,
    name: or(f.str("name", "label", "title"), base.name),
    inputs: or(
      readChannels(f.list("inputs", "ins", "input_channels"), `${ctx.type}.inputs`, ctx),
      base.inputs,
    ),
    outputs: or(
      readChannels(f.list("outputs", "outs", "output_channels"), `${ctx.type}.outputs`, ctx),
      base.outputs,
    ),
  }),
);

export const stage: Family = {
  name: "stage",
  nouns: {
    ...aliases(["stage_plan", "stage", "plan"], plan),
    ...aliases(["stage_element", "element", "stage_item", "stage_object"], element),
    ...aliases(["stage_box", "stagebox", "box"], box),
  },
  exact: {
    move_stage_element: (ctx, f) => {
      const id = targetId(f, "element");
      const held = id ? ctx.model.stageElements.get(id) : undefined;
      if (!held) {
        ctx.report.problem(`${ctx.type}: moves an element the file never added`);
        f.skipAll();
        return;
      }
      ctx.model.stageElements.set(held.id, readElement(f, held));
    },
  },
};

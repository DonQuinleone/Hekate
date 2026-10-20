import { z } from "zod";

/**
 * Stage plans (#53, docs/domain.md): a venue's stage drawn to scale in metres, with what stands
 * on it. Positions run from the back-left corner of the stage, x across and y towards the
 * audience. The set of kinds is open: these are the ones the toolbar offers, and a kind it does
 * not know is drawn as a plain box.
 */
export const stageKinds = [
  "performer",
  "ensemble",
  "mic",
  "piano",
  "timpani",
  "instrument",
  "riser",
  "stage-box",
  "cable",
  "wall",
  "label",
  "rect",
  "ellipse",
] as const;
export type StageKind = (typeof stageKinds)[number];

/** What each kind is called, and the size it is put down at, in metres. */
export const stageKindDefaults: Record<StageKind, { name: string; w: number; h: number }> = {
  performer: { name: "Performer", w: 0.6, h: 0.6 },
  ensemble: { name: "Ensemble", w: 3, h: 2 },
  mic: { name: "Microphone", w: 0.3, h: 0.3 },
  piano: { name: "Piano", w: 1.6, h: 2.7 },
  timpani: { name: "Timpani", w: 2.4, h: 1.2 },
  instrument: { name: "Instrument", w: 1, h: 1 },
  riser: { name: "Riser", w: 2, h: 2 },
  "stage-box": { name: "Stage box", w: 0.5, h: 0.3 },
  cable: { name: "Cable run", w: 2, h: 0 },
  wall: { name: "Wall", w: 4, h: 0.2 },
  label: { name: "Label", w: 1.6, h: 0.4 },
  rect: { name: "Box", w: 1, h: 1 },
  ellipse: { name: "Ellipse", w: 1, h: 1 },
};

/** Drawn as a circle on its centre point rather than a box from its corner. */
export const roundKinds: readonly string[] = ["performer", "mic", "ellipse", "timpani"];

/** The kinds a patch list channel can be linked to (#54): its label then follows the patch. */
export const patchableKinds: readonly string[] = ["mic", "stage-box", "cable"];

export const stagePlanInput = z.object({
  /** The venue, or the layout at it: "Endless Hall, recital layout". */
  name: z.string().trim().min(1, "Name the stage plan").max(80),
  width: z.number().min(1).max(200),
  depth: z.number().min(1).max(200),
  /** The snapping grid, in metres. */
  grid: z.number().min(0.05).max(5).default(0.5),
});
export type StagePlanInput = z.input<typeof stagePlanInput>;

/** Somewhere on or near the stage: mics stand in the hall, walls run past the stage's edge. */
const place = z.number().min(-100).max(300);

/**
 * A floor plan under the stage (#53): a page of one of the project's documents or pictures,
 * drawn from (x, y) in metres and `width` metres across, faded to `opacity`.
 */
export const underlayInput = z.object({
  fileId: z.uuid(),
  page: z.number().int().min(1).max(10_000).default(1),
  x: place.default(0),
  y: place.default(0),
  width: z.number().gt(0).max(500),
  opacity: z.number().min(0.05).max(1).default(0.5),
});
export type UnderlayInput = z.input<typeof underlayInput>;
export type Underlay = z.infer<typeof underlayInput>;

export const stagePlanChangeInput = stagePlanInput
  .partial()
  /** A floor plan to draw under the stage, or null to take it away. */
  .extend({ underlay: underlayInput.nullable().optional() })
  .refine((c) => Object.keys(c).length > 0, { message: "Nothing to change" });

const itemFields = {
  /** Lowercase words joined by hyphens: one of `stageKinds`, or any other kind. */
  kind: z.string().regex(/^[a-z][a-z-]{0,30}$/, "Not a kind of stage item"),
  label: z.string().trim().max(60),
  x: place,
  y: place,
  /** A cable run goes from its point by (w, h), either way; everything else has a size. */
  w: z.number().min(-200).max(200),
  h: z.number().min(-200).max(200),
  rotation: z.number().min(-360).max(360),
  patchRowId: z.uuid().nullable(),
  /** A label group (#53): the labels of a group are shown or hidden together. */
  group: z.string().trim().max(40),
};

const sized = (i: { kind?: string; w?: number; h?: number }) =>
  i.kind === "cable" || ((i.w === undefined || i.w > 0) && (i.h === undefined || i.h > 0));

export const stageItemInput = z
  .object({
    /** Made by the client, so an undone removal puts the same item back. */
    id: z.uuid(),
    ...itemFields,
    label: itemFields.label.default(""),
    rotation: itemFields.rotation.default(0),
    patchRowId: itemFields.patchRowId.default(null),
    group: itemFields.group.default(""),
  })
  .refine(sized, { message: "Give it a width and a depth", path: ["w"] });

export const stageItemChange = z
  .object({ id: z.uuid(), ...itemFields })
  .partial({
    kind: true,
    label: true,
    x: true,
    y: true,
    w: true,
    h: true,
    rotation: true,
    patchRowId: true,
    group: true,
  })
  .refine((c) => Object.keys(c).length > 1, { message: "Nothing to change" });
export type StageItemChange = z.infer<typeof stageItemChange>;

/**
 * One step on a plan: what it adds, changes and removes, all at once. A step is what undo takes
 * back, so moving or aligning a selection of twenty is one step, not twenty.
 */
export const stageEditInput = z
  .object({
    add: z.array(stageItemInput).max(500).default([]),
    change: z.array(stageItemChange).max(500).default([]),
    remove: z.array(z.uuid()).max(500).default([]),
  })
  .refine((e) => e.add.length + e.change.length + e.remove.length > 0, {
    message: "Nothing to change",
  });
export type StageEditInput = z.input<typeof stageEditInput>;

export interface StageItem {
  id: string;
  kind: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  patchRowId: string | null;
  group: string;
}

export interface StageEdit {
  add: StageItem[];
  change: StageItemChange[];
  remove: string[];
}

export interface StagePlan {
  id: string;
  name: string;
  underlay: Underlay | null;
  width: number;
  depth: number;
  grid: number;
  items: StageItem[];
}

/** A plan's items after a step: changes and removals for items it does not hold do nothing. */
export function applyEdit(items: StageItem[], edit: StageEdit): StageItem[] {
  const gone = new Set(edit.remove);
  const changes = new Map(edit.change.map((c) => [c.id, c]));
  const kept = items
    .filter((i) => !gone.has(i.id))
    .map((i) => {
      const c = changes.get(i.id);
      return c ? { ...i, ...c } : i;
    });
  const held = new Set(kept.map((i) => i.id));
  return [...kept, ...edit.add.filter((i) => !held.has(i.id) && !gone.has(i.id))];
}

/** The step that takes `edit` back, worked out from the items as they were before it. */
export function inverseOf(before: StageItem[], edit: StageEdit): StageEdit {
  const byId = new Map(before.map((i) => [i.id, i]));
  const change: StageItemChange[] = [];
  for (const c of edit.change) {
    const was = byId.get(c.id);
    if (!was) continue;
    const back: StageItemChange = { id: c.id };
    for (const key of Object.keys(c) as (keyof StageItemChange)[]) {
      if (key !== "id") Object.assign(back, { [key]: was[key] });
    }
    change.push(back);
  }
  return {
    add: edit.remove.flatMap((id) => byId.get(id) ?? []),
    change,
    remove: edit.add.filter((i) => !byId.has(i.id)).map((i) => i.id),
  };
}

/** A step that does nothing: not worth sending, nor an undo. */
export function isEmptyEdit(edit: StageEdit): boolean {
  return edit.add.length + edit.change.length + edit.remove.length === 0;
}

/** To the nearest line of the grid, kept to the centimetre. */
export function snapTo(value: number, grid: number): number {
  return Math.round(Math.round(value / grid) * grid * 100) / 100;
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Where an item sits on the plan, unrotated: round kinds about their centre point, a cable from
 * its start to its end, everything else from its back-left corner.
 */
export function boundsOf(i: Pick<StageItem, "kind" | "x" | "y" | "w" | "h">): Box {
  if (roundKinds.includes(i.kind))
    return { left: i.x - i.w / 2, top: i.y - i.h / 2, right: i.x + i.w / 2, bottom: i.y + i.h / 2 };
  return {
    left: Math.min(i.x, i.x + i.w),
    top: Math.min(i.y, i.y + i.h),
    right: Math.max(i.x, i.x + i.w),
    bottom: Math.max(i.y, i.y + i.h),
  };
}

/** The items a marquee touches, as Figma and Keynote pick them: any overlap counts. */
export function inMarquee(items: StageItem[], marquee: Box): string[] {
  const m = {
    left: Math.min(marquee.left, marquee.right),
    right: Math.max(marquee.left, marquee.right),
    top: Math.min(marquee.top, marquee.bottom),
    bottom: Math.max(marquee.top, marquee.bottom),
  };
  return items
    .filter((i) => {
      const b = boundsOf(i);
      return b.left <= m.right && b.right >= m.left && b.top <= m.bottom && b.bottom >= m.top;
    })
    .map((i) => i.id);
}

const cm = (v: number) => Math.round(v * 100) / 100;

/** Moving a selection by (dx, dy): one change an item. */
export function moveBy(items: StageItem[], ids: string[], dx: number, dy: number): StageEdit {
  const chosen = new Set(ids);
  return {
    add: [],
    change: items
      .filter((i) => chosen.has(i.id))
      .map((i) => ({ id: i.id, x: cm(i.x + dx), y: cm(i.y + dy) })),
    remove: [],
  };
}

export type Alignment = "left" | "centre" | "right" | "top" | "middle" | "bottom" | "stage-centre";

/**
 * Lining a selection up on the edge or centre of the box around it, as Figma does; two or more
 * items, except `stage-centre`, which moves the selection as one onto the stage's centre line.
 */
export function align(
  items: StageItem[],
  ids: string[],
  how: Alignment,
  stageWidth: number,
): StageEdit {
  const chosen = items.filter((i) => ids.includes(i.id));
  const none: StageEdit = { add: [], change: [], remove: [] };
  if (chosen.length === 0 || (chosen.length === 1 && how !== "stage-centre")) return none;
  const boxes = chosen.map(boundsOf);
  const all: Box = {
    left: Math.min(...boxes.map((b) => b.left)),
    top: Math.min(...boxes.map((b) => b.top)),
    right: Math.max(...boxes.map((b) => b.right)),
    bottom: Math.max(...boxes.map((b) => b.bottom)),
  };
  if (how === "stage-centre")
    return moveBy(items, ids, stageWidth / 2 - (all.left + all.right) / 2, 0);
  const change = chosen.flatMap((i, n) => {
    const b = boxes[n] as Box;
    const dx =
      how === "left"
        ? all.left - b.left
        : how === "right"
          ? all.right - b.right
          : how === "centre"
            ? (all.left + all.right) / 2 - (b.left + b.right) / 2
            : 0;
    const dy =
      how === "top"
        ? all.top - b.top
        : how === "bottom"
          ? all.bottom - b.bottom
          : how === "middle"
            ? (all.top + all.bottom) / 2 - (b.top + b.bottom) / 2
            : 0;
    if (Math.abs(dx) < 0.005 && Math.abs(dy) < 0.005) return [];
    return [{ id: i.id, x: cm(i.x + dx), y: cm(i.y + dy) }];
  });
  return { add: [], change, remove: [] };
}

/** What a channel shows on the plan: its source, or its box and number when it has none. */
export interface PatchedChannel {
  id: string;
  box: string;
  direction: "input" | "output";
  channel: number;
  source: string;
}

/**
 * The label an item shows: a linked channel's source (so renaming it in the patch list renames
 * it here), else its own label, else what its kind is called.
 */
export function shownLabel(item: Pick<StageItem, "kind" | "label">, patched?: PatchedChannel) {
  if (patched?.source) return patched.source;
  if (item.label) return item.label;
  return stageKindDefaults[item.kind as StageKind]?.name ?? item.kind;
}

/** A channel as it is named across the room: "Stage box A, in 3". */
export function patchedName(p: PatchedChannel): string {
  return `${p.box}, ${p.direction === "input" ? "in" : "out"} ${p.channel}`;
}

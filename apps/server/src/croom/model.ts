import type { CroomReport } from "@hekate/shared";

/**
 * The project a `.croom` file's events rebuild, as ControlRoom's own replay rebuilds it
 * (`SessionState` in its `src/core/model.hpp`), in plain TypeScript: what the replay
 * (`replay.ts`) writes and the plan (`plan.ts`) reads (decision 242). Ids are ControlRoom's,
 * as strings, drawn from its one counter; a reference of 0 (none) is null. Maps keep the order
 * entries were added in, which ControlRoom keeps too and which becomes their order in Hekate.
 */

/** ControlRoom's frame rates, as `set_meta frame_rate` writes them. */
export const frameRates = ["24", "25", "29.97", "29.97DF", "30"] as const;
export type FrameRate = (typeof frameRates)[number];

/** Frames in a timecode second at each rate: 30 for both 29.97 rates. */
export const nominalFps: Record<FrameRate, number> = {
  "24": 24,
  "25": 25,
  "29.97": 30,
  "29.97DF": 30,
  "30": 30,
};

/** The session's own settings, from `create_session`, `set_meta` and `set_notes`. */
export interface CrMeta {
  name: string;
  conductor: string;
  producer: string;
  engineer: string;
  /** The letterhead line on its exports. */
  organisation: string;
  /** The schedule export's front-page prose. */
  publicInfo: string;
  /** "alpha" or "schedule": how its score selector lists the works. */
  scoreOrder: string;
  /** On the stage plan headers and the schedule export's footer. */
  author: string;
  /** Session Info > Notes: one person's own, never printed. */
  personalNotes: string;
  frameRate: FrameRate;
  lifecycleEnabled: boolean;
  /** Each score (or movement) keeps its own run of take numbers. */
  perScoreTakes: boolean;
  /** The session notes panel (`set_notes`). */
  notes: string;
}

export interface CrPdf {
  id: string;
  name: string;
  /** Its row in the blobs table. */
  blobId: string | null;
  pages: number;
  /** The PDF's page (1-based) less the page as printed. */
  pageOffset: number;
}

/** A work of the take log's first structure (`add_work`), before the repertoire. */
export interface CrLogWork {
  id: string;
  name: string;
  numbering: string;
}

/** A movement of such a work (`add_movement`). */
export interface CrLogMovement {
  id: string;
  workId: string | null;
  name: string;
}

/** A movement of a repertoire piece, which has no id of its own: takes and slots name it by place, from 1. */
export interface CrPieceMovement {
  number: string;
  title: string;
  forces: string;
  abbreviation: string;
  pdfId: string | null;
  /** Printed pages; null where unset (0 in the file). */
  pageFrom: number | null;
  pageTo: number | null;
}

/** A repertoire work (`add_piece`, `update_piece`). */
export interface CrPiece {
  id: string;
  title: string;
  composer: string;
  /** Kept for older files; typed into the composer nowadays. */
  arranger: string;
  forces: string;
  abbreviation: string;
  notes: string;
  pdfId: string | null;
  movements: CrPieceMovement[];
}

export interface Timecode {
  hours: number;
  minutes: number;
  seconds: number;
  frames: number;
}

export const takeLifecycles = ["idle", "armed", "recording", "recorded", "aborted"] as const;
export type CrLifecycle = (typeof takeLifecycles)[number];

export interface CrTake {
  id: string;
  number: number;
  /**
   * What it was recorded under: a repertoire piece and a movement by place (0 is the whole
   * piece), or in older files a take-log work and movement by id. Null for neither.
   */
  workId: string | null;
  movement: number;
  /** The score it was recorded against, kept only where each score runs its own numbers. */
  pdfId: string | null;
  falseStarts: number;
  lifecycle: CrLifecycle;
  rating: number;
  notes: string;
  timecodeIn: Timecode | null;
  timecodeOut: Timecode | null;
  /** When `add_take` was written, which is when the take was started: ms since 1970. */
  createdAt: number | null;
}

export interface CrCategory {
  id: string;
  label: string;
  /** Packed as ImGui packs a colour: red in the lowest byte, alpha in the highest. */
  colour: number;
  keybind: string;
}

export const annotationKinds = [
  "issue",
  "tedit",
  "take_begin",
  "take_end",
  "spot_x",
  "circled_dynamic",
  "punch_in",
  "note",
  "ink",
] as const;
export type CrAnnotationKind = (typeof annotationKinds)[number];

export interface CrAnnotation {
  id: string;
  kind: CrAnnotationKind;
  pdfId: string | null;
  /** 0-based, as ControlRoom counts the PDF's pages. */
  page: number;
  rect: boolean;
  /** Fractions of the page: a point, or a region's top-left corner and size. */
  x: number;
  y: number;
  w: number;
  h: number;
  categoryId: string | null;
  note: string;
  resolved: boolean;
  takesAffected: number[];
  takeResolved: number | null;
  tedit: { takes: number[]; overdub: boolean; lead: boolean };
  /** A freehand stroke's points, as offsets from (x, y). */
  ink: [number, number][];
  createdAt: number | null;
  updatedAt: number | null;
  /** When it was last marked resolved. */
  resolvedAt: number | null;
}

export interface CrTodo {
  id: string;
  text: string;
  done: boolean;
}

export interface CrAttachment {
  id: string;
  name: string;
  blobId: string | null;
}

export interface CrVenue {
  id: string;
  name: string;
  address: string;
}

export const personnelKinds = ["artist", "staff", "ensemble", "other"] as const;
export type CrPersonnelKind = (typeof personnelKinds)[number];

export interface CrMember {
  name: string;
  divisi: string;
  rights: boolean;
  cans: boolean;
}

export interface CrSection {
  name: string;
  members: CrMember[];
  /** The head-count while no one is named. */
  unnamed: number;
}

export interface CrPerson {
  id: string;
  kind: CrPersonnelKind;
  name: string;
  role: string;
  forcesNotes: string;
  /** The session agreement is signed. */
  rights: boolean;
  /** Needs headphones. */
  cans: boolean;
  sections: CrSection[];
  /** Older files' guests on a person, before the "other" kind. */
  observers: string[];
}

export interface CrPatchRow {
  source: string;
  device: string;
  cable: string;
  notes: string;
}

export interface CrStageBox {
  id: string;
  name: string;
  /** Channel n is row n - 1. */
  inputs: CrPatchRow[];
  outputs: CrPatchRow[];
}

/** One element of a stage plan: metres, from its centre, turned clockwise by `rot` degrees. */
export interface CrElement {
  id: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  label: string;
  colour: number;
  personId: string | null;
  section: number;
  member: number;
  boxId: string | null;
  channel: number;
  /** A cable's or wall's corners, in metres from the stage's top-left. */
  points: [number, number][];
}

export interface CrStagePlan {
  id: string;
  name: string;
  width: number;
  depth: number;
  paper: string;
  venueId: string | null;
  underlayBlobId: string | null;
  underlayName: string;
  underlayX: number;
  underlayY: number;
  /** Metres to a pixel of the underlay; 0 until ControlRoom first fits it to the stage's width. */
  underlayScale: number;
  underlayOpacity: number;
  /** Which label groups draw: people, sections, mics, boxes, from the lowest bit. */
  labelMask: number;
  elements: CrElement[];
}

export const scheduleKinds = ["day", "slot", "break", "venue"] as const;
export type CrScheduleKind = (typeof scheduleKinds)[number];

export interface CrScheduleItem {
  id: string;
  kind: CrScheduleKind;
  /** "HH:MM", or empty to chain from the row before. */
  start: string;
  minutes: number;
  done: boolean;
  title: string;
  notes: string;
  personnel: string;
  /** A slot's works and movements; a piece of "all" is the whole repertoire. */
  refs: { piece: string | "all"; movement: number }[];
  label: string;
  date: string;
  venueId: string | null;
  /** Older files' fields, written on the row before the registries. */
  legacy: { composer: string; arranger: string; forces: string; venue: string; pdfId: string | null };
}

export interface CroomModel {
  meta: CrMeta;
  pdfs: Map<string, CrPdf>;
  logWorks: Map<string, CrLogWork>;
  logMovements: Map<string, CrLogMovement>;
  pieces: Map<string, CrPiece>;
  takes: Map<string, CrTake>;
  categories: Map<string, CrCategory>;
  annotations: Map<string, CrAnnotation>;
  todos: Map<string, CrTodo>;
  attachments: Map<string, CrAttachment>;
  venues: Map<string, CrVenue>;
  personnel: Map<string, CrPerson>;
  stageBoxes: Map<string, CrStageBox>;
  stagePlans: Map<string, CrStagePlan>;
  /** In ControlRoom's order: a day row starts each day. */
  schedule: CrScheduleItem[];
}

export const emptyModel = (): CroomModel => ({
  meta: {
    name: "",
    conductor: "",
    producer: "",
    engineer: "",
    organisation: "",
    publicInfo: "",
    scoreOrder: "alpha",
    author: "",
    personalNotes: "",
    frameRate: "25",
    lifecycleEnabled: false,
    perScoreTakes: false,
    notes: "",
  },
  pdfs: new Map(),
  logWorks: new Map(),
  logMovements: new Map(),
  pieces: new Map(),
  takes: new Map(),
  categories: new Map(),
  annotations: new Map(),
  todos: new Map(),
  attachments: new Map(),
  venues: new Map(),
  personnel: new Map(),
  stageBoxes: new Map(),
  stagePlans: new Map(),
  schedule: [],
});

/** A map in a new order: `id` moved to `to`, clamped, as ControlRoom moves a row or a person. */
export function moveTo<V>(map: Map<string, V>, id: string, to: number): Map<string, V> {
  const held = map.get(id);
  if (held === undefined) return map;
  const rest = [...map].filter(([key]) => key !== id);
  rest.splice(Math.min(Math.max(0, to), rest.length), 0, [id, held]);
  return new Map(rest);
}

/** Counts what the replay could not bring over, and says it once each. */
export class ReportCollector {
  private unknownEvents = new Map<string, number>();
  private unknownFields = new Map<string, { type: string; field: string; count: number }>();
  private ignored = new Map<string, { count: number; reason: string }>();
  private problems: string[] = [];
  private problemsDropped = 0;

  unknownEvent(type: string) {
    this.unknownEvents.set(type, (this.unknownEvents.get(type) ?? 0) + 1);
  }

  unknownField(type: string, field: string) {
    const key = `${type}\u0000${field}`;
    const held = this.unknownFields.get(key);
    if (held) held.count += 1;
    else this.unknownFields.set(key, { type, field, count: 1 });
  }

  /** Something the file holds that Hekate has no place for: counted under its name, with why. */
  ignore(type: string, reason: string) {
    const held = this.ignored.get(type);
    if (held) held.count += 1;
    else this.ignored.set(type, { count: 1, reason });
  }

  /** A problem with one entry, said once however often it recurs; at most 100 are kept. */
  problem(text: string) {
    if (this.problems.includes(text)) return;
    if (this.problems.length >= 100) this.problemsDropped += 1;
    else this.problems.push(text);
  }

  report(): CroomReport {
    return {
      unknownEvents: [...this.unknownEvents]
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
      unknownFields: [...this.unknownFields.values()].sort(
        (a, b) => a.type.localeCompare(b.type) || a.field.localeCompare(b.field),
      ),
      ignored: [...this.ignored].map(([type, held]) => ({ type, ...held })),
      problems:
        this.problemsDropped > 0
          ? [...this.problems, `And ${this.problemsDropped} more problems like these`]
          : [...this.problems],
    };
  }
}

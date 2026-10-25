import type { CroomReport, ScoreMarkKind } from "@hekate/shared";

/**
 * The project a `.croom` file's events rebuild, in words of neither ControlRoom nor Hekate's
 * tables: what the replay (`replay.ts`) writes and the import (`commit.ts`) reads. Ids are
 * ControlRoom's, as strings; references between entries are by those ids. Maps keep the order
 * entries were added in, which becomes their order in Hekate.
 */

export interface CrWork {
  id: string;
  title: string;
  composer: string;
  forces: string;
  abbreviation: string;
  notes: string;
  /** The PDF its score is, by id. */
  pdfId: string | null;
  pageOffset: number;
}

/** A movement of a piece: in Hekate, a track of the work (Hekate has no movements). */
export interface CrMovement {
  id: string;
  workId: string;
  title: string;
  /** As the score prints it: "I", "2a". */
  number: string;
  pageFrom: number | null;
  pageTo: number | null;
}

export interface CrPdf {
  id: string;
  name: string;
  /** The blob holding its bytes, by the blobs table's id. */
  blobId: string | null;
}

export interface CrSession {
  id: string;
  name: string;
  /** A calendar date, "2026-09-12". */
  date: string | null;
  venueId: string | null;
  notes: string;
}

export interface CrCategory {
  id: string;
  name: string;
  colour: string | null;
  key: string | null;
}

export interface CrTake {
  id: string;
  workId: string | null;
  movementId: string | null;
  sessionId: string | null;
  number: number | null;
  rating: number;
  starred: boolean;
  notes: string;
  falseStarts: number;
  timecodeIn: string | null;
  timecodeOut: string | null;
  wallIn: string | null;
  wallOut: string | null;
  page: number | null;
  pageTo: number | null;
  barFrom: number | null;
  barTo: number | null;
  aborted: boolean;
}

export interface CrMark {
  id: string;
  workId: string | null;
  movementId: string | null;
  /** Null where the file names a kind Hekate does not have: reported, and left out. */
  kind: ScoreMarkKind | null;
  page: number | null;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  points: [number, number][] | null;
  barFrom: number | null;
  barTo: number | null;
  text: string | null;
  categoryId: string | null;
  takes: number[];
  fixedBy: number | null;
  from: number | null;
  to: number | null;
  overdub: boolean;
  resolved: boolean;
}

export interface CrSection {
  name: string;
  count: number;
  divisi: string;
  members: { name: string; agreement: boolean; headphones: boolean }[];
}

export interface CrPerson {
  id: string;
  name: string;
  kind: "artist" | "ensemble" | "staff" | "other";
  role: string;
  agreement: boolean;
  headphones: boolean;
  seating: string;
  sections: CrSection[];
}

export interface CrVenue {
  id: string;
  name: string;
  address: string;
  notes: string;
}

export interface CrDay {
  id: string;
  label: string;
  date: string | null;
  venueId: string | null;
  start: string | null;
}

export interface CrRow {
  id: string;
  /** Its day by id; or, where the file gives none, its date, which finds or makes one. */
  dayId: string | null;
  date: string | null;
  kind: "slot" | "break" | "get-in" | "venue" | "custom";
  start: string | null;
  minutes: number;
  label: string;
  allRepertoire: boolean;
  workIds: string[];
  movementIds: string[];
  personnel: string;
  notes: string;
  done: boolean;
}

export interface CrStagePlan {
  id: string;
  name: string;
  width: number;
  depth: number;
  grid: number;
  venueId: string | null;
}

export interface CrStageElement {
  id: string;
  planId: string | null;
  kind: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  personId: string | null;
  /** The patch list channel it is plugged into: a box and an input channel. */
  boxId: string | null;
  channel: number | null;
  group: string;
}

export interface CrPatch {
  channel: number;
  source: string;
  device: string;
  cable: string;
  notes: string;
}

export interface CrStageBox {
  id: string;
  name: string;
  inputs: CrPatch[];
  outputs: CrPatch[];
}

export interface CroomModel {
  works: Map<string, CrWork>;
  movements: Map<string, CrMovement>;
  pdfs: Map<string, CrPdf>;
  sessions: Map<string, CrSession>;
  categories: Map<string, CrCategory>;
  takes: Map<string, CrTake>;
  marks: Map<string, CrMark>;
  personnel: Map<string, CrPerson>;
  venues: Map<string, CrVenue>;
  days: Map<string, CrDay>;
  rows: Map<string, CrRow>;
  stagePlans: Map<string, CrStagePlan>;
  stageElements: Map<string, CrStageElement>;
  stageBoxes: Map<string, CrStageBox>;
}

export const emptyModel = (): CroomModel => ({
  works: new Map(),
  movements: new Map(),
  pdfs: new Map(),
  sessions: new Map(),
  categories: new Map(),
  takes: new Map(),
  marks: new Map(),
  personnel: new Map(),
  venues: new Map(),
  days: new Map(),
  rows: new Map(),
  stagePlans: new Map(),
  stageElements: new Map(),
  stageBoxes: new Map(),
});

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

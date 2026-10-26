import {
  type CroomConflict,
  type CroomConflictChoice,
  type CroomCount,
  type CroomKind,
  croomKinds,
  type DrawingColour,
  type FileKind,
  fileKindOf,
  type PersonnelKind,
  patchRowInput,
  personnelInput,
  roundKinds,
  type ScheduleRowKind,
  type ScoreMarkKind,
  type SectionInput,
  scheduleDayInput,
  scheduleRowInput,
  scoreMarkCategoryInput,
  scoreMarkInput,
  sessionInput,
  sessionTodoInput,
  stageBoxInput,
  stageItemInput,
  stagePlanInput,
  trackName,
  venueInput,
  workInput,
} from "@hekate/shared";
import type { z } from "zod";
import { timecodeText } from "./families/takes.ts";
import type {
  CrAnnotation,
  CrElement,
  CroomModel,
  CrPatchRow,
  CrPerson,
  CrStagePlan,
  ReportCollector,
} from "./model.ts";
import type { CroomFile } from "./reader.ts";

/**
 * What an import will write, worked out from the replayed model and what the project already
 * has (#57, decision 242). Pure: the preview shows it and the import writes it, each from the
 * same function, so the two cannot disagree. Every entry is checked with the schema the API
 * checks the same thing with, so nothing goes in that the project's own pages would refuse;
 * an entry that fails is left out and said in the report, and whatever the file holds that
 * Hekate has no place for is said under "Not brought over".
 *
 * Where ControlRoom and Hekate differ:
 *
 * - A piece's movements become tracks of its work (Hekate has no movements); a piece with none
 *   is a work of one track. Older files' take-log works and movements become works and tracks
 *   the same way. A score PDF the repertoire does not cover, with marks or takes on it, becomes
 *   a work of its own named after it, as ControlRoom's own export treats such a score.
 * - ControlRoom places a mark on a score's page, not on a piece: the import finds its track by
 *   the movements' printed pages and the score's page offset.
 * - The whole file is one ControlRoom session: its takes, to-dos and notes go into one Hekate
 *   session, named after it. A take recorded under no piece and no score goes on a track made
 *   for them, named after the session.
 * - A stage element is placed by its centre in ControlRoom; in Hekate a box by its corner and a
 *   round item by its centre. A cable or wall drawn through several corners becomes a run or a
 *   wall for each stretch.
 */

/** What the project holds that an import may meet, by name. */
export interface Existing {
  works: { id: string; title: string; tracks: { id: string; name: string; takes: number[] }[] }[];
  venues: { id: string; name: string }[];
  personnel: { id: string; name: string }[];
  stagePlans: { id: string; name: string }[];
  stageBoxes: { id: string; name: string; inputs: number[]; outputs: number[] }[];
  categories: { id: string; name: string }[];
}

export const nothingExisting = (): Existing => ({
  works: [],
  venues: [],
  personnel: [],
  stagePlans: [],
  stageBoxes: [],
  categories: [],
});

/** What the reader knows of the file's blobs: their sizes, and the pictures' pixels. */
export type BlobFacts = Pick<CroomFile, "blobs" | "images">;

export interface PlannedFile {
  key: string;
  name: string;
  blobId: string;
  byteSize: number;
  contentType: string;
  kind: FileKind;
  /** A score of the repertoire, a file attached to the session, or a stage plan's underlay. */
  purpose: "score" | "attachment" | "underlay";
}

export interface PlannedTrack {
  key: string;
  existingId: string | null;
  name: string;
  number: string;
  pageFrom: number | null;
  pageTo: number | null;
  /** Its own score, where it is not its work's. */
  scoreKey: string | null;
}

export interface PlannedWork {
  key: string;
  existingId: string | null;
  title: string;
  composer: string;
  forces: string;
  abbreviation: string;
  notes: string;
  scoreKey: string | null;
  pageOffset: number;
  tracks: PlannedTrack[];
}

export interface PlannedVenue {
  key: string;
  existingId: string | null;
  name: string;
  address: string;
  notes: string;
}

export interface PlannedPerson {
  key: string;
  existingId: string | null;
  name: string;
  kind: PersonnelKind;
  role: string;
  agreement: boolean;
  headphones: boolean;
  seating: string;
  sections: { name: string; count: number; divisi: string; members: SectionMember[] }[];
}

interface SectionMember {
  name: string;
  agreement: boolean;
  headphones: boolean;
}

export interface PlannedSession {
  key: string;
  name: string;
  recordedOn: string | null;
  notes: string | null;
  numbering: "continuous" | "per-track";
  trackKeys: string[];
  todos: { text: string; done: boolean }[];
}

export interface PlannedTake {
  trackKey: string;
  sessionKey: string | null;
  number: number;
  notes: string | null;
  rating: number;
  lifecycle: "recorded" | "aborted";
  falseStarts: number;
  timecodeIn: string | null;
  timecodeOut: string | null;
  wallIn: string | null;
}

export interface PlannedCategory {
  key: string;
  existingId: string | null;
  name: string;
  colour: DrawingColour;
  shortcut: string | null;
}

export interface PlannedMark {
  trackKey: string;
  kind: ScoreMarkKind;
  page: number;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  points: [number, number][] | null;
  barFrom: number | null;
  barTo: number | null;
  text: string | null;
  categoryKey: string | null;
  takes: number[];
  fixedBy: number | null;
  resolved: boolean;
  from: number | null;
  to: number | null;
  overdub: boolean;
  createdAt: string | null;
  resolvedAt: string | null;
}

export interface PlannedRow {
  kind: ScheduleRowKind;
  start: string | null;
  minutes: number;
  label: string;
  allRepertoire: boolean;
  workKeys: string[];
  trackKeys: string[];
  personnel: string;
  notes: string;
  done: boolean;
}

export interface PlannedDay {
  label: string;
  date: string | null;
  venueKey: string | null;
  start: string;
  rows: PlannedRow[];
}

export interface PlannedItem {
  kind: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  personKey: string | null;
  patch: { boxKey: string; channel: number } | null;
  group: string;
}

export interface PlannedStagePlan {
  key: string;
  existingId: string | null;
  name: string;
  width: number;
  depth: number;
  grid: number;
  underlay: { fileKey: string; x: number; y: number; width: number; opacity: number } | null;
  items: PlannedItem[];
}

export interface PlannedBox {
  key: string;
  existingId: string | null;
  name: string;
  inputs: PlannedPatch[];
  outputs: PlannedPatch[];
}

interface PlannedPatch extends CrPatchRow {
  channel: number;
}

export interface ImportPlan {
  files: PlannedFile[];
  works: PlannedWork[];
  venues: PlannedVenue[];
  personnel: PlannedPerson[];
  sessions: PlannedSession[];
  takes: PlannedTake[];
  categories: PlannedCategory[];
  marks: PlannedMark[];
  days: PlannedDay[];
  stagePlans: PlannedStagePlan[];
  stageBoxes: PlannedBox[];
  counts: CroomCount[];
  names: { kind: CroomKind; names: string[] }[];
  conflicts: CroomConflict[];
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A name not yet taken: "Endless Hall", else "Endless Hall (2)" and on. */
export function freeName(name: string, taken: readonly string[], max: number): string {
  if (!taken.some((t) => same(t, name))) return name;
  for (let n = 2; ; n += 1) {
    const suffix = ` (${n})`;
    const candidate = `${name.slice(0, max - suffix.length)}${suffix}`;
    if (!taken.some((t) => same(t, candidate))) return candidate;
  }
}

/** Why a schema refused an entry, in its first issue's words. */
const refusal = (error: z.ZodError) => error.issues[0]?.message ?? "it is not valid";

const within = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/**
 * A category's colour in Hekate's few: ControlRoom packs red in the lowest byte. Reds, oranges,
 * pinks and purples are the signal; greens green; blues and cyans blue; yellows, greys and
 * whites the paper colour.
 */
export function colourOf(packed: number): DrawingColour {
  const r = (packed & 0xff) / 255;
  const g = ((packed >>> 8) & 0xff) / 255;
  const b = ((packed >>> 16) & 0xff) / 255;
  const top = Math.max(r, g, b);
  const spread = top - Math.min(r, g, b);
  if (top < 0.2 || spread / top < 0.25) return "paper";
  let hue: number;
  if (top === r) hue = (((g - b) / spread) % 6) * 60;
  else if (top === g) hue = ((b - r) / spread + 2) * 60;
  else hue = ((r - g) / spread + 4) * 60;
  if (hue < 0) hue += 360;
  if (hue < 45 || hue >= 280) return "signal";
  if (hue < 75) return "paper";
  if (hue < 165) return "green";
  return "blue";
}

/** How a section divides, as Hekate writes it ("2 + 2"), from the part each member is in. */
export function divisiOf(members: { divisi: string }[]): string {
  const parts = new Map<string, number>();
  for (const m of members) {
    const tag = m.divisi.trim();
    if (tag) parts.set(tag, (parts.get(tag) ?? 0) + 1);
  }
  return parts.size >= 2 ? [...parts.values()].join(" + ") : "";
}

const contentTypes: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  tif: "image/tiff",
  tiff: "image/tiff",
  bmp: "image/bmp",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  mov: "video/quicktime",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** A file's type from its name, as ControlRoom keeps no type. */
export const contentTypeOf = (name: string) =>
  contentTypes[name.toLowerCase().split(".").pop() ?? ""] ?? "application/octet-stream";

/** A name fit for a file: no path, at most 200 characters. */
const fileNameOf = (name: string, fallback: string) =>
  (name.trim() || fallback).replace(/[/\\]/g, "-").slice(0, 200);

/** Label groups, as ControlRoom groups the labels a plan draws (its `lmask` bits). */
const labelGroups: Record<string, { bit: number; name: string }> = {
  person: { bit: 1, name: "People" },
  block: { bit: 2, name: "Sections" },
  mic: { bit: 4, name: "Mics" },
  stagebox: { bit: 8, name: "Boxes" },
};

/** ControlRoom's kinds of stage element in Hekate's words; any other keeps its own. */
const stageKindOf: Record<string, string> = {
  person: "performer",
  block: "ensemble",
  mic: "mic",
  piano: "piano",
  timp: "timpani",
  riser: "riser",
  rect: "rect",
  circle: "ellipse",
  label: "label",
  wall: "wall",
  cable: "cable",
  stagebox: "stage-box",
};

/** A choir block's depth from its head-count, as ControlRoom draws it: rows 0.8 m deep, 0.7 m a singer. */
export function blockDepth(count: number, width: number): number {
  const people = Math.max(1, count);
  const cols = Math.min(people, Math.max(1, Math.floor(width / 0.7 + 0.001)));
  return Math.ceil(people / cols) * 0.8;
}

const isoOf = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export function planImport(
  model: CroomModel,
  blobs: BlobFacts,
  existing: Existing,
  choice: CroomConflictChoice,
  report: ReportCollector,
): ImportPlan {
  const conflicts: CroomConflict[] = [];
  const counted = new Map<CroomKind, { create: number; merge: number }>(
    croomKinds.map((k) => [k, { create: 0, merge: 0 }]),
  );
  const names = new Map<CroomKind, string[]>();
  const count = (kind: CroomKind, merged: boolean, name?: string) => {
    const held = counted.get(kind);
    if (held) held[merged ? "merge" : "create"] += 1;
    if (name) {
      const list = names.get(kind) ?? [];
      if (list.length < 6) list.push(name);
      names.set(kind, list);
    }
  };
  /** The entry already there with this name, as the choice treats it. */
  const meet = <E extends { id: string; name: string }>(
    kind: CroomKind,
    name: string,
    there: readonly E[],
  ): E | null => {
    const found = there.find((e) => same(e.name, name));
    if (!found) return null;
    conflicts.push({ kind, name: found.name });
    return choice === "merge" ? found : null;
  };
  /** Text cut to what Hekate keeps, and said where it is cut. */
  const cut = (text: string, max: number, what: string) => {
    const trimmed = text.trim();
    if (trimmed.length <= max) return trimmed;
    report.problem(`${what} is longer than Hekate keeps, so it was shortened`);
    return trimmed.slice(0, max).trim();
  };
  const notBrought = (type: string, reason: string) => report.ignore(type, reason);
  const meta = model.meta;

  // What the session's settings hold that Hekate has no place for.
  if (meta.organisation.trim())
    notBrought("set_meta organisation", "The letterhead on ControlRoom's exports");
  if (meta.publicInfo.trim())
    notBrought("set_meta public_info", "The front page of ControlRoom's schedule export");
  if (meta.author.trim()) notBrought("set_meta author", "The author on ControlRoom's exports");
  if (meta.personalNotes.trim())
    notBrought(
      "set_meta personal_notes",
      "One person's own notes, which ControlRoom never prints: the import does not share them with the project",
    );
  if (meta.scoreOrder === "schedule")
    notBrought("set_meta score_order", "How the desktop app's score selector lists the works");
  if (meta.lifecycleEnabled)
    notBrought(
      "set_meta lifecycle_enabled",
      "Whether the desktop app's take log arms and rolls takes; Hekate's take log always can",
    );

  // Files: the scores, the session's attachments and the stage plans' underlays, each with its
  // bytes in the file.
  const files: PlannedFile[] = [];
  const fileKeys = new Set<string>();
  const addFile = (
    key: string,
    blobId: string | null,
    name: string,
    purpose: PlannedFile["purpose"],
  ) => {
    if (fileKeys.has(key)) return true;
    if (!blobId || !blobs.blobs.has(blobId)) {
      report.problem(`"${name}" has no bytes in the file, so it was left out`);
      return false;
    }
    const contentType = purpose === "score" ? "application/pdf" : contentTypeOf(name);
    files.push({
      key,
      name,
      blobId,
      byteSize: blobs.blobs.get(blobId) ?? 0,
      contentType,
      kind: fileKindOf(name, contentType),
      purpose,
    });
    fileKeys.add(key);
    count(purpose === "score" ? "score" : "file", false, name);
    return true;
  };
  for (const pdf of model.pdfs.values()) {
    const name = fileNameOf(pdf.name, `Score ${pdf.id}`);
    addFile(`pdf:${pdf.id}`, pdf.blobId, /\.pdf$/i.test(name) ? name : `${name}.pdf`, "score");
  }
  for (const a of model.attachments.values())
    addFile(`attachment:${a.id}`, a.blobId, fileNameOf(a.name, `Attachment ${a.id}`), "attachment");
  const scoreKey = (pdfId: string | null) =>
    pdfId && fileKeys.has(`pdf:${pdfId}`) ? `pdf:${pdfId}` : null;

  // Where each take and mark goes: a track, by a key of its own.
  const pieces = [...model.pieces.values()];
  /** The pieces' and movements' spans of each score, for placing a mark by its page. */
  const spans = new Map<string, { key: string; from: number | null; to: number | null }[]>();
  for (const piece of pieces) {
    const parts =
      piece.movements.length > 0
        ? piece.movements.map((m, i) => ({ m, key: `p${piece.id}:${i + 1}` }))
        : [{ m: null, key: `p${piece.id}:0` }];
    for (const { m, key } of parts) {
      const pdfId = m?.pdfId ?? piece.pdfId;
      if (!pdfId) continue;
      const offset = model.pdfs.get(pdfId)?.pageOffset ?? 0;
      const from = m?.pageFrom != null ? m.pageFrom + offset : null;
      const to = m?.pageTo != null ? m.pageTo + offset : null;
      const list = spans.get(pdfId) ?? [];
      list.push({ key, from, to });
      spans.set(pdfId, list);
    }
  }
  const scoreWorks = new Set<string>();
  let unplacedTakes = 0;

  /** A take's track, by what it was recorded under. */
  const placeTake = (t: { workId: string | null; movement: number; pdfId: string | null }) => {
    if (t.workId) {
      const piece = model.pieces.get(t.workId);
      if (piece) {
        if (piece.movements.length === 0) return `p${piece.id}:0`;
        if (t.movement >= 1 && t.movement <= piece.movements.length)
          return `p${piece.id}:${t.movement}`;
        report.problem(
          `Takes of "${piece.title || piece.id}" name none of its movements, so they are on its first`,
        );
        return `p${piece.id}:1`;
      }
      const work = model.logWorks.get(t.workId);
      if (work) {
        const movement = model.logMovements.get(String(t.movement));
        if (movement && movement.workId === work.id) return `m${movement.id}`;
        return `w${work.id}`;
      }
      report.problem("Takes name a work that is no longer in the file, so they go by their score");
    }
    if (t.pdfId && model.pdfs.has(t.pdfId)) {
      const covering = spans.get(t.pdfId);
      if (covering?.[0]) return covering[0].key;
      scoreWorks.add(t.pdfId);
      return `s${t.pdfId}`;
    }
    unplacedTakes += 1;
    return "session";
  };

  /** A mark's track, by its score's page and the movements' printed pages. */
  const placeMark = (a: CrAnnotation) => {
    if (!a.pdfId || !model.pdfs.has(a.pdfId)) return null;
    const page = a.page + 1;
    const covering = spans.get(a.pdfId);
    if (!covering?.length) {
      scoreWorks.add(a.pdfId);
      return `s${a.pdfId}`;
    }
    const inRange = covering.find(
      (s) => (s.from === null || s.from <= page) && (s.to === null || page <= s.to),
    );
    if (inRange) return inRange.key;
    // Past the last printed page of a movement with no end: it runs to the next.
    const before = covering
      .filter((s) => s.from !== null && s.from <= page && s.to === null)
      .sort((x, y) => (y.from ?? 0) - (x.from ?? 0))[0];
    if (before) return before.key;
    report.problem(
      "Marks lie on pages of a score that no movement covers, so they are on the nearest movement",
    );
    const nearest = [...covering].sort(
      (x, y) => Math.abs((x.from ?? page) - page) - Math.abs((y.from ?? page) - page),
    )[0];
    return nearest?.key ?? null;
  };

  const takePlaces = new Map(
    [...model.takes.values()].map((t) => [t.id, placeTake(t)] as const),
  );
  const markPlaces = new Map(
    [...model.annotations.values()].map((a) => [a.id, placeMark(a)] as const),
  );
  if (unplacedTakes > 0)
    report.problem(
      `${unplacedTakes} takes were recorded under no piece and no score, so they are on a track made for them, named after the session`,
    );

  // Works and their tracks.
  const works: PlannedWork[] = [];
  const trackKeys = new Set<string>();
  const takenTracks = new Map<string, { there: Set<number>; file: Set<number> }>();
  const sessionName = meta.name.trim() || "ControlRoom session";
  interface WorkSource {
    key: string;
    title: string;
    composer: string;
    forces: string;
    abbreviation: string;
    notes: string;
    pdfId: string | null;
    tracks: {
      key: string;
      name: string;
      number: string;
      pageFrom: number | null;
      pageTo: number | null;
      pdfId: string | null;
    }[];
  }
  const sources: WorkSource[] = [];
  for (const piece of pieces) {
    const title = piece.title.trim() || `Work ${piece.id}`;
    if (piece.movements.some((m) => m.forces.trim() || m.abbreviation.trim()))
      notBrought(
        "update_piece movements.forces, movements.abbr",
        "Hekate's tracks have no forces or abbreviation of their own",
      );
    sources.push({
      key: `p${piece.id}`,
      title,
      composer: piece.arranger.trim()
        ? [piece.composer.trim(), `arr. ${piece.arranger.trim()}`].filter(Boolean).join(", ")
        : piece.composer,
      forces: piece.forces,
      abbreviation: piece.abbreviation,
      notes: piece.notes,
      pdfId: piece.pdfId,
      tracks:
        piece.movements.length > 0
          ? piece.movements.map((m, i) => ({
              key: `p${piece.id}:${i + 1}`,
              name: m.title.trim() || `${title} ${m.number.trim() || i + 1}`,
              number: m.number,
              pageFrom: m.pageFrom,
              pageTo: m.pageTo,
              pdfId: m.pdfId,
            }))
          : [
              {
                key: `p${piece.id}:0`,
                name: title,
                number: "",
                pageFrom: null,
                pageTo: null,
                pdfId: null,
              },
            ],
    });
  }
  for (const work of model.logWorks.values()) {
    const title = work.name.trim() || `Work ${work.id}`;
    if (work.numbering !== "continuous")
      notBrought("add_work numbering", "How the desktop app's first take log numbered a work's takes");
    const movements = [...model.logMovements.values()].filter((m) => m.workId === work.id);
    sources.push({
      key: `w${work.id}`,
      title,
      composer: "",
      forces: "",
      abbreviation: "",
      notes: "",
      pdfId: null,
      tracks: [
        ...movements.map((m) => ({
          key: `m${m.id}`,
          name: m.name.trim() || `${title} ${m.id}`,
          number: "",
          pageFrom: null,
          pageTo: null,
          pdfId: null,
        })),
        // The work itself, where a take names it and none of its movements.
        ...(movements.length === 0 || [...takePlaces.values()].includes(`w${work.id}`)
          ? [
              {
                key: `w${work.id}`,
                name: title,
                number: "",
                pageFrom: null,
                pageTo: null,
                pdfId: null,
              },
            ]
          : []),
      ],
    });
  }
  for (const pdfId of scoreWorks) {
    const pdf = model.pdfs.get(pdfId);
    const title = (pdf?.name ?? "").replace(/\.pdf$/i, "").trim() || `Score ${pdfId}`;
    sources.push({
      key: `s${pdfId}`,
      title,
      composer: "",
      forces: "",
      abbreviation: "",
      notes: "",
      pdfId,
      tracks: [{ key: `s${pdfId}`, name: title, number: "", pageFrom: null, pageTo: null, pdfId: null }],
    });
  }
  if (unplacedTakes > 0)
    sources.push({
      key: "session",
      title: sessionName,
      composer: "",
      forces: "",
      abbreviation: "",
      notes: "",
      pdfId: null,
      tracks: [{ key: "session", name: sessionName, number: "", pageFrom: null, pageTo: null, pdfId: null }],
    });

  for (const source of sources) {
    const checked = workInput.safeParse({
      title: cut(source.title, 160, `The work "${source.title.slice(0, 40)}"`),
      composer: cut(source.composer, 120, `The composer of "${source.title.slice(0, 40)}"`),
      forces: cut(source.forces, 160, `The forces of "${source.title.slice(0, 40)}"`),
      abbreviation: cut(source.abbreviation, 16, `The abbreviation of "${source.title.slice(0, 40)}"`),
      notes: cut(source.notes, 2000, `The notes on "${source.title.slice(0, 40)}"`),
      pageOffset: within(source.pdfId ? (model.pdfs.get(source.pdfId)?.pageOffset ?? 0) : 0, -999, 999),
    });
    if (!checked.success) {
      report.problem(
        `The work "${source.title}": ${refusal(checked.error)}, so it and its takes were left out`,
      );
      continue;
    }
    const there = meet(
      "work",
      checked.data.title,
      existing.works.map((w) => ({ ...w, name: w.title })),
    );
    const tracks: PlannedTrack[] = [];
    for (const part of source.tracks) {
      const name = trackName.safeParse(part.name.slice(0, 200));
      if (!name.success) {
        report.problem(
          `A movement of "${checked.data.title}" has no name Hekate can use, so it was left out`,
        );
        continue;
      }
      const thereTrack = there?.tracks.find((t) => same(t.name, name.data)) ?? null;
      const ownScore = scoreKey(part.pdfId);
      tracks.push({
        key: part.key,
        existingId: thereTrack?.id ?? null,
        name: name.data,
        number: part.number.trim().slice(0, 12),
        pageFrom: part.pageFrom,
        pageTo:
          part.pageTo !== null && part.pageFrom !== null && part.pageTo >= part.pageFrom
            ? part.pageTo
            : null,
        scoreKey: ownScore && ownScore !== scoreKey(source.pdfId) ? ownScore : null,
      });
      trackKeys.add(part.key);
      takenTracks.set(part.key, { there: new Set(thereTrack?.takes ?? []), file: new Set() });
      count("track", thereTrack !== null, name.data);
    }
    works.push({
      key: source.key,
      existingId: there?.id ?? null,
      title: checked.data.title,
      composer: checked.data.composer,
      forces: checked.data.forces,
      abbreviation: checked.data.abbreviation,
      notes: checked.data.notes,
      scoreKey: scoreKey(source.pdfId),
      pageOffset: checked.data.pageOffset,
      tracks,
    });
    count("work", there !== null, checked.data.title);
  }
  const workKeys = new Set(works.map((w) => w.key));
  const trackNameOf = (key: string) => {
    for (const w of works) for (const t of w.tracks) if (t.key === key) return t.name;
    return key;
  };

  // Venues.
  const venues: PlannedVenue[] = [];
  const venueNames = existing.venues.map((v) => v.name);
  for (const venue of model.venues.values()) {
    const checked = venueInput.safeParse({
      name: cut(venue.name, 120, `The venue "${venue.name.slice(0, 40)}"`),
      address: cut(venue.address, 600, `The address of "${venue.name.slice(0, 40)}"`),
    });
    if (!checked.success) {
      report.problem(
        `The venue "${venue.name || venue.id}": ${refusal(checked.error)}, so it was left out`,
      );
      continue;
    }
    const there = meet("venue", checked.data.name, existing.venues);
    const name = there ? there.name : freeName(checked.data.name, venueNames, 120);
    venueNames.push(name);
    venues.push({ key: venue.id, existingId: there?.id ?? null, ...checked.data, name });
    count("venue", there !== null, name);
  }
  const venueKeys = new Set(venues.map((v) => v.key));

  // Personnel: the file's, then older files' observers, then the session's conductor, producer
  // and engineer where the personnel does not already name them.
  const people: (Omit<CrPerson, "observers"> & { key: string })[] = [
    ...[...model.personnel.values()].map((p) => ({ ...p, key: p.id })),
  ];
  const named = (name: string) => people.some((p) => same(p.name, name));
  const guest = (key: string, name: string, kind: CrPerson["kind"], role: string) => {
    if (!name.trim() || named(name)) return;
    people.push({
      key,
      id: key,
      kind,
      name,
      role,
      forcesNotes: "",
      rights: false,
      cans: false,
      sections: [],
    });
  };
  for (const p of model.personnel.values())
    p.observers.forEach((o, i) => guest(`${p.id}:observer:${i}`, o, "other", "Observer"));
  guest("meta:conductor", meta.conductor, "artist", "Conductor");
  guest("meta:producer", meta.producer, "staff", "Producer");
  guest("meta:engineer", meta.engineer, "staff", "Engineer");
  const personnel: PlannedPerson[] = [];
  const kinds = new Map<string, PersonnelKind>();
  for (const person of people) {
    const what = `"${person.name.slice(0, 40)}" on the personnel`;
    if (person.sections.some((s) => s.members.some((m) => m.divisi.trim())))
      notBrought(
        "update_personnel sections.members.div",
        "Hekate notes how a section divides, not which part each player is in",
      );
    const sections: SectionInput[] =
      person.kind === "ensemble"
        ? person.sections.map((s, i) => {
            const members = s.members
              .filter((m) => m.name.trim())
              .map((m) => ({
                name: cut(m.name, 80, `A player of ${what}`),
                agreement: m.rights,
                headphones: m.cans,
              }));
            return {
              name: cut(s.name, 60, `A section of ${what}`) || `Section ${i + 1}`,
              count: within(s.members.length > 0 ? s.members.length : s.unnamed, members.length, 500),
              divisi: divisiOf(s.members).slice(0, 40),
              members,
            };
          })
        : [];
    if (person.kind !== "ensemble" && person.sections.length > 0)
      report.problem(`${what} has sections but is not an ensemble, so their sections were left out`);
    const checked = personnelInput.safeParse({
      name: cut(person.name, 120, what),
      kind: person.kind,
      role: cut(person.role, 80, `The role of ${what}`),
      agreement: person.rights,
      headphones: person.cans,
      seating: cut(person.forcesNotes, 400, `The forces notes of ${what}`),
      sections: sections.slice(0, 60),
    });
    if (!checked.success) {
      report.problem(
        `${person.name ? what : "Someone on the personnel"}: ${refusal(checked.error)}, so they were left out`,
      );
      continue;
    }
    const there = meet("personnel", checked.data.name, existing.personnel);
    personnel.push({
      key: person.key,
      existingId: there?.id ?? null,
      name: checked.data.name,
      kind: checked.data.kind,
      role: checked.data.role,
      agreement: checked.data.agreement,
      headphones: checked.data.headphones,
      seating: checked.data.seating,
      sections: checked.data.sections,
    });
    kinds.set(person.key, checked.data.kind);
    count("personnel", there !== null, checked.data.name);
  }

  // Takes, each on its track, numbered as the file numbers it where that number is free.
  const takes: PlannedTake[] = [];
  const sessionTracks: string[] = [];
  const days = new Set<string>();
  for (const take of model.takes.values()) {
    const trackKey = takePlaces.get(take.id) ?? null;
    if (!trackKey || !trackKeys.has(trackKey)) {
      report.problem(`Take ${take.number} belongs to no work Hekate could make, so it was left out`);
      continue;
    }
    const taken = takenTracks.get(trackKey) ?? { there: new Set<number>(), file: new Set<number>() };
    const number = take.number;
    if (number < 1) {
      report.problem(`A take of "${trackNameOf(trackKey)}" has no number, so it was left out`);
      continue;
    }
    if (taken.there.has(number)) {
      report.problem(
        `Take ${number} of "${trackNameOf(trackKey)}" is there already, so the file's was left out`,
      );
      continue;
    }
    if (taken.file.has(number)) {
      report.problem(
        `The file has take ${number} of "${trackNameOf(trackKey)}" more than once, so only the first was brought over`,
      );
      continue;
    }
    taken.file.add(number);
    if (!sessionTracks.includes(trackKey)) sessionTracks.push(trackKey);
    if (take.createdAt !== null) days.add(new Date(take.createdAt).toISOString().slice(0, 10));
    if (take.lifecycle === "armed" || take.lifecycle === "recording")
      report.problem(
        `Take ${number} of "${trackNameOf(trackKey)}" was still ${take.lifecycle === "armed" ? "armed" : "rolling"} in ControlRoom, so it is brought over as recorded`,
      );
    const timecode = (tc: typeof take.timecodeIn) => {
      if (!tc) return null;
      if (tc.hours > 99) {
        report.problem(`Take ${number}'s timecode is past 99 hours, so it was left out`);
        return null;
      }
      return timecodeText(tc, meta.frameRate);
    };
    takes.push({
      trackKey,
      sessionKey: "session",
      number,
      notes: take.notes.trim() ? cut(take.notes, 4000, `The notes on take ${number}`) : null,
      rating: take.rating,
      lifecycle: take.lifecycle === "aborted" ? "aborted" : "recorded",
      falseStarts: take.falseStarts,
      timecodeIn: timecode(take.timecodeIn),
      timecodeOut: timecode(take.timecodeOut),
      wallIn: isoOf(take.createdAt),
    });
    count("take", false);
  }

  // The session: the whole file is one, with its takes, to-dos and notes.
  const sessions: PlannedSession[] = [];
  const todos = [...model.todos.values()].filter((t) => {
    if (sessionTodoInput.safeParse({ text: t.text }).success) return true;
    if (t.text.trim()) report.problem("A to-do is longer than Hekate keeps, so it was shortened");
    else report.problem("A to-do says nothing, so it was left out");
    return t.text.trim() !== "";
  });
  if (takes.length > 0 || todos.length > 0 || meta.notes.trim()) {
    const checked = sessionInput.safeParse({
      name: cut(sessionName, 120, "The session's name"),
      recordedOn: days.size === 1 ? [...days][0] : null,
      notes: meta.notes.trim() ? cut(meta.notes, 4000, "The session notes") : null,
    });
    if (checked.success) {
      sessions.push({
        key: "session",
        name: checked.data.name,
        recordedOn: checked.data.recordedOn ?? null,
        notes: checked.data.notes ?? null,
        numbering: meta.perScoreTakes ? "per-track" : "continuous",
        trackKeys: sessionTracks,
        todos: todos.map((t) => ({ text: t.text.trim().slice(0, 200), done: t.done })),
      });
      count("session", false, checked.data.name);
      for (const t of todos) count("todo", false, t.text.trim().slice(0, 40));
    } else {
      report.problem(`The session: ${refusal(checked.error)}, so its takes have none`);
      for (const t of takes) t.sessionKey = null;
    }
  }

  // Score marks, each on its track; a mark of a kind Hekate words differently is said in its words.
  const marks: PlannedMark[] = [];
  const categoriesUsed = new Set<string>();
  for (const a of model.annotations.values()) {
    const trackKey = markPlaces.get(a.id) ?? null;
    if (!trackKey || !trackKeys.has(trackKey)) {
      report.problem("A mark is on a score Hekate could not bring over, so it was left out");
      continue;
    }
    for (const mark of marksOf(a, report)) {
      const checked = scoreMarkInput.safeParse(mark);
      if (!checked.success) {
        report.problem(
          `A ${mark.kind} mark on page ${mark.page}: ${refusal(checked.error)}, so it was left out`,
        );
        continue;
      }
      const m = checked.data;
      const category =
        mark.kind === "issue" && a.categoryId && model.categories.has(a.categoryId)
          ? a.categoryId
          : null;
      if (category) categoriesUsed.add(category);
      marks.push({
        trackKey,
        kind: m.kind,
        page: m.page,
        x: m.x,
        y: m.y,
        width: m.width ?? null,
        height: m.height ?? null,
        points: m.points ?? null,
        barFrom: null,
        barTo: null,
        text: m.text ?? null,
        categoryKey: category,
        takes: m.takes ?? [],
        fixedBy: m.fixedBy ?? null,
        resolved: m.resolved ?? false,
        from: m.from ?? null,
        to: m.to ?? null,
        overdub: m.overdub ?? false,
        createdAt: isoOf(a.createdAt),
        resolvedAt: m.resolved ? isoOf(a.resolvedAt ?? a.updatedAt) : null,
      });
      count("score-mark", false);
    }
  }

  // The categories the marks brought over use. ControlRoom adds six to every project.
  const categories: PlannedCategory[] = [];
  for (const category of model.categories.values()) {
    if (!categoriesUsed.has(category.id)) {
      notBrought("add_category", "A category no mark brought over uses");
      continue;
    }
    const shortcut = /^[1-9]$/.test(category.keybind) ? category.keybind : null;
    if (category.keybind && !shortcut)
      notBrought(
        "add_category keybind",
        "ControlRoom's keys for placing a mark (Q W E A S D); Hekate's are 1 to 9, so the categories come without one",
      );
    const checked = scoreMarkCategoryInput.safeParse({
      name: cut(category.label, 40, `The category "${category.label.slice(0, 40)}"`),
      colour: colourOf(category.colour),
      key: shortcut,
    });
    if (!checked.success) {
      report.problem(
        `The category "${category.label || category.id}": ${refusal(checked.error)}, so its marks have none`,
      );
      for (const m of marks) if (m.categoryKey === category.id) m.categoryKey = null;
      continue;
    }
    const there = meet("category", checked.data.name, existing.categories);
    categories.push({
      key: category.id,
      existingId: there?.id ?? null,
      name: checked.data.name,
      colour: checked.data.colour,
      shortcut: checked.data.key,
    });
    count("category", there !== null, checked.data.name);
  }

  // The schedule: a day row starts each day, and the rows after it are its own.
  const daysPlanned: PlannedDay[] = [];
  let day: (PlannedDay & { started: boolean }) | null = null;
  const venueByName = (name: string) =>
    [...model.venues.values()].find((v) => name.trim() && same(v.name, name))?.id ?? null;
  for (const item of model.schedule) {
    if (item.kind === "day") {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(item.date.trim()) ? item.date.trim() : null;
      if (item.date.trim() && !date)
        report.problem(`The day "${item.label || item.date}" has a date Hekate cannot read, so it has none`);
      let venueId = item.venueId;
      if (!venueId && item.legacy.venue.trim()) {
        venueId = venueByName(item.legacy.venue);
        if (!venueId)
          report.problem(
            `The day "${item.label || item.date}" is at "${item.legacy.venue.slice(0, 40)}", which is not among the venues, so it has none`,
          );
      }
      if (item.notes.trim()) notBrought("update_schedule_item notes", "Hekate's schedule days have no notes");
      const checked = scheduleDayInput.safeParse({
        label: cut(item.label, 60, "A day's label") || date || `Day ${daysPlanned.length + 1}`,
        date,
      });
      if (!checked.success) {
        report.problem(`The day "${item.label}": ${refusal(checked.error)}, so its rows are on the day before`);
        continue;
      }
      day = {
        label: checked.data.label,
        date: checked.data.date,
        venueKey: venueId && venueKeys.has(venueId) ? venueId : null,
        start: "10:00",
        rows: [],
        started: false,
      };
      daysPlanned.push(day);
      count("schedule-day", false, day.label);
      continue;
    }
    if (!day) {
      report.problem("The schedule has rows before its first day, so they are on a day of their own");
      day = { label: "Day 1", date: null, venueKey: null, start: "10:00", rows: [], started: false };
      daysPlanned.push(day);
      count("schedule-day", false, day.label);
    }
    if (item.legacy.composer.trim() || item.legacy.arranger.trim() || item.legacy.forces.trim())
      notBrought(
        "update_schedule_item composer, arranger, forces",
        "Older files' details of a slot's piece, written on the row before the repertoire: Hekate's slots take them from the work",
      );
    const clock = /^(\d{1,2}):(\d{2})$/.exec(item.start.trim());
    const start =
      clock && Number(clock[1]) < 24 && Number(clock[2]) < 60
        ? `${(clock[1] as string).padStart(2, "0")}:${clock[2]}`
        : null;
    if (item.start.trim() && !start)
      report.problem(`A schedule row starts at "${item.start.slice(0, 10)}", which is not a time, so it follows the row before`);
    let kind: ScheduleRowKind = "slot";
    let label = item.title;
    if (item.kind === "break")
      kind = /\bget[- ]?in\b|\bset[- ]?up\b/i.test(item.title) ? "get-in" : "break";
    if (item.kind === "venue") {
      kind = "venue";
      const venue = item.venueId ? model.venues.get(item.venueId) : undefined;
      label = venue?.name || item.legacy.venue || item.title || "Venue change";
    }
    const rowWorks: string[] = [];
    const rowTracks: string[] = [];
    let all = false;
    let missing = false;
    if (kind === "slot")
      for (const ref of item.refs) {
        if (ref.piece === "all") {
          all = true;
          continue;
        }
        const key = ref.movement === 0 ? `p${ref.piece}` : `p${ref.piece}:${ref.movement}`;
        if (ref.movement === 0 && workKeys.has(key)) rowWorks.push(key);
        else if (ref.movement !== 0 && trackKeys.has(key)) rowTracks.push(key);
        else missing = true;
      }
    if (missing) report.problem("A schedule slot names repertoire the file no longer has, which was left off it");
    const checked = scheduleRowInput.safeParse({
      kind,
      start,
      minutes: kind === "venue" ? 0 : within(item.minutes, 0, 24 * 60),
      label: cut(label, 120, "A schedule row's title"),
      allRepertoire: all,
      personnel: cut(item.personnel, 200, "A schedule row's personnel"),
      notes: cut(item.notes, 1000, "A schedule row's notes"),
    });
    if (!checked.success) {
      report.problem(`A schedule row "${label}": ${refusal(checked.error)}, so it was left out`);
      continue;
    }
    // A day starts when its first timed row does; a row before that has no time to follow.
    if (!day.started && kind !== "venue") {
      if (start) day.start = start;
      day.started = true;
    }
    day.rows.push({
      ...checked.data,
      workKeys: rowWorks,
      trackKeys: rowTracks,
      done: item.done,
    });
    count("schedule-row", false);
  }
  const plannedDays: PlannedDay[] = daysPlanned.map(({ label, date, venueKey, start, rows }) => ({
    label,
    date,
    venueKey,
    start,
    rows,
  }));

  // Stage boxes: the channels that say something, and those a microphone or cable is plugged into.
  const plugged = new Map<string, Set<number>>();
  for (const plan of model.stagePlans.values())
    for (const e of plan.elements)
      if ((e.kind === "mic" || e.kind === "cable") && e.boxId && e.channel >= 1) {
        const held = plugged.get(e.boxId) ?? new Set();
        held.add(e.channel);
        plugged.set(e.boxId, held);
      }
  const stageBoxes: PlannedBox[] = [];
  const boxNames = existing.stageBoxes.map((b) => b.name);
  const boxInputs = new Map<string, Set<number>>();
  for (const box of model.stageBoxes.values()) {
    const checked = stageBoxInput.safeParse({ name: cut(box.name, 60, "A stage box's name") });
    if (!checked.success) {
      report.problem(`A stage box: ${refusal(checked.error)}, so it was left out`);
      continue;
    }
    const there = meet("stage-box", checked.data.name, existing.stageBoxes);
    const name = there ? there.name : freeName(checked.data.name, boxNames, 60);
    boxNames.push(name);
    const channels = (rows: CrPatchRow[], direction: "input" | "output", held: number[]) => {
      const kept: PlannedPatch[] = [];
      const seen = new Set(held);
      rows.forEach((r, i) => {
        const channel = i + 1;
        const says = r.source.trim() || r.device.trim() || r.cable.trim() || r.notes.trim();
        if (!says && !(direction === "input" && plugged.get(box.id)?.has(channel))) return;
        if (seen.has(channel)) {
          if (says)
            report.problem(`${name} ${direction} ${channel}: the channel is taken, so it was left out`);
          return;
        }
        const row = patchRowInput.safeParse({
          direction,
          channel,
          source: r.source.trim().slice(0, 80),
          device: r.device.trim().slice(0, 80),
          cable: r.cable.trim().slice(0, 40),
          notes: r.notes.trim().slice(0, 200),
        });
        if (!row.success) {
          report.problem(`${name} ${direction} ${channel}: ${refusal(row.error)}, so it was left out`);
          return;
        }
        seen.add(channel);
        kept.push({
          channel,
          source: row.data.source,
          device: row.data.device,
          cable: row.data.cable,
          notes: row.data.notes,
        });
        count("patch-row", false);
      });
      return kept;
    };
    const planned: PlannedBox = {
      key: box.id,
      existingId: there?.id ?? null,
      name,
      inputs: channels(box.inputs, "input", there?.inputs ?? []),
      outputs: channels(box.outputs, "output", there?.outputs ?? []),
    };
    stageBoxes.push(planned);
    boxInputs.set(box.id, new Set([...(there?.inputs ?? []), ...planned.inputs.map((i) => i.channel)]));
    count("stage-box", there !== null, name);
  }

  // Stage plans and what stands on them. A plan merged into one already there keeps its own.
  const stagePlans: PlannedStagePlan[] = [];
  const planNames = existing.stagePlans.map((p) => p.name);
  for (const plan of model.stagePlans.values()) {
    const venue = plan.venueId ? model.venues.get(plan.venueId) : undefined;
    if (venue)
      notBrought(
        "update_stage_plan venue_id",
        "Hekate's stage plans are not tied to a venue: the plan's name says where it is",
      );
    if (plan.paper && plan.paper !== "A4")
      notBrought("update_stage_plan paper", "The paper ControlRoom exports the plan on");
    if ((plan.labelMask & 15) !== 15)
      notBrought(
        "update_stage_plan lmask",
        "Which label groups ControlRoom draws: Hekate shows or hides a group in the plan's own view",
      );
    const width = within(plan.width, 1, 200);
    const depth = within(plan.depth, 1, 200);
    if (width !== plan.width || depth !== plan.depth)
      report.problem(`The stage plan "${plan.name}" is a size Hekate cannot draw, so it was held to 1 to 200 metres`);
    const checked = stagePlanInput.safeParse({
      name: cut(plan.name, 80, "A stage plan's name") || venue?.name.slice(0, 80) || "Stage",
      width,
      depth,
    });
    if (!checked.success) {
      report.problem(`The stage plan "${plan.name || plan.id}": ${refusal(checked.error)}, so it was left out`);
      continue;
    }
    const there = meet("stage-plan", checked.data.name, existing.stagePlans);
    const name = there ? there.name : freeName(checked.data.name, planNames, 80);
    planNames.push(name);
    if (there && plan.elements.length > 0)
      report.problem(
        `The stage plan "${name}" is there already, so what stands on the file's was left out`,
      );
    const items: PlannedItem[] = [];
    for (const e of there ? [] : plan.elements) {
      for (const item of itemsOf(e, model, report)) {
        const person = e.personId && kinds.has(e.personId) ? e.personId : null;
        const personKind = person ? kinds.get(person) : undefined;
        const linksPerson =
          person !== null &&
          ((item.kind === "ensemble" && personKind === "ensemble") ||
            (item.kind === "performer" && personKind !== "ensemble"));
        const patched =
          (e.kind === "mic" || e.kind === "cable") &&
          e.boxId !== null &&
          boxInputs.get(e.boxId)?.has(e.channel);
        const checkedItem = stageItemInput.safeParse({
          id: "00000000-0000-7000-8000-000000000000",
          kind: item.kind,
          label: item.label.trim().slice(0, 60),
          x: item.x,
          y: item.y,
          w: item.w,
          h: item.h,
          rotation: item.rotation,
          group: item.group,
        });
        if (!checkedItem.success) {
          report.problem(`A ${item.kind} on "${name}": ${refusal(checkedItem.error)}, so it was left out`);
          continue;
        }
        if (e.colour !== 0)
          notBrought("upsert_stage_element c", "An element's own colour: Hekate draws each kind in its own");
        items.push({
          kind: checkedItem.data.kind,
          label: checkedItem.data.label,
          x: checkedItem.data.x,
          y: checkedItem.data.y,
          w: checkedItem.data.w,
          h: checkedItem.data.h,
          rotation: checkedItem.data.rotation,
          personKey: linksPerson ? person : null,
          patch: patched ? { boxKey: e.boxId as string, channel: e.channel } : null,
          group: checkedItem.data.group,
        });
        count("stage-item", false);
      }
    }
    stagePlans.push({
      key: plan.id,
      existingId: there?.id ?? null,
      name,
      width: checked.data.width,
      depth: checked.data.depth,
      grid: checked.data.grid,
      underlay: there ? null : underlayOf(plan, checked.data.width, blobs, addFile, report),
      items,
    });
    count("stage-plan", there !== null, name);
  }

  return {
    files,
    works,
    venues,
    personnel,
    sessions,
    takes,
    categories,
    marks,
    days: plannedDays,
    stagePlans,
    stageBoxes,
    counts: croomKinds
      .map((kind) => ({ kind, ...(counted.get(kind) ?? { create: 0, merge: 0 }) }))
      .filter((c) => c.create + c.merge > 0),
    names: croomKinds
      .filter((kind) => names.has(kind))
      .map((kind) => ({ kind, names: names.get(kind) ?? [] })),
    conflicts,
  };
}

type MarkInput = z.input<typeof scoreMarkInput>;

/** The words Hekate has for a mark that names no take, where Hekate's kind needs one. */
const takeless: Partial<Record<CrAnnotation["kind"], string>> = {
  take_begin: "Take start",
  take_end: "Take end",
  punch_in: "Punch-in",
};

/** One ControlRoom mark as Hekate's marks: a chained T-edit is one edit point for each hand-over. */
export function marksOf(a: CrAnnotation, report: ReportCollector): MarkInput[] {
  const page = a.page + 1;
  const offPage = a.x < 0 || a.x > 1 || a.y < 0 || a.y > 1;
  if (offPage) report.problem("A mark lies off its page, so it was moved to the page's edge");
  const x = within(a.x, 0, 1);
  const y = within(a.y, 0, 1);
  const region =
    a.rect && a.w > 0 && a.h > 0 ? { width: Math.min(a.w, 1 - x), height: Math.min(a.h, 1 - y) } : {};
  const text = a.note.trim() ? a.note.trim().slice(0, 500) : null;
  const takes = [...new Set(a.takesAffected.filter((n) => n >= 1))].slice(0, 50);
  const fixedBy = a.takeResolved !== null && a.takeResolved >= 1 ? a.takeResolved : null;
  const base = { page, x, y, resolved: a.resolved };
  const problem = { ...base, ...region, text, takes, fixedBy };
  switch (a.kind) {
    case "issue":
      return [{ ...problem, kind: "issue" }];
    case "spot_x":
      return [{ ...base, text, takes, fixedBy, kind: "wrong-note" }];
    case "circled_dynamic":
      if (text) return [{ ...problem, kind: "dynamic" }];
      report.problem("A circled dynamic says no dynamic, so it is an issue");
      return [{ ...problem, kind: "issue" }];
    case "note":
      if (text) return [{ ...base, text, kind: "note" }];
      report.problem("A sticky note says nothing, so it was left out");
      return [];
    case "ink": {
      let points = a.ink.map(
        ([dx, dy]) => [within(a.x + dx, 0, 1), within(a.y + dy, 0, 1)] as [number, number],
      );
      // Hekate keeps at most 1024 points of a stroke: an even selection, first and last kept.
      if (points.length > 1024)
        points = Array.from(
          { length: 1024 },
          (_, i) => points[Math.round((i * (points.length - 1)) / 1023)] as [number, number],
        );
      if (points.length < 2) {
        report.problem("An ink stroke has fewer than two points, so it was left out");
        return [];
      }
      return [{ ...base, kind: "ink", points }];
    }
    case "tedit": {
      const chain = a.tedit.takes.filter((n) => n >= 1);
      if (chain.length === 0) {
        report.problem("A T-edit names no takes, so it was left out");
        return [];
      }
      // An overdub lays each take it names over; a lead-in starts the chain with its first take.
      if (a.tedit.overdub)
        return chain.map((to, i) => ({ ...base, kind: "edit", to, overdub: true, text: i === 0 ? text : null }));
      const edits: MarkInput[] = [];
      if (a.tedit.lead || chain.length === 1)
        edits.push({ ...base, kind: "edit", from: null, to: chain[0] as number });
      for (let i = 1; i < chain.length; i += 1)
        edits.push({ ...base, kind: "edit", from: chain[i - 1] as number, to: chain[i] as number });
      if (edits[0]) edits[0] = { ...edits[0], text };
      return edits;
    }
    default: {
      const kind = a.kind === "take_begin" ? "take-start" : a.kind === "take_end" ? "take-end" : "punch-in";
      const to = a.takesAffected[0] ?? a.tedit.takes[0];
      if (to !== undefined && to >= 1) return [{ ...base, kind, to, text }];
      const words = takeless[a.kind] ?? "Mark";
      report.problem(`${words} marks name no take, so they are sticky notes saying "${words}"`);
      return [{ ...base, kind: "note", text: text ? `${words}: ${text}`.slice(0, 500) : words }];
    }
  }
}

/** One ControlRoom element as Hekate's stage items: a run or a wall for each stretch of its line. */
export function itemsOf(e: CrElement, model: CroomModel, report: ReportCollector) {
  const known = stageKindOf[e.kind];
  const written = e.kind.toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-+|-+$/g, "");
  const kind = known ?? (/^[a-z][a-z-]{0,30}$/.test(written) ? written : "rect");
  const turned = (((e.rot % 360) + 360) % 360) as number;
  const rotation = turned > 180 ? turned - 360 : turned;
  const group = labelGroups[e.kind]?.name ?? "";
  const items: Omit<PlannedItem, "personKey" | "patch">[] = [];

  if (e.kind === "cable" || e.kind === "wall") {
    if (e.points.length < 2) {
      report.problem(`A ${e.kind} has no line drawn, so it was left out`);
      return items;
    }
    for (let i = 1; i < e.points.length; i += 1) {
      const [x0, y0] = e.points[i - 1] as [number, number];
      const [x1, y1] = e.points[i] as [number, number];
      const label = i === 1 ? e.label : "";
      if (e.kind === "cable") {
        items.push({ kind, label, x: x0, y: y0, w: x1 - x0, h: y1 - y0, rotation: 0, group });
        continue;
      }
      const length = Math.hypot(x1 - x0, y1 - y0);
      if (length === 0) continue;
      const thick = 0.2;
      items.push({
        kind,
        label,
        x: (x0 + x1) / 2 - length / 2,
        y: (y0 + y1) / 2 - thick / 2,
        w: length,
        h: thick,
        rotation: (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI,
        group,
      });
    }
    return items;
  }

  const person = e.personId ? model.personnel.get(e.personId) : undefined;
  const section = person && e.section >= 0 ? person.sections[e.section] : undefined;
  let label = e.label;
  let h = e.h;
  if (e.kind === "person" && section && !label) {
    // Someone in an ensemble: Hekate links a performer to a person, not to a player.
    const member = e.member >= 0 ? section.members[e.member] : undefined;
    label = member?.name || `${section.name.slice(0, 3)} ${e.member + 1}`;
  }
  if (e.kind === "block") {
    if (!label && section) label = section.name;
    h = blockDepth(section ? (section.members.length || section.unnamed) : 0, e.w);
  }
  if (e.kind === "stagebox" && !label) {
    const box = e.boxId ? model.stageBoxes.get(e.boxId) : undefined;
    label = box ? `Box ${box.name}` : "";
  }
  if (kind === "label") {
    items.push({ kind, label, x: e.x, y: e.y, w: 1.6, h: 0.4, rotation, group });
    return items;
  }
  const round = roundKinds.includes(kind);
  const w = round ? Math.max(e.w, 0.2) : e.w;
  const depth = round && (e.kind === "circle" || e.kind === "timp" || e.kind === "mic") ? w : h;
  items.push({
    kind,
    label,
    // A box from its corner, a round item from its centre, as Hekate places them.
    x: round ? e.x : e.x - w / 2,
    y: round ? e.y : e.y - depth / 2,
    w,
    h: depth,
    rotation,
    group,
  });
  return items;
}

/** A plan's floor-plan underlay, as a file of the project drawn under the stage. */
function underlayOf(
  plan: CrStagePlan,
  width: number,
  blobs: BlobFacts,
  addFile: (key: string, blobId: string | null, name: string, purpose: PlannedFile["purpose"]) => boolean,
  report: ReportCollector,
): PlannedStagePlan["underlay"] {
  if (!plan.underlayBlobId) return null;
  const key = `underlay:${plan.underlayBlobId}`;
  const name = fileNameOf(plan.underlayName, `Underlay ${plan.underlayBlobId}`);
  if (!addFile(key, plan.underlayBlobId, name, "underlay")) return null;
  const pixels = blobs.images.get(plan.underlayBlobId);
  let across = width;
  if (plan.underlayScale > 0) {
    if (pixels) across = pixels.width * plan.underlayScale;
    else
      report.problem(
        `The underlay of "${plan.name}" is not a picture whose size the import can read, so it spans the stage's width: set its scale again`,
      );
  }
  return {
    fileKey: key,
    x: within(plan.underlayX, -100, 300),
    y: within(plan.underlayY, -100, 300),
    width: within(across, 0.01, 500),
    opacity: within(plan.underlayOpacity, 0.05, 1),
  };
}

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { crc32, deflateSync } from "node:zlib";
import { samplePdf } from "../media/sample-pdf.ts";

/**
 * For tests and the visual suite: a small, fictional ControlRoom project file, made when it is
 * needed rather than kept as a binary (#57, decision 242). It is written as ControlRoom writes
 * one: the same three tables (its `EventStore`), each event appended in its own row with the
 * redo tail set aside first, undo and redo moving the head, and each payload as its
 * `serialize_event` writes it (every field, keys in order, its `type` included, floats as
 * floats). Nothing in it comes from a real project. A session opened as ControlRoom opens a new
 * one (its six categories and two views), then a score, the repertoire, venues, personnel, the
 * schedule, takes, marks, a stage box and plan with an underlay, to-dos, an attachment, view
 * state, an undone event set aside, two events undone and still redoable, an event no family
 * knows and a field no family reads.
 */

/** A number ControlRoom keeps as a float, written as its JSON writer writes one ("5.0"). */
export class Float {
  readonly value: number;
  constructor(value: number) {
    this.value = Math.fround(value);
  }
}
const f32 = (value: number) => new Float(value);

export type Json =
  | string
  | number
  | boolean
  | null
  | bigint
  | Float
  | Json[]
  | { [key: string]: Json };

/** JSON as ControlRoom's library writes it: compact, keys in order, large ids exactly. */
export function dump(value: Json): string {
  if (value === null) return "null";
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Float)
    return Number.isInteger(value.value) ? `${value.value}.0` : String(value.value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(dump).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${dump(value[key] as Json)}`)
    .join(",")}}`;
}

/** ControlRoom's id for the whole repertoire: the largest unsigned 64-bit number. */
export const ALL_REPERTOIRE = 18446744073709551615n;

export interface WriterOptions {
  schemaVersion?: string | null;
  /** Leave a table out, to prove the reader refuses the file. */
  without?: "meta" | "events" | "blobs";
}

/**
 * A `.croom` file written as ControlRoom's `EventStore` writes one: `dispatch` appends an event
 * (setting any redo tail aside on branch 1 first) and moves the head to it; `undo` and `redo`
 * move the head along branch 0; `blob` stores bytes; `kv` writes view state.
 */
export class CroomWriter {
  private db: DatabaseSync;
  private head = 0;
  private at = Date.UTC(2026, 8, 12, 9, 0);
  private hasEvents: boolean;
  private hasMeta: boolean;
  private hasBlobs: boolean;

  constructor(path: string, options: WriterOptions = {}) {
    this.db = new DatabaseSync(path);
    this.hasMeta = options.without !== "meta";
    this.hasEvents = options.without !== "events";
    this.hasBlobs = options.without !== "blobs";
    // ControlRoom keeps a rollback journal and syncs every commit, so a crash loses nothing; a
    // fixture needs neither, and the file it leaves is the same.
    this.db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=OFF;");
    if (this.hasMeta)
      this.db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);");
    if (this.hasEvents)
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS events(  seq INTEGER PRIMARY KEY AUTOINCREMENT,  ts INTEGER NOT NULL,  type TEXT NOT NULL,  payload TEXT NOT NULL,  branch INTEGER NOT NULL DEFAULT 0);CREATE INDEX IF NOT EXISTS idx_events_active ON events(branch, seq);",
      );
    else this.db.exec("CREATE TABLE things(id INTEGER PRIMARY KEY AUTOINCREMENT);");
    if (options.without !== "blobs")
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS blobs(  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, bytes BLOB);",
      );
    if (this.hasMeta) {
      if (options.schemaVersion !== null)
        this.db
          .prepare("INSERT OR IGNORE INTO meta(key,value) VALUES('schema_version',?);")
          .run(options.schemaVersion ?? "1");
      this.db.exec("INSERT OR IGNORE INTO meta(key,value) VALUES('head','0');");
    }
  }

  /** Appends an event, its payload written whole by `dump`. Returns its seq. */
  dispatch(type: string, fields: { [key: string]: Json } = {}): number {
    return this.append(type, dump({ type, ...fields }));
  }

  /** Appends a payload as given, for an event ControlRoom itself would not write. */
  append(type: string, payload: string): number {
    if (!this.hasEvents) return 0;
    this.at += 60_000;
    // One transaction an event, as ControlRoom appends one.
    this.db.exec("BEGIN IMMEDIATE;");
    this.db.prepare("UPDATE events SET branch=1 WHERE branch=0 AND seq>?;").run(this.head);
    const row = this.db
      .prepare("INSERT INTO events(ts,type,payload,branch) VALUES(?,?,?,0);")
      .run(this.at, type, payload);
    this.writeHead(Number(row.lastInsertRowid));
    this.db.exec("COMMIT;");
    return this.head;
  }

  undo() {
    if (!this.hasEvents) return;
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq),0) AS prev FROM events WHERE branch=0 AND seq<?;")
      .get(this.head) as { prev: number };
    this.writeHead(Number(row.prev));
  }

  redo() {
    if (!this.hasEvents) return;
    const row = this.db
      .prepare("SELECT MIN(seq) AS next FROM events WHERE branch=0 AND seq>?;")
      .get(this.head) as { next: number | null };
    if (row.next !== null) this.writeHead(Number(row.next));
  }

  blob(name: string, bytes: Uint8Array): number {
    if (!this.hasBlobs) return 0;
    const row = this.db.prepare("INSERT INTO blobs(name,bytes) VALUES(?,?);").run(name, bytes);
    return Number(row.lastInsertRowid);
  }

  kv(key: string, value: string) {
    if (!this.hasMeta) return;
    this.db
      .prepare(
        "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
      )
      .run(key, value);
  }

  close() {
    this.db.close();
  }

  private writeHead(head: number) {
    this.head = head;
    if (this.hasMeta)
      this.db.prepare("UPDATE meta SET value=? WHERE key='head';").run(String(head));
  }
}

/** A grey picture of the size given, as a PNG. */
export function samplePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits a sample
  header[9] = 0; // grey
  const rows = Buffer.alloc((width + 1) * height, 0xd0);
  for (let y = 0; y < height; y += 1) rows[y * (width + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** ImGui's packing of a colour: red in the lowest byte. */
const rgba = (r: number, g: number, b: number, a = 255) =>
  ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;

/** A mark's payload, every field as ControlRoom writes it. */
function annotation(
  kind: string,
  loc: { pdf: number; page: number; rect?: boolean; x: number; y: number; w?: number; h?: number },
  more: {
    category?: number;
    note?: string;
    takes_affected?: number[];
    take_resolved?: number | null;
    tedit?: { takes: number[]; overdub?: boolean; lead?: boolean };
    ink?: [number, number][];
  } = {},
): { [key: string]: Json } {
  const payload: { [key: string]: Json } = {
    kind,
    loc: {
      pdf: loc.pdf,
      page: loc.page,
      geom: loc.rect ? "rect" : "point",
      x: loc.x,
      y: loc.y,
      w: loc.w ?? 0,
      h: loc.h ?? 0,
    },
    category: more.category ?? 0,
    note: more.note ?? "",
    takes_affected: more.takes_affected ?? [],
    take_resolved: more.take_resolved ?? null,
    tedit: {
      takes: more.tedit?.takes ?? [],
      overdub: more.tedit?.overdub ?? false,
      lead: more.tedit?.lead ?? false,
    },
  };
  if (more.ink?.length) payload.ink = more.ink;
  return payload;
}

/** A stage element, every field as ControlRoom writes it. */
function element(
  kind: string,
  at: { x: number; y: number; w?: number; h?: number; r?: number },
  more: {
    id?: number;
    lb?: string;
    per?: number;
    sec?: number;
    mem?: number;
    box?: number;
    ch?: number;
    pts?: [number, number][];
  } = {},
): { [key: string]: Json } {
  return {
    id: more.id ?? 0,
    k: kind,
    x: f32(at.x),
    y: f32(at.y),
    w: f32(at.w ?? 1),
    h: f32(at.h ?? 1),
    r: f32(at.r ?? 0),
    lb: more.lb ?? "",
    c: 0,
    per: more.per ?? 0,
    sec: more.sec ?? -1,
    mem: more.mem ?? -1,
    box: more.box ?? 0,
    ch: more.ch ?? 0,
    pts: (more.pts ?? []).map(([x, y]) => [f32(x), f32(y)]),
  };
}

/** A schedule row's update, every field as ControlRoom writes it. */
function scheduleRow(
  id: number,
  kind: string,
  more: {
    start?: string;
    dur?: number;
    done?: boolean;
    title?: string;
    refs?: [number | bigint, number][];
    personnel?: string;
    label?: string;
    date?: string;
    venue_id?: number;
  },
): { [key: string]: Json } {
  const refs = more.refs ?? [];
  return {
    id,
    kind,
    start: more.start ?? "",
    dur: more.dur ?? 0,
    done: more.done ?? false,
    title: more.title ?? "",
    composer: "",
    arranger: "",
    forces: "",
    notes: "",
    pdf: 0,
    date: more.date ?? "",
    venue: "",
    personnel: more.personnel ?? "",
    piece: refs[0]?.[0] ?? 0,
    movement: refs[0]?.[1] ?? 0,
    refs: refs.map(([piece, movement]) => [piece, movement]),
    label: more.label ?? "",
    venue_id: more.venue_id ?? 0,
  };
}

/** A person's update, every field as ControlRoom writes it. */
function person(
  id: number,
  kind: string,
  name: string,
  more: {
    role?: string;
    rights?: boolean;
    cans?: boolean;
    forces_notes?: string;
    sections?: {
      name: string;
      members: { name: string; div: string; rights: boolean; cans: boolean }[];
      unnamed: number;
    }[];
    observers?: string[];
  } = {},
): { [key: string]: Json } {
  return {
    id,
    kind,
    name,
    role: more.role ?? "",
    rights: more.rights ?? false,
    cans: more.cans ?? false,
    forces_notes: more.forces_notes ?? "",
    sections: more.sections ?? [],
    observers: more.observers ?? [],
  };
}

export interface FixtureOptions extends WriterOptions {
  /** The embedded score's bytes; a four-page PDF with bar numbers unless given. */
  score?: Uint8Array;
}

/**
 * Writes the fixture as a `.croom` file at `path`. The comment by each event that makes an entry
 * is the id it draws from ControlRoom's counter, counted by hand from the source's rules, so a
 * test that finds the entries under those ids proves the replay counts as ControlRoom does.
 */
export function writeCroomFixture(path: string, options: FixtureOptions = {}): void {
  const w = new CroomWriter(path, options);
  try {
    // Opened as ControlRoom opens a new project: named, its six categories and two views.
    w.dispatch("create_session", { name: "Joplin Rags" });
    w.dispatch("add_category", { label: "Red", color: rgba(235, 70, 70), keybind: "Q" }); // 1
    w.dispatch("add_category", { label: "Orange", color: rgba(240, 150, 50), keybind: "W" }); // 2
    w.dispatch("add_category", { label: "Yellow", color: rgba(235, 205, 60), keybind: "E" }); // 3
    w.dispatch("add_category", { label: "Green", color: rgba(90, 200, 110), keybind: "A" }); // 4
    w.dispatch("add_category", { label: "Blue", color: rgba(80, 150, 235), keybind: "S" }); // 5
    w.dispatch("add_category", { label: "Pink", color: rgba(235, 100, 170), keybind: "D" }); // 6
    w.dispatch("add_view", { name: "Score focus", builder: "score", layout: "", builtin: true }); // 7
    w.dispatch("add_view", {
      name: "Take log focus",
      builder: "takelog",
      layout: "",
      builtin: true,
    }); // 8
    w.dispatch("set_active_view", { id: 7 });

    // The session's settings.
    w.dispatch("set_meta", { field: "frame_rate", value: "25" });
    w.dispatch("set_meta", { field: "producer", value: "Mira Solberg" });
    w.dispatch("set_meta", { field: "engineer", value: "Tomas Varga" });
    w.dispatch("set_meta", { field: "organisation", value: "Endless Hall Records" });
    w.dispatch("set_meta", { field: "per_score_takes", value: "1" });
    w.dispatch("set_meta", { field: "personal_notes", value: "Ask about the piano's tuning" });
    w.dispatch("set_notes", { notes: "Day 1 of 2: the rags, then the titles." });

    // Two scores, their bytes in the blobs table.
    const score = w.blob("Joplin Rags - Score.pdf", options.score ?? samplePdf(4, { bars: true }));
    w.dispatch("add_pdf", { name: "Joplin Rags - Score.pdf", blob: score, pages: 4 }); // 9
    const titles = w.blob("Opening titles.pdf", samplePdf(1));
    w.dispatch("add_pdf", { name: "Opening titles.pdf", blob: titles, pages: 1 }); // 10
    w.dispatch("set_pdf_page_offset", { pdf: 9, offset: 0 });

    // The repertoire: one piece of two movements, on printed pages 1-2 and 3-4 of the score.
    w.dispatch("add_piece"); // 11
    w.dispatch("update_piece", {
      id: 11,
      title: "Rags",
      composer: "Scott Joplin",
      arranger: "",
      forces: "piano",
      abbr: "RAGS",
      notes: "",
      pdf: 9,
      movements: [
        { num: "1", title: "Maple Leaf Rag", forces: "", abbr: "MLR", pdf: 0, p0: 1, p1: 2 },
        { num: "2", title: "The Entertainer", forces: "", abbr: "", pdf: 0, p0: 3, p1: 4 },
      ],
    });

    // Venues; the first update carries a field no family reads.
    w.dispatch("add_venue"); // 12
    w.dispatch("update_venue", {
      id: 12,
      name: "Endless Hall",
      address: "Mill Lane\nBristol",
      postcode: "BS1 4AA",
    });
    w.dispatch("add_venue"); // 13
    w.dispatch("update_venue", { id: 13, name: "Endless Hall Studio 2", address: "" });

    // Personnel: an artist, an ensemble, a producer with an older file's observer; one added and
    // removed; the producer moved to the top.
    w.dispatch("add_personnel", { kind: "artist" }); // 14
    w.dispatch(
      "update_personnel",
      person(14, "artist", "Ines Arlow", { role: "Piano", rights: true, cans: true }),
    );
    w.dispatch("add_personnel", { kind: "ensemble" }); // 15
    w.dispatch(
      "update_personnel",
      person(15, "ensemble", "Endless Hall Strings", {
        role: "Strings",
        forces_notes: "Antiphonal violins",
        sections: [
          {
            name: "Violin I",
            members: [
              { name: "Tomas Varga", div: "I", rights: true, cans: false },
              { name: "Alex Rivera", div: "II", rights: true, cans: true },
            ],
            unnamed: 0,
          },
          { name: "Viola", members: [], unnamed: 3 },
        ],
      }),
    );
    w.dispatch("add_personnel", { kind: "staff" }); // 16
    w.dispatch(
      "update_personnel",
      person(16, "staff", "Mira Solberg", {
        role: "Producer",
        rights: true,
        observers: ["Alex Rivera"],
      }),
    );
    w.dispatch("add_personnel", { kind: "other" }); // 17
    w.dispatch("delete_personnel", { id: 17 });
    w.dispatch("move_personnel", { id: 16, to: 0 });

    // The schedule: a day, its rows, a venue change moved before lunch.
    w.dispatch("add_schedule_item", { kind: "day", index: -1 }); // 18
    w.dispatch(
      "update_schedule_item",
      scheduleRow(18, "day", { label: "Recording day", date: "2026-09-12", venue_id: 12 }),
    );
    w.dispatch("add_schedule_item", { kind: "break", index: -1 }); // 19
    w.dispatch(
      "update_schedule_item",
      scheduleRow(19, "break", { title: "Get-In / Setup", start: "09:00", dur: 60, done: true }),
    );
    w.dispatch("add_schedule_item", { kind: "slot", index: -1 }); // 20
    w.dispatch(
      "update_schedule_item",
      scheduleRow(20, "slot", {
        dur: 90,
        refs: [
          [11, 1],
          [11, 2],
        ],
        personnel: "Ines Arlow",
      }),
    );
    w.dispatch("add_schedule_item", { kind: "break", index: -1 }); // 21
    w.dispatch(
      "update_schedule_item",
      scheduleRow(21, "break", { title: "Lunch", start: "13:00", dur: 60 }),
    );
    w.dispatch("add_schedule_item", { kind: "venue", index: -1 }); // 22
    w.dispatch("update_schedule_item", scheduleRow(22, "venue", { venue_id: 13 }));
    w.dispatch("add_schedule_item", { kind: "slot", index: -1 }); // 23
    w.dispatch(
      "update_schedule_item",
      scheduleRow(23, "slot", { dur: 120, refs: [[ALL_REPERTOIRE, 0]] }),
    );
    w.dispatch("move_schedule_item", { id: 22, to: 3 });

    // Takes, each score numbering its own: two of Maple Leaf Rag, one of The Entertainer
    // (aborted), one on the titles score with no repertoire, one added and deleted.
    w.dispatch("add_take", { number: 1, work: 11, movement: 1, pdf: 9 }); // 24
    w.dispatch("set_take_lifecycle", { take: 24, value: "recorded" });
    w.dispatch("set_take_rating", { take: 24, rating: 3 });
    w.dispatch("set_take_notes", { take: 24, notes: "Rushed at the trio" });
    w.dispatch("set_take_timecode", { take: 24, in: true, tc: "10:02:11:04" });
    w.dispatch("set_take_timecode", { take: 24, in: false, tc: "10:04:40:12" });
    w.dispatch("add_take", { number: 2, work: 11, movement: 1, pdf: 9 }); // 25
    w.dispatch("adjust_false_start", { take: 25, delta: 1 });
    w.dispatch("adjust_false_start", { take: 25, delta: 1 });
    w.dispatch("adjust_false_start", { take: 25, delta: -1 });
    w.dispatch("set_take_rating", { take: 25, rating: 5 });
    w.dispatch("add_take", { number: 1, work: 11, movement: 2, pdf: 9 }); // 26
    w.dispatch("set_take_lifecycle", { take: 26, value: "aborted" });
    w.dispatch("add_take", { number: 1, work: 0, movement: 0, pdf: 10 }); // 27
    w.dispatch("add_take", { number: 3, work: 11, movement: 1, pdf: 9 }); // 28
    w.dispatch("delete_take", { take: 28 });

    // Undone, then set aside on branch 1 by the next event: it draws no id, so the mark after
    // it is 29.
    w.dispatch("add_todo", { text: "Undone, never replayed" });
    w.undo();

    // Marks on the score: Maple Leaf Rag on its pages 0 and 1, The Entertainer on 2 and 3.
    w.dispatch(
      "add_annotation",
      annotation(
        "issue",
        { pdf: 9, page: 0, rect: true, x: 0.2, y: 0.3, w: 0.2, h: 0.1 },
        { category: 1, note: "Left hand late", takes_affected: [1] },
      ),
    ); // 29
    w.dispatch("set_annotation_status", { id: 29, status: "resolved" });
    w.dispatch("set_annotation_takes", { id: 29, affected: [1], resolved: 2 });
    w.dispatch(
      "add_annotation",
      annotation(
        "tedit",
        { pdf: 9, page: 0, x: 0.1, y: 0.1 },
        { tedit: { takes: [1], lead: true } },
      ),
    ); // 30
    w.dispatch(
      "add_annotation",
      annotation("tedit", { pdf: 9, page: 1, x: 0.5, y: 0.4 }, { tedit: { takes: [1, 2] } }),
    ); // 31
    w.dispatch(
      "add_annotation",
      annotation(
        "tedit",
        { pdf: 9, page: 1, x: 0.7, y: 0.6 },
        { tedit: { takes: [2], overdub: true } },
      ),
    ); // 32
    w.dispatch(
      "add_annotation",
      annotation("note", { pdf: 9, page: 3, x: 0.6, y: 0.7 }, { note: "Breath before the trio" }),
    ); // 33
    w.dispatch("move_annotation", { id: 33, page: 3, x: 0.62, y: 0.72 });
    w.dispatch(
      "add_annotation",
      annotation("punch_in", { pdf: 9, page: 2, x: 0.36, y: 0.68 }, { takes_affected: [1] }),
    ); // 34
    w.dispatch("add_annotation", annotation("punch_in", { pdf: 9, page: 2, x: 0.55, y: 0.2 })); // 35
    w.dispatch(
      "add_annotation",
      annotation(
        "ink",
        { pdf: 9, page: 0, rect: true, x: 0.5, y: 0.5, w: 0.1, h: 0.05 },
        {
          ink: [
            [0, 0],
            [0.05, 0.05],
            [0.1, 0],
          ],
        },
      ),
    ); // 36
    w.dispatch("add_annotation", annotation("spot_x", { pdf: 10, page: 0, x: 0.4, y: 0.4 })); // 37
    w.dispatch(
      "add_annotation",
      annotation("issue", { pdf: 9, page: 1, x: 0.3, y: 0.3 }, { category: 3 }),
    ); // 38
    w.dispatch("delete_annotation", { id: 38 });

    // A stage box, and a stage plan with a floor-plan underlay and what stands on it.
    w.dispatch("add_stagebox"); // 39
    const blank = (n: number) => Array.from({ length: n }, (): Json => ["", "", "", ""]);
    w.dispatch("update_stagebox", {
      id: 39,
      name: "A",
      ins: [["Piano L", "DPA 4006", "1", ""], ["Piano R", "DPA 4006", "2", ""], ...blank(30)],
      outs: [["Foldback", "", "", ""], ...blank(7)],
    });
    const floor = w.blob("Endless Hall floor plan.png", samplePng(400, 300));
    w.dispatch("add_stage_plan"); // 40
    w.dispatch("update_stage_plan", {
      id: 40,
      name: "Endless Hall",
      w: f32(12),
      d: f32(8),
      paper: "A3",
      venue_id: 12,
      blob: floor,
      blob_name: "Endless Hall floor plan.png",
      ulx: f32(0),
      uly: f32(0),
      uls: f32(0.03),
      ulo: f32(0.35),
      lmask: 4294967295,
    });
    w.dispatch("upsert_stage_element", {
      plan: 40,
      el: element("piano", { x: 5, y: 3, w: 1.6, h: 2.4 }),
    }); // 41
    w.dispatch("upsert_stage_element", {
      plan: 40,
      el: element("person", { x: 6, y: 5, w: 0.5, h: 0.5 }, { per: 14 }),
    }); // 42
    w.dispatch("upsert_stage_element", {
      plan: 40,
      el: element("mic", { x: 5.5, y: 2.5, w: 0.3, h: 0.3 }, { box: 39, ch: 1 }),
    }); // 43
    w.dispatch("upsert_stage_elements", {
      plan: 40,
      els: [
        element("block", { x: 9, y: 4, w: 2.1, h: 1 }, { per: 15, sec: 1 }), // 44
        element(
          "cable",
          { x: 0, y: 0 },
          {
            box: 39,
            ch: 2,
            pts: [
              [5.5, 2.5],
              [8, 2.5],
              [8, 7],
            ],
          },
        ), // 45
      ],
    });
    // The microphone moved: an element with its own id draws none.
    w.dispatch("upsert_stage_element", {
      plan: 40,
      el: element("mic", { x: 5.75, y: 2.5, w: 0.3, h: 0.3 }, { id: 43, box: 39, ch: 1 }),
    });
    // For a plan the file does not have: dropped before it draws an id.
    w.dispatch("upsert_stage_element", { plan: 99, el: element("rect", { x: 1, y: 1 }) });
    w.dispatch("upsert_stage_element", {
      plan: 40,
      el: element("label", { x: 5, y: 7.5 }, { lb: "Audience" }),
    }); // 46
    w.dispatch("upsert_stage_element", {
      plan: 40,
      el: element(
        "wall",
        { x: 0, y: 0 },
        {
          pts: [
            [0, 0],
            [12, 0],
          ],
        },
      ),
    }); // 47

    // To-dos, one ticked, the second moved to the top.
    w.dispatch("add_todo", { text: "Check the piano's tuning" }); // 48
    w.dispatch("add_todo", { text: "Send the edit list to Tomas" }); // 49
    w.dispatch("toggle_todo", { id: 48 });
    w.dispatch("reorder_todos", { order: [49, 48] });

    // Attachments: a photo of the microphones, and a file attached and taken off again.
    const photo = w.blob("mic-setup.png", samplePng(2, 2));
    w.dispatch("add_attachment", { name: "mic-setup.png", blob: photo }); // 50
    const notes = w.blob("old-notes.txt", new TextEncoder().encode("Nothing here"));
    w.dispatch("add_attachment", { name: "old-notes.txt", blob: notes }); // 51
    w.dispatch("delete_attachment", { id: 51 });

    // An event no family knows, as a newer ControlRoom might write.
    w.dispatch("frobnicate_widget", { level: 11 });

    // Undone, and still redoable: past the head on branch 0, never replayed.
    w.dispatch("add_venue");
    w.dispatch("update_venue", { id: 52, name: "St John's", address: "" });
    w.undo();
    w.undo();

    // The desktop app's view state, never an event.
    for (const [key, value] of [
      ["ui.layout", "1"],
      ["ui.filter", "0"],
      ["ui.scale_mode", "0"],
      ["ui.percent", "100.000000"],
      ["ui.current_pdf", "9"],
      ["ui.pdf.9.page", "2"],
      ["ui.sel_piece", "11"],
      ["ui.sel_movement", "1"],
    ] as const)
      w.kv(key, value);
  } finally {
    w.close();
  }
}

/** The fixture's bytes, as a person would send the file. */
export function croomFixtureBytes(options?: FixtureOptions): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "hekate-croom-fixture-"));
  try {
    const path = join(dir, "Joplin Rags.croom");
    writeCroomFixture(path, options);
    return readFileSync(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { samplePdf } from "../media/sample-pdf.ts";

/**
 * For tests and the visual suite: a small, fictional ControlRoom project file, made when it is
 * needed rather than kept as a binary (#57). It is written to the format as the issue describes
 * it, with the provisional event and field names of decision 242, and nothing in it comes from a
 * real project. It holds a venue and a person, two pieces (one with movements), a session,
 * takes with ratings and a false start, score marks with a take edit, a schedule day, a stage
 * plan with elements, a stage box, an embedded score, view state, an undone event, an event no
 * family knows and a field no family reads.
 */
export interface FixtureEvent {
  type: string;
  payload: Record<string, unknown> | string;
  /** 0 is the project; 1 is undone. */
  branch?: number;
}

/** The fixture's events, in order. Ids follow the shared counter from 1, as the replay expects. */
export function fixtureEvents(): FixtureEvent[] {
  return [
    // 1, 2
    {
      type: "add_venue",
      payload: { name: "Endless Hall", address: "Mill Lane\nBristol", notes: "North door" },
    },
    { type: "add_venue", payload: { name: "Endless Hall Studio 2" } },
    // 3
    { type: "add_category", payload: { name: "Intonation", colour: "signal", key: "1" } },
    // 4: the score, its bytes in the blobs table
    { type: "add_pdf", payload: { name: "Rags - Score.pdf", blob_id: "score-1" } },
    // 5, with 6 and 7 its movements
    {
      type: "add_piece",
      payload: {
        title: "Rags",
        composer: "Scott Joplin",
        forces: "piano",
        abbreviation: "RAGS",
        pdf_id: 4,
        page_offset: 0,
      },
    },
    {
      type: "add_movement",
      payload: { piece_id: 5, title: "Maple Leaf Rag", number: "1", page_from: 1, page_to: 2 },
    },
    {
      type: "add_movement",
      payload: { piece_id: 5, title: "The Entertainer", number: "2", page_from: 3, page_to: 4 },
    },
    // 8: a piece without movements, so a work of one track
    { type: "add_piece", payload: { title: "Opening titles", composer: "Alex Rivera" } },
    // 9
    {
      type: "add_session",
      payload: { name: "Day 1 · Endless Hall", date: "2026-09-12", venue_id: 1 },
    },
    // 10, 11, 12
    {
      type: "add_person",
      payload: {
        name: "Ines Arlow",
        kind: "artist",
        role: "Piano",
        agreement: true,
        headphones: true,
      },
    },
    {
      type: "add_person",
      payload: {
        name: "Endless Hall Strings",
        kind: "ensemble",
        role: "Strings",
        sections: [{ name: "Violin I", count: 4, divisi: "2 + 2", members: ["Tomas Varga"] }],
      },
    },
    {
      type: "add_person",
      payload: { name: "Mira Solberg", kind: "staff", role: "Producer", agreement: true },
    },
    // 13, 14: takes of Maple Leaf Rag; the second rated live and given a false start
    {
      type: "add_take",
      payload: {
        movement_id: 6,
        session_id: 9,
        number: 1,
        rating: 3,
        notes: "Rushed at the trio",
        page: 1,
        bar_from: 1,
        bar_to: 32,
        timecode_in: "10:02:11:04",
      },
    },
    { type: "add_take", payload: { movement_id: 6, session_id: 9, number: 2 } },
    { type: "rate_take", payload: { id: 14, rating: 5 } },
    { type: "add_false_start", payload: { id: 14 } },
    // 15, 16
    {
      type: "add_take",
      payload: { movement_id: 7, session_id: 9, number: 1, rating: 4, starred: true },
    },
    { type: "add_take", payload: { piece_id: 8, session_id: 9, number: 1 } },
    // 17: an issue fixed by take 2; 18: a note made an edit point by a take edit; 19: a lead-in
    {
      type: "add_annotation",
      payload: {
        movement_id: 6,
        kind: "issue",
        page: 1,
        x: 0.2,
        y: 0.3,
        width: 0.2,
        height: 0.1,
        bar_from: 12,
        bar_to: 13,
        text: "Left hand late",
        category_id: 3,
        takes: [1],
        fixed_by: 2,
      },
    },
    {
      type: "add_annotation",
      payload: { movement_id: 6, kind: "note", page: 2, x: 0.5, y: 0.4, text: "Take 2 from here" },
    },
    { type: "add_take_edit", payload: { annotation_id: 18, from: 1, to: 2, bar: 17 } },
    {
      type: "add_annotation",
      payload: { movement_id: 6, kind: "edit", page: 1, x: 0.1, y: 0.1, to: 1 },
    },
    // 20, with 21 to 23 its rows
    {
      type: "add_schedule_day",
      payload: { label: "Day 1", date: "2026-09-12", venue_id: 1, start: "10:00" },
    },
    {
      type: "add_schedule_entry",
      payload: { day_id: 20, kind: "get-in", minutes: 60, label: "Get-in and rig", done: true },
    },
    {
      type: "add_schedule_entry",
      payload: { day_id: 20, kind: "slot", minutes: 90, piece_ids: [5], personnel: [10] },
    },
    {
      type: "add_schedule_entry",
      payload: { day_id: 20, kind: "break", start: "13:00", minutes: 60, label: "Lunch" },
    },
    // 24
    {
      type: "add_stage_box",
      payload: {
        name: "Box A",
        inputs: [
          { channel: 1, source: "Piano L", device: "DPA 4006" },
          { channel: 2, source: "Piano R", device: "DPA 4006" },
        ],
        outputs: [{ channel: 1, source: "Foldback" }],
      },
    },
    // 25, then elements carrying their own ids (40 to 42), which move the counter to 43
    {
      type: "add_stage_plan",
      payload: { name: "Endless Hall", width: 12, depth: 8, grid: 0.5, venue_id: 1 },
    },
    {
      type: "add_stage_element",
      payload: { id: 40, plan_id: 25, kind: "piano", x: 5, y: 3, width: 1.6, height: 2.7 },
    },
    {
      type: "add_stage_element",
      payload: {
        id: 41,
        plan_id: 25,
        kind: "performer",
        x: 6,
        y: 5,
        width: 0.6,
        height: 0.6,
        person_id: 10,
      },
    },
    {
      type: "add_stage_element",
      payload: {
        id: 42,
        plan_id: 25,
        kind: "microphone",
        x: 5.5,
        y: 2.5,
        width: 0.3,
        height: 0.3,
        box_id: 24,
        channel: 1,
      },
    },
    // View state, set aside
    { type: "add_view", payload: { name: "Desk", zoom: 1.5 } },
    // Undone: never replayed, and it draws no id
    { type: "add_venue", payload: { name: "St John's" }, branch: 1 },
    // 43: after the elements; a field no family reads
    {
      type: "add_take",
      payload: { movement_id: 7, session_id: 9, number: 2, mystery_field: "kept out" },
    },
    { type: "rate_take", payload: { id: 43, rating: 2 } },
    // An event no family knows
    { type: "frobnicate_widget", payload: { level: 11 } },
  ];
}

export interface FixtureOptions {
  events?: FixtureEvent[];
  schemaVersion?: string | null;
  /** Leave a table out, to prove the reader refuses the file. */
  without?: "meta" | "events" | "blobs";
  /** The embedded score's bytes; a four-page PDF with bar numbers unless given. */
  score?: Uint8Array;
}

/** Writes the fixture as a `.croom` file at `path`. */
export function writeCroomFixture(path: string, options: FixtureOptions = {}): void {
  const db = new DatabaseSync(path);
  try {
    if (options.without !== "meta") {
      db.exec("create table meta (key text primary key, value text)");
      const meta = db.prepare("insert into meta (key, value) values (?, ?)");
      const events = options.events ?? fixtureEvents();
      if (options.schemaVersion !== null) meta.run("schema_version", options.schemaVersion ?? "1");
      // The head as the last event of the project's branch, by its seq.
      const head = events.reduce((last, e, i) => ((e.branch ?? 0) === 0 ? i + 1 : last), 0);
      meta.run("head", String(head));
      meta.run("ui.zoom", "1.5");
      meta.run("ui.panel", "takes");
    }
    if (options.without !== "events") {
      db.exec(
        "create table events (seq integer primary key autoincrement, ts text, type text not null, payload text, branch integer not null default 0)",
      );
      const insert = db.prepare(
        "insert into events (ts, type, payload, branch) values (?, ?, ?, ?)",
      );
      let minute = 0;
      for (const event of options.events ?? fixtureEvents()) {
        minute += 1;
        insert.run(
          new Date(Date.UTC(2026, 8, 12, 9, minute)).toISOString(),
          event.type,
          typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload),
          event.branch ?? 0,
        );
      }
    } else db.exec("create table things (id integer primary key autoincrement)");
    if (options.without !== "blobs") {
      db.exec("create table blobs (id text primary key, data blob not null)");
      db.prepare("insert into blobs (id, data) values (?, ?)").run(
        "score-1",
        options.score ?? samplePdf(4, { bars: true }),
      );
    }
  } finally {
    db.close();
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

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { parseTimecode, timecodeText } from "./families/takes.ts";
import {
  ALL_REPERTOIRE,
  CroomWriter,
  croomFixtureBytes,
  dump,
  Float,
  writeCroomFixture,
} from "./fixture.ts";
import { imageSize } from "./image-size.ts";
import { type CrAnnotation, ReportCollector } from "./model.ts";
import {
  blockDepth,
  colourOf,
  divisiOf,
  type Existing,
  freeName,
  itemsOf,
  marksOf,
  nothingExisting,
  planImport,
} from "./plan.ts";
import { CroomError, type CroomEvent, CroomTooLarge, openCroom, withCroom } from "./reader.ts";
import { knownEventTypes, replay, replayFile } from "./replay.ts";

const scratch = mkdtempSync(join(tmpdir(), "hekate-croom-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let made = 0;
const pathFor = () => {
  made += 1;
  return join(scratch, `project-${made}.croom`);
};
const fixtureAt = (options?: Parameters<typeof writeCroomFixture>[1]) => {
  const path = pathFor();
  writeCroomFixture(path, options);
  return path;
};
const fixture = () => {
  const source = openCroom(fixtureAt());
  const { file } = source;
  source.close();
  return file;
};

/** Events as the reader hands them over, each payload carrying its type as ControlRoom writes it. */
let seq = 0;
const ev = (
  type: string,
  fields: Record<string, unknown> = {},
  ts: number | null = null,
): CroomEvent => {
  seq += 1;
  return { seq, ts, type, payload: { type, ...fields } };
};

const noBlobs = { blobs: new Map<string, number>(), images: new Map() };

describe("reading a .croom file", () => {
  it("reads ControlRoom's three tables: the project to its head, what was undone, view state and blobs", () => {
    const source = openCroom(fixtureAt());
    try {
      const { file } = source;
      expect(file.schemaVersion).toBe(1);
      // The project is branch 0 up to the head, in order; two undone events lie past it.
      expect(file.events.at(-1)?.seq).toBe(file.head);
      expect(file.events.map((e) => e.seq)).toEqual(
        [...file.events.map((e) => e.seq)].sort((a, b) => a - b),
      );
      expect(file.undone).toBe(3);
      expect(file.redoable).toBe(2);
      expect(file.events.some((e) => JSON.stringify(e.payload).includes("St John's"))).toBe(false);
      expect(file.events.some((e) => JSON.stringify(e.payload).includes("Undone, never"))).toBe(
        false,
      );
      expect(file.viewState).toBe(8);
      expect(file.unknownMeta).toEqual([]);
      // Each event's time in ms, and its payload with its type, as ControlRoom writes them.
      expect(file.events[0]).toMatchObject({
        type: "create_session",
        ts: Date.UTC(2026, 8, 12, 9, 1),
        payload: { type: "create_session", name: "Joplin Rags" },
      });
      expect([...file.blobs.keys()]).toEqual(["1", "2", "3", "4", "5"]);
      expect(file.images.get("3")).toEqual({ width: 400, height: 300 });
      expect(
        Buffer.from(source.blob("1") ?? [])
          .subarray(0, 5)
          .toString(),
      ).toBe("%PDF-");
      expect(source.blob("99")).toBeNull();
    } finally {
      source.close();
    }
  });

  it("replays to the head as ControlRoom's store does: undo, redo, and a new event after an undo", () => {
    const path = pathFor();
    const w = new CroomWriter(path);
    for (const number of [1, 2, 3])
      w.dispatch("add_take", { number, work: 0, movement: 0, pdf: 0 });
    w.undo();
    w.undo();
    const read = () => {
      const source = openCroom(path);
      source.close();
      return source.file;
    };
    // Two undone: past the head, still redoable.
    expect(read()).toMatchObject({ head: 1, undone: 2, redoable: 2 });
    w.redo();
    expect(read()).toMatchObject({ head: 2, undone: 1, redoable: 1 });
    // A new event sets the redo tail aside for good, on branch 1.
    w.dispatch("add_take", { number: 99, work: 0, movement: 0, pdf: 0 });
    w.close();
    const file = read();
    expect(file).toMatchObject({ head: 4, undone: 1, redoable: 0 });
    const { model } = replayFile(file);
    // Take 3 was never replayed, so take 99 is the third entry made: id 3.
    expect([...model.takes.values()].map((t) => [t.id, t.number])).toEqual([
      ["1", 1],
      ["2", 2],
      ["3", 99],
    ]);
  });

  it("opens a project with no events yet, which has no sqlite_sequence table", () => {
    const path = pathFor();
    new CroomWriter(path).close();
    const source = openCroom(path);
    source.close();
    expect(source.file).toMatchObject({ head: 0, events: [], undone: 0 });
  });

  it("refuses a file missing a table or a column, not saying its schema, or not SQLite at all", () => {
    for (const without of ["meta", "events", "blobs"] as const)
      expect(() => openCroom(fixtureAt({ without }))).toThrow(CroomError);
    expect(() => openCroom(fixtureAt({ schemaVersion: null }))).toThrow(/schema/);
    expect(() => openCroom(fixtureAt({ schemaVersion: "soon" }))).toThrow(/schema/);
    const path = pathFor();
    const db = new DatabaseSync(path);
    db.exec(
      "create table meta(key text primary key, value text); create table events(seq integer primary key, ts integer, type text, payload text, branch integer); create table blobs(id integer primary key, data blob);",
    );
    db.close();
    expect(() => openCroom(path)).toThrow(/blobs table has no name, bytes/);
  });

  it("replays everything on the project's branch where the file says no head, and says so", () => {
    const path = fixtureAt();
    const db = new DatabaseSync(path);
    db.exec("delete from meta where key = 'head'");
    db.close();
    const source = openCroom(path);
    source.close();
    expect(source.file).toMatchObject({ head: null, undone: 1, redoable: 0 });
    const { model, report } = replayFile(source.file);
    expect([...model.venues.values()].map((v) => v.name)).toContain("St John's");
    expect(report.report().problems).toContain(
      "The file says no head, as ControlRoom always writes one: every event on the project's branch was replayed",
    );
  });

  it("removes the scratch file whatever happens, and refuses a file past the limit", async () => {
    const work = mkdtempSync(join(scratch, "work-"));
    const bytes = croomFixtureBytes();
    const seen = await withCroom(work, bytes, bytes.length, async (s) => s.file.events.length);
    expect(seen).toBeGreaterThan(10);
    await expect(
      withCroom(work, bytes, bytes.length, async () => {
        throw new Error("in the middle");
      }),
    ).rejects.toThrow("in the middle");
    await expect(withCroom(work, bytes, bytes.length - 1, async () => 0)).rejects.toThrow(
      CroomTooLarge,
    );
    const stream = new Blob([new Uint8Array(bytes)]).stream();
    await expect(withCroom(work, stream, 1024, async () => 0)).rejects.toThrow(CroomTooLarge);
    await expect(
      withCroom(work, new TextEncoder().encode("not a database at all"), 1024, async () => 0),
    ).rejects.toThrow(CroomError);
    expect(readdirSync(work)).toEqual([]);
  });

  it("reads a picture's size from its first bytes, for an underlay's scale", () => {
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c,
      0x01, 0x90, 0x03,
    ]);
    expect(imageSize(jpeg)).toEqual({ width: 400, height: 300 });
    expect(imageSize(Buffer.from("GIF89a\x10\x00\x08\x00", "latin1"))).toEqual({
      width: 16,
      height: 8,
    });
    expect(imageSize(Buffer.from("%PDF-1.7"))).toBeNull();
  });
});

describe("writing a fixture as ControlRoom writes one", () => {
  it("writes payloads as its JSON library does: keys in order, floats as floats, large ids exactly", () => {
    expect(dump({ type: "add_pdf", name: "a.pdf", blob: 1, pages: 4 })).toBe(
      '{"blob":1,"name":"a.pdf","pages":4,"type":"add_pdf"}',
    );
    expect(dump([new Float(5), new Float(1.6), ALL_REPERTOIRE])).toBe(
      "[5.0,1.600000023841858,18446744073709551615]",
    );
  });
});

describe("replaying events", () => {
  it("rebuilds the fixture's project as ControlRoom rebuilds it", () => {
    const { model, report } = replayFile(fixture());
    expect(model.meta).toMatchObject({
      name: "Joplin Rags",
      producer: "Mira Solberg",
      engineer: "Tomas Varga",
      frameRate: "25",
      perScoreTakes: true,
      notes: "Day 1 of 2: the rags, then the titles.",
    });
    expect([...model.categories.values()].map((c) => c.label)).toEqual([
      "Red",
      "Orange",
      "Yellow",
      "Green",
      "Blue",
      "Pink",
    ]);
    expect(model.pieces.get("11")).toMatchObject({
      title: "Rags",
      pdfId: "9",
      movements: [
        { number: "1", title: "Maple Leaf Rag", pageFrom: 1, pageTo: 2 },
        { number: "2", title: "The Entertainer", pageFrom: 3, pageTo: 4 },
      ],
    });
    expect(
      [...model.takes.values()].map((t) => [t.id, t.number, t.workId, t.movement, t.pdfId]),
    ).toEqual([
      ["24", 1, "11", 1, "9"],
      ["25", 2, "11", 1, "9"],
      ["26", 1, "11", 2, "9"],
      ["27", 1, null, 0, "10"],
    ]);
    expect(model.takes.get("24")).toMatchObject({
      lifecycle: "recorded",
      rating: 3,
      notes: "Rushed at the trio",
      timecodeIn: { hours: 10, minutes: 2, seconds: 11, frames: 4 },
      timecodeOut: { hours: 10, minutes: 4, seconds: 40, frames: 12 },
    });
    expect(model.takes.get("25")).toMatchObject({ falseStarts: 1, rating: 5 });
    expect(model.takes.get("26")?.lifecycle).toBe("aborted");
    expect(model.annotations.get("29")).toMatchObject({
      kind: "issue",
      rect: true,
      resolved: true,
      takesAffected: [1],
      takeResolved: 2,
    });
    expect(model.annotations.get("29")?.resolvedAt).not.toBeNull();
    expect(model.annotations.get("33")).toMatchObject({ page: 3, x: 0.62, y: 0.72 });
    expect(model.annotations.has("38")).toBe(false);
    // The producer moved to the top; the person added and removed is gone.
    expect([...model.personnel.values()].map((p) => p.name)).toEqual([
      "Mira Solberg",
      "Ines Arlow",
      "Endless Hall Strings",
    ]);
    expect(model.schedule.map((s) => `${s.id} ${s.kind}`)).toEqual([
      "18 day",
      "19 break",
      "20 slot",
      "22 venue",
      "21 break",
      "23 slot",
    ]);
    expect(model.schedule.at(-1)?.refs).toEqual([{ piece: "all", movement: 0 }]);
    expect(model.stageBoxes.get("39")).toMatchObject({ name: "A" });
    expect(model.stageBoxes.get("39")?.inputs).toHaveLength(32);
    expect(model.stagePlans.get("40")?.elements.map((e) => [e.id, e.kind])).toEqual([
      ["41", "piano"],
      ["42", "person"],
      ["43", "mic"],
      ["44", "block"],
      ["45", "cable"],
      ["46", "label"],
      ["47", "wall"],
    ]);
    // Moved: the microphone kept its id and took its new place.
    expect(model.stagePlans.get("40")?.elements[2]?.x).toBe(5.75);
    expect([...model.todos.values()]).toEqual([
      { id: "49", text: "Send the edit list to Tomas", done: false },
      { id: "48", text: "Check the piano's tuning", done: true },
    ]);
    expect([...model.attachments.keys()]).toEqual(["50"]);
    expect([...model.venues.values()].map((v) => v.name)).toEqual([
      "Endless Hall",
      "Endless Hall Studio 2",
    ]);
    const shown = report.report();
    expect(shown.unknownEvents).toEqual([{ type: "frobnicate_widget", count: 1 }]);
    expect(shown.unknownFields).toEqual([{ type: "update_venue", field: "postcode", count: 1 }]);
    expect(shown.ignored.map((i) => [i.type, i.count])).toEqual([
      ["add_view", 2],
      ["set_active_view", 1],
      ["meta ui.*", 8],
    ]);
    expect(shown.problems).toEqual([
      "upsert_stage_element: names a stage plan that is not in the project, so it changes nothing (as in ControlRoom)",
    ]);
  });

  it("draws ids from ControlRoom's one counter: only events that make an entry, only where they make it", () => {
    const { model, report } = replay([
      ev("create_session", { name: "Joplin Rags" }),
      ev("add_venue"), // 1
      ev("set_meta", { field: "author", value: "Mira Solberg" }),
      ev("add_view", { name: "Desk", builder: "", layout: "", builtin: false }), // 2
      ev("update_venue", { id: 1, name: "Endless Hall", address: "" }),
      // For a plan not in the project: no id drawn.
      ev("upsert_stage_element", { plan: 9, el: { id: 0, k: "rect" } }),
      ev("add_stage_plan"), // 3
      // A new element draws 4; one with its own id keeps it and moves nothing.
      ev("upsert_stage_elements", {
        plan: 3,
        els: [
          { id: 0, k: "mic" },
          { id: 40, k: "piano" },
        ],
      }),
      ev("frobnicate_widget", { level: 11 }),
      ev("add_todo", { text: "Check the piano's tuning" }), // 5
    ]);
    expect([...model.venues.keys()]).toEqual(["1"]);
    expect([...model.stagePlans.keys()]).toEqual(["3"]);
    expect(model.stagePlans.get("3")?.elements.map((e) => e.id)).toEqual(["4", "40"]);
    expect([...model.todos.keys()]).toEqual(["5"]);
    expect(report.report().unknownEvents).toEqual([{ type: "frobnicate_widget", count: 1 }]);
    expect(report.report().problems).not.toContainEqual(expect.stringMatching(/newer ControlRoom/));
  });

  it("warns where an event it does not know may have made an entry in a newer ControlRoom", () => {
    const { model, report } = replay([ev("add_widget", { name: "A" }), ev("add_venue")]);
    // As this ControlRoom replays it: the venue is 1.
    expect([...model.venues.keys()]).toEqual(["1"]);
    expect(report.report().problems).toEqual([
      "The file was written by a newer ControlRoom (it has add_widget): what comes after it may be linked to the wrong entries, so look it over before importing",
    ]);
  });

  it("reads the event type from the payload, as ControlRoom does, and skips one with none", () => {
    const { model, report } = replay([
      { seq: 1, ts: null, type: "add_todo", payload: { type: "add_venue" } },
      { seq: 2, ts: null, type: "add_venue", payload: { name: "No type" } },
      {
        seq: 3,
        ts: null,
        type: "add_take",
        payload: undefined,
        payloadError: "its payload is not JSON",
      },
    ]);
    expect([...model.venues.keys()]).toEqual(["1"]);
    expect(model.todos.size).toBe(0);
    expect(report.report().problems).toEqual([
      "Event 1 is add_todo in the events table and add_venue in its payload: it was read as ControlRoom reads it, as add_venue",
      "Event 2 (add_venue): its payload names no type, so it was skipped, as ControlRoom skips it",
      "Event 3 (add_take): its payload is not JSON, so it was skipped, as ControlRoom skips it",
    ]);
  });

  it("is tolerant of missing fields and fields of the wrong kind, and says what it could not find", () => {
    const { model, report } = replay([
      ev("add_take"),
      ev("add_take", { number: 3, extra: true }),
      ev("set_take_rating", { take: 2, rating: "loud" }),
      ev("set_take_rating", { take: 99, rating: 4 }),
      ev("set_take_rating", { take: 1, rating: 9 }),
      ev("adjust_false_start", { take: 1, delta: -5 }),
    ]);
    expect(model.takes.get("1")).toMatchObject({
      number: 0,
      rating: 5,
      falseStarts: 0,
      workId: null,
    });
    expect(model.takes.get("2")).toMatchObject({ number: 3, rating: 0 });
    const shown = report.report();
    expect(shown.problems).toEqual([
      "set_take_rating: rating is not a number, so it was left out",
      "set_take_rating: names a take that is not in the project, so it changes nothing (as in ControlRoom)",
    ]);
    expect(shown.unknownFields).toEqual([{ type: "add_take", field: "extra", count: 1 }]);
  });

  it("writes an update whole, as ControlRoom does: what it leaves out takes its default", () => {
    const { model } = replay([
      ev("add_piece"),
      ev("update_piece", { id: 1, title: "Rags", composer: "Scott Joplin" }),
      ev("update_piece", { id: 1, title: "Rags, revised" }),
      ev("add_personnel", { kind: "ensemble" }),
      ev("update_personnel", { id: 2, kind: "artist", name: "Endless Hall Strings" }),
    ]);
    expect(model.pieces.get("1")).toMatchObject({ title: "Rags, revised", composer: "" });
    // A person's kind is fixed when they are added.
    expect(model.personnel.get("2")).toMatchObject({
      kind: "ensemble",
      name: "Endless Hall Strings",
    });
  });

  it("reads timecodes against the frame rate set at that point, and clears one that does not fit", () => {
    const { model, report } = replay([
      ev("add_take", { number: 1 }),
      ev("set_meta", { field: "frame_rate", value: "24" }),
      ev("set_take_timecode", { take: 1, in: true, tc: "10:00:00:24" }),
      ev("set_take_timecode", { take: 1, in: false, tc: "10:00:30:23" }),
      ev("set_meta", { field: "frame_rate", value: "48" }),
    ]);
    expect(model.takes.get("1")?.timecodeIn).toBeNull();
    expect(model.takes.get("1")?.timecodeOut).toEqual({
      hours: 10,
      minutes: 0,
      seconds: 30,
      frames: 23,
    });
    expect(model.meta.frameRate).toBe("24");
    expect(report.report().problems).toEqual([
      'set_take_timecode: "10:00:00:24" is not a timecode at 24 frames a second, so it clears the take\'s (as in ControlRoom)',
      'set_meta: "48" is not a frame rate, so it changes nothing (as in ControlRoom)',
    ]);
    expect(parseTimecode("01:02:03;04", "29.97DF")).toEqual({
      hours: 1,
      minutes: 2,
      seconds: 3,
      frames: 4,
    });
    expect(parseTimecode("01:60:00:00", "25")).toBeNull();
    expect(timecodeText({ hours: 1, minutes: 2, seconds: 3, frames: 4 }, "29.97DF")).toBe(
      "01:02:03;04",
    );
  });

  it("orders, moves and removes as ControlRoom does", () => {
    const { model } = replay([
      ev("add_pdf", { name: "Rags.pdf", blob: 1, pages: 4 }), // 1
      ev("add_annotation", { kind: "note", loc: { pdf: 1, page: 0 }, note: "Here" }), // 2
      ev("remove_pdf", { pdf: 1 }),
      ev("add_schedule_item", { kind: "day", index: -1 }), // 3
      ev("add_schedule_item", { kind: "break", index: -1 }), // 4
      ev("add_schedule_item", { kind: "slot", index: 1 }), // 5, between the two
      ev("move_schedule_item", { id: 3, to: 99 }),
      ev("add_todo", { text: "A" }), // 6
      ev("add_todo", { text: "B" }), // 7
      ev("add_todo", { text: "C" }), // 8
      ev("reorder_todos", { order: [8, 99, 6] }),
    ]);
    // A removed score takes its marks with it.
    expect(model.annotations.size).toBe(0);
    expect(model.schedule.map((s) => s.id)).toEqual(["5", "4", "3"]);
    // Ids it names first, unknown ids ignored, the rest after in their order.
    expect([...model.todos.keys()]).toEqual(["8", "6", "7"]);
  });

  it("reads an older file's schedule slot, which names one piece instead of a list", () => {
    const { model } = replay([
      ev("add_schedule_item", { kind: "slot", index: -1 }),
      ev("update_schedule_item", { id: 1, piece: 5, movement: 2, refs: [] }),
    ]);
    expect(model.schedule[0]?.refs).toEqual([{ piece: "5", movement: 2 }]);
  });

  it("knows every event type ControlRoom writes", () => {
    expect([...knownEventTypes].sort()).toEqual(
      [
        "create_session",
        "set_meta",
        "add_pdf",
        "set_pdf_page_offset",
        "remove_pdf",
        "replace_pdf",
        "add_work",
        "add_movement",
        "add_take",
        "delete_take",
        "set_take_lifecycle",
        "set_take_rating",
        "adjust_false_start",
        "set_take_notes",
        "set_take_timecode",
        "add_category",
        "add_annotation",
        "set_annotation_status",
        "set_annotation_note",
        "set_annotation_takes",
        "move_annotation",
        "delete_annotation",
        "add_piece",
        "update_piece",
        "delete_piece",
        "add_venue",
        "update_venue",
        "delete_venue",
        "add_personnel",
        "update_personnel",
        "delete_personnel",
        "move_personnel",
        "add_stagebox",
        "update_stagebox",
        "delete_stagebox",
        "add_stage_plan",
        "update_stage_plan",
        "delete_stage_plan",
        "upsert_stage_element",
        "delete_stage_element",
        "upsert_stage_elements",
        "delete_stage_elements",
        "add_schedule_item",
        "update_schedule_item",
        "delete_schedule_item",
        "move_schedule_item",
        "add_todo",
        "toggle_todo",
        "delete_todo",
        "reorder_todos",
        "set_notes",
        "add_attachment",
        "delete_attachment",
        "add_view",
        "set_active_view",
        "update_view_layout",
        "rename_view",
        "delete_view",
      ].sort(),
    );
  });
});

describe("planning the import", () => {
  const replayed = () => {
    const file = fixture();
    return { file, ...replayFile(file) };
  };

  it("counts what it will create, every kind of the fixture's", () => {
    const { file, model, report } = replayed();
    const plan = planImport(model, file, nothingExisting(), "merge", report);
    expect(Object.fromEntries(plan.counts.map((c) => [c.kind, c.create]))).toEqual({
      work: 2,
      track: 3,
      score: 2,
      file: 2,
      venue: 2,
      personnel: 5,
      session: 1,
      take: 4,
      todo: 2,
      category: 1,
      "score-mark": 9,
      "schedule-day": 1,
      "schedule-row": 5,
      "stage-plan": 1,
      "stage-item": 8,
      "stage-box": 1,
      "patch-row": 3,
    });
    // Movements become tracks of their work; a score the repertoire does not cover, a work of its own.
    expect(plan.works.map((w) => [w.title, w.scoreKey, w.tracks.map((t) => t.name)])).toEqual([
      ["Rags", "pdf:9", ["Maple Leaf Rag", "The Entertainer"]],
      ["Opening titles", "pdf:10", ["Opening titles"]],
    ]);
    expect(plan.works[0]?.composer).toBe("Scott Joplin");
    expect(plan.files.map((f) => [f.name, f.kind, f.purpose])).toEqual([
      ["Joplin Rags - Score.pdf", "document", "score"],
      ["Opening titles.pdf", "document", "score"],
      ["mic-setup.png", "image", "attachment"],
      ["Endless Hall floor plan.png", "image", "underlay"],
    ]);
    // The whole file is one session, numbering per track as each score numbered its own.
    expect(plan.sessions).toEqual([
      {
        key: "session",
        name: "Joplin Rags",
        recordedOn: "2026-09-12",
        notes: "Day 1 of 2: the rags, then the titles.",
        numbering: "per-track",
        trackKeys: ["p11:1", "p11:2", "s10"],
        todos: [
          { text: "Send the edit list to Tomas", done: false },
          { text: "Check the piano's tuning", done: true },
        ],
      },
    ]);
    expect(
      plan.takes.map((t) => [t.trackKey, t.number, t.rating, t.falseStarts, t.lifecycle]),
    ).toEqual([
      ["p11:1", 1, 3, 0, "recorded"],
      ["p11:1", 2, 5, 1, "recorded"],
      ["p11:2", 1, 0, 0, "aborted"],
      ["s10", 1, 0, 0, "recorded"],
    ]);
    expect(plan.takes[0]).toMatchObject({
      timecodeIn: "10:02:11:04",
      timecodeOut: "10:04:40:12",
      wallIn: "2026-09-12T09:49:00.000Z",
    });
    // Each mark on the track whose printed pages it is on.
    expect(
      plan.marks.map((m) => [m.trackKey, m.kind, m.page, m.from, m.to, m.overdub, m.text]),
    ).toEqual([
      ["p11:1", "issue", 1, null, null, false, "Left hand late"],
      ["p11:1", "edit", 1, null, 1, false, null],
      ["p11:1", "edit", 2, 1, 2, false, null],
      ["p11:1", "edit", 2, null, 2, true, null],
      ["p11:2", "note", 4, null, null, false, "Breath before the trio"],
      ["p11:2", "punch-in", 3, null, 1, false, null],
      ["p11:2", "note", 3, null, null, false, "Punch-in"],
      ["p11:1", "ink", 1, null, null, false, null],
      ["s10", "wrong-note", 1, null, null, false, null],
    ]);
    expect(plan.marks[0]).toMatchObject({
      width: 0.2,
      height: 0.1,
      takes: [1],
      fixedBy: 2,
      resolved: true,
      categoryKey: "1",
    });
    expect(plan.marks[7]?.points).toEqual([
      [0.5, 0.5],
      [0.55, 0.55],
      [0.6, 0.5],
    ]);
    // Only the category a mark uses, in Hekate's colours, without ControlRoom's letter key.
    expect(plan.categories).toEqual([
      { key: "1", existingId: null, name: "Red", colour: "signal", shortcut: null },
    ]);
    expect(plan.personnel.map((p) => [p.name, p.kind, p.role])).toEqual([
      ["Mira Solberg", "staff", "Producer"],
      ["Ines Arlow", "artist", "Piano"],
      ["Endless Hall Strings", "ensemble", "Strings"],
      ["Alex Rivera", "other", "Observer"],
      ["Tomas Varga", "staff", "Engineer"],
    ]);
    expect(plan.personnel[2]?.sections).toEqual([
      {
        name: "Violin I",
        count: 2,
        divisi: "1 + 1",
        members: [
          { name: "Tomas Varga", agreement: true, headphones: false },
          { name: "Alex Rivera", agreement: true, headphones: true },
        ],
      },
      { name: "Viola", count: 3, divisi: "", members: [] },
    ]);
    expect(plan.days).toHaveLength(1);
    expect(plan.days[0]).toMatchObject({
      label: "Recording day",
      date: "2026-09-12",
      venueKey: "12",
      start: "09:00",
    });
    expect(
      plan.days[0]?.rows.map((r) => [
        r.kind,
        r.start,
        r.minutes,
        r.label,
        r.allRepertoire,
        r.trackKeys,
        r.done,
      ]),
    ).toEqual([
      ["get-in", "09:00", 60, "Get-In / Setup", false, [], true],
      ["slot", null, 90, "", false, ["p11:1", "p11:2"], false],
      ["venue", null, 0, "Endless Hall Studio 2", false, [], false],
      ["break", "13:00", 60, "Lunch", false, [], false],
      ["slot", null, 120, "", true, [], false],
    ]);
    expect(plan.stageBoxes[0]?.inputs.map((i) => [i.channel, i.source])).toEqual([
      [1, "Piano L"],
      [2, "Piano R"],
    ]);
    expect(plan.stageBoxes[0]?.outputs.map((i) => [i.channel, i.source])).toEqual([
      [1, "Foldback"],
    ]);
    const stage = plan.stagePlans[0];
    expect(stage).toMatchObject({ name: "Endless Hall", width: 12, depth: 8 });
    // 400 pixels at 3 cm a pixel.
    expect(stage?.underlay).toEqual({
      fileKey: "underlay:3",
      x: 0,
      y: 0,
      width: 12,
      opacity: 0.35,
    });
    expect(
      stage?.items.map((i) => [i.kind, i.label, i.x, i.y, i.w, i.h, i.personKey, i.patch, i.group]),
    ).toEqual([
      // A box from its corner; ControlRoom placed it by its centre.
      ["piano", "", 4.2, 1.8, 1.6, 2.4, null, null, ""],
      ["performer", "", 6, 5, 0.5, 0.5, "14", null, "People"],
      ["mic", "", 5.75, 2.5, 0.3, 0.3, null, { boxKey: "39", channel: 1 }, "Mics"],
      // Three singers in one row of a 2.1 m block.
      ["ensemble", "Viola", 7.95, 3.6, 2.1, 0.8, "15", null, "Sections"],
      ["cable", "", 5.5, 2.5, 2.5, 0, null, { boxKey: "39", channel: 2 }, ""],
      ["cable", "", 8, 2.5, 0, 4.5, null, { boxKey: "39", channel: 2 }, ""],
      ["label", "Audience", 5, 7.5, 1.6, 0.4, null, null, ""],
      ["wall", "", 0, -0.1, 12, 0.2, null, null, ""],
    ]);
    const shown = report.report();
    expect(shown.ignored.map((i) => [i.type, i.count])).toEqual([
      ["add_view", 2],
      ["set_active_view", 1],
      ["meta ui.*", 8],
      ["set_meta organisation", 1],
      ["set_meta personal_notes", 1],
      ["update_piece movements.forces, movements.abbr", 1],
      ["update_personnel sections.members.div", 1],
      ["add_category keybind", 1],
      ["add_category", 5],
      ["update_stage_plan venue_id", 1],
      ["update_stage_plan paper", 1],
    ]);
    expect(shown.problems).toEqual([
      "upsert_stage_element: names a stage plan that is not in the project, so it changes nothing (as in ControlRoom)",
      'Punch-in marks name no take, so they are sticky notes saying "Punch-in"',
    ]);
    expect(plan.conflicts).toEqual([]);
  });

  it("merges into what the project has by name, or adds beside it under a free name", () => {
    const existing: Existing = {
      ...nothingExisting(),
      works: [
        { id: "w1", title: "rags", tracks: [{ id: "t1", name: "Maple Leaf Rag", takes: [1] }] },
      ],
      venues: [{ id: "v1", name: "Endless Hall" }],
      stageBoxes: [{ id: "b1", name: "A", inputs: [1], outputs: [] }],
    };
    const merged = (() => {
      const { file, model, report } = replayed();
      const plan = planImport(model, file, existing, "merge", report);
      return { plan, report: report.report() };
    })();
    expect(merged.plan.works[0]).toMatchObject({ existingId: "w1" });
    expect(merged.plan.works[0]?.tracks.map((t) => t.existingId)).toEqual(["t1", null]);
    expect(merged.plan.venues[0]).toMatchObject({ existingId: "v1", name: "Endless Hall" });
    expect(merged.plan.conflicts.map((c) => c.kind)).toEqual(["work", "venue", "stage-box"]);
    // Take 1 of Maple Leaf Rag is there already; the file's is left out, and channel 1 too.
    expect(merged.plan.takes.filter((t) => t.trackKey === "p11:1").map((t) => t.number)).toEqual([
      2,
    ]);
    expect(merged.report.problems).toContain(
      'Take 1 of "Maple Leaf Rag" is there already, so the file\'s was left out',
    );
    expect(merged.plan.stageBoxes[0]?.inputs.map((i) => i.channel)).toEqual([2]);
    // The microphone still finds the channel the box already had.
    expect(merged.plan.stagePlans[0]?.items.find((i) => i.kind === "mic")?.patch).toEqual({
      boxKey: "39",
      channel: 1,
    });

    const { file, model, report } = replayed();
    const added = planImport(model, file, existing, "new", report);
    expect(added.works[0]?.existingId).toBeNull();
    expect(added.venues[0]).toMatchObject({ existingId: null, name: "Endless Hall (2)" });
    expect(added.stageBoxes[0]).toMatchObject({ existingId: null, name: "A (2)" });
  });

  it("places a mark by its page, through the movements' printed pages and the score's offset", () => {
    const { model, report } = replay([
      ev("add_pdf", { name: "Rags.pdf", blob: 1, pages: 9 }), // 1
      ev("set_pdf_page_offset", { pdf: 1, offset: 2 }),
      ev("add_piece"), // 2
      ev("update_piece", {
        id: 2,
        title: "Rags",
        pdf: 1,
        movements: [
          { num: "1", title: "Maple Leaf Rag", p0: 1, p1: 2 },
          // No last page: it runs on to the next movement.
          { num: "2", title: "The Entertainer", p0: 3, p1: 0 },
          { num: "3", title: "Solace", p0: 6, p1: 7 },
        ],
      }),
      // PDF pages 3 and 4 are printed 1 and 2; 5 to 7 printed 3 to 5; 8 and 9 printed 6 and 7.
      ...[2, 3, 4, 6, 8, 0].map((page) =>
        ev("add_annotation", {
          kind: "note",
          loc: { pdf: 1, page, x: 0.5, y: 0.5 },
          note: `p${page}`,
        }),
      ),
    ]);
    const plan = planImport(
      model,
      { blobs: new Map([["1", 10]]), images: new Map() },
      nothingExisting(),
      "merge",
      report,
    );
    expect(plan.works[0]?.pageOffset).toBe(2);
    expect(plan.marks.map((m) => [m.text, m.trackKey, m.page])).toEqual([
      ["p2", "p2:1", 3],
      ["p3", "p2:1", 4],
      ["p4", "p2:2", 5],
      ["p6", "p2:2", 7],
      ["p8", "p2:3", 9],
      ["p0", "p2:1", 1],
    ]);
    expect(report.report().problems).toContain(
      "Marks lie on pages of a score that no movement covers, so they are on the nearest movement",
    );
  });

  it("places takes by what they were recorded under, and those under nothing on a track of their own", () => {
    const { model, report } = replay([
      ev("create_session", { name: "Endless Hall, day 1" }),
      ev("add_piece"), // 1
      ev("update_piece", {
        id: 1,
        title: "Rags",
        movements: [{ num: "1", title: "Maple Leaf Rag" }],
      }),
      ev("add_work", { name: "Opening titles", numbering: "continuous" }), // 2
      ev("add_movement", { work: 2, name: "Main title", base: 1 }), // 3
      ev("add_take", { number: 1, work: 1, movement: 1, pdf: 0 }), // 4
      ev("add_take", { number: 1, work: 2, movement: 3, pdf: 0 }), // 5
      ev("add_take", { number: 1, work: 0, movement: 0, pdf: 0 }), // 6
      ev("add_take", { number: 2, work: 0, movement: 0, pdf: 0 }), // 7
      ev("add_take", { number: 2, work: 0, movement: 0, pdf: 0 }), // 8
      ev("add_take", { number: 0, work: 1, movement: 1, pdf: 0 }), // 9
    ]);
    const plan = planImport(model, noBlobs, nothingExisting(), "merge", report);
    expect(plan.works.map((w) => [w.title, w.tracks.map((t) => t.name)])).toEqual([
      ["Rags", ["Maple Leaf Rag"]],
      ["Opening titles", ["Main title"]],
      ["Endless Hall, day 1", ["Endless Hall, day 1"]],
    ]);
    expect(plan.takes.map((t) => [t.trackKey, t.number])).toEqual([
      ["p1:1", 1],
      ["m3", 1],
      ["session", 1],
      ["session", 2],
    ]);
    expect(plan.sessions[0]?.numbering).toBe("continuous");
    expect(report.report().problems).toEqual(
      expect.arrayContaining([
        "3 takes were recorded under no piece and no score, so they are on a track made for them, named after the session",
        'The file has take 2 of "Endless Hall, day 1" more than once, so only the first was brought over',
        'A take of "Maple Leaf Rag" has no number, so it was left out',
      ]),
    );
  });

  it("writes each kind of mark in Hekate's words", () => {
    const report = new ReportCollector();
    const mark = (over: Partial<CrAnnotation>): CrAnnotation => ({
      id: "1",
      kind: "issue",
      pdfId: "1",
      page: 0,
      rect: false,
      x: 0.5,
      y: 0.5,
      w: 0,
      h: 0,
      categoryId: null,
      note: "",
      resolved: false,
      takesAffected: [],
      takeResolved: null,
      tedit: { takes: [], overdub: false, lead: false },
      ink: [],
      createdAt: null,
      updatedAt: null,
      resolvedAt: null,
      ...over,
    });
    const edits = (tedit: CrAnnotation["tedit"]) =>
      marksOf(mark({ kind: "tedit", tedit }), report).map((m) => [
        m.from ?? null,
        m.to,
        m.overdub ?? false,
      ]);
    // 3T4T5: a hand-over each; a lead-in starts the chain; an overdub lays each take over.
    expect(edits({ takes: [3, 4, 5], overdub: false, lead: false })).toEqual([
      [3, 4, false],
      [4, 5, false],
    ]);
    expect(edits({ takes: [3, 4], overdub: false, lead: true })).toEqual([
      [null, 3, false],
      [3, 4, false],
    ]);
    expect(edits({ takes: [9, 10], overdub: true, lead: false })).toEqual([
      [null, 9, true],
      [null, 10, true],
    ]);
    expect(marksOf(mark({ kind: "take_begin", takesAffected: [7] }), report)).toMatchObject([
      { kind: "take-start", to: 7 },
    ]);
    expect(marksOf(mark({ kind: "take_end" }), report)).toMatchObject([
      { kind: "note", text: "Take end" },
    ]);
    expect(marksOf(mark({ kind: "circled_dynamic", note: "mp" }), report)).toMatchObject([
      { kind: "dynamic", text: "mp" },
    ]);
    expect(marksOf(mark({ kind: "circled_dynamic" }), report)).toMatchObject([{ kind: "issue" }]);
    expect(marksOf(mark({ kind: "note" }), report)).toEqual([]);
    const long = marksOf(
      mark({
        kind: "ink",
        ink: Array.from({ length: 3000 }, (_, i) => [i / 10_000, 0] as [number, number]),
      }),
      report,
    );
    expect(long[0]?.points).toHaveLength(1024);
    expect(long[0]?.points?.[1023]).toEqual([0.5 + 2999 / 10_000, 0.5]);
    expect(report.report().problems).toEqual(
      expect.arrayContaining([
        'Take end marks name no take, so they are sticky notes saying "Take end"',
        "A circled dynamic says no dynamic, so it is an issue",
        "A sticky note says nothing, so it was left out",
      ]),
    );
  });

  it("places stage elements as Hekate does, from ControlRoom's centres", () => {
    const report = new ReportCollector();
    const { model } = replay([]);
    const base = {
      id: "1",
      label: "",
      colour: 0,
      personId: null,
      section: -1,
      member: -1,
      boxId: null,
      channel: 0,
      points: [],
    };
    expect(
      itemsOf({ ...base, kind: "rect", x: 2, y: 2, w: 2, h: 1, rot: 270 }, model, report),
    ).toEqual([{ kind: "rect", label: "", x: 1, y: 1.5, w: 2, h: 1, rotation: -90, group: "" }]);
    expect(
      itemsOf({ ...base, kind: "timp", x: 2, y: 2, w: 0.85, h: 0.85, rot: 0 }, model, report),
    ).toEqual([
      { kind: "timpani", label: "", x: 2, y: 2, w: 0.85, h: 0.85, rotation: 0, group: "" },
    ]);
    expect(
      itemsOf(
        {
          ...base,
          kind: "wall",
          x: 0,
          y: 0,
          w: 1,
          h: 1,
          rot: 0,
          points: [
            [0, 0],
            [0, 4],
          ],
        },
        model,
        report,
      ),
    ).toMatchObject([{ kind: "wall", w: 4, h: 0.2, rotation: 90 }]);
    expect(
      itemsOf({ ...base, kind: "Music stand", x: 1, y: 1, w: 1, h: 1, rot: 0 }, model, report)[0]
        ?.kind,
    ).toBe("music-stand");
    expect(blockDepth(8, 2.1)).toBeCloseTo(2.4);
    expect(blockDepth(0, 2.1)).toBeCloseTo(0.8);
  });

  it("finds Hekate's colour for a category, and how a section divides", () => {
    const packed = (r: number, g: number, b: number) =>
      ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
    expect(
      [
        [235, 70, 70],
        [240, 150, 50],
        [235, 205, 60],
        [90, 200, 110],
        [80, 150, 235],
        [235, 100, 170],
        [128, 128, 128],
      ].map(([r, g, b]) => colourOf(packed(r as number, g as number, b as number))),
    ).toEqual(["signal", "signal", "paper", "green", "blue", "signal", "paper"]);
    expect(divisiOf([{ divisi: "I" }, { divisi: "II" }, { divisi: "I" }, { divisi: "" }])).toBe(
      "2 + 1",
    );
    expect(divisiOf([{ divisi: "I" }])).toBe("");
  });

  it("leaves out what Hekate would refuse, and says so", () => {
    const { model, report } = replay([
      ev("add_piece"),
      ev("add_pdf", { name: "Lost.pdf", blob: 7, pages: 1 }),
      ev("add_annotation", { kind: "issue", loc: { pdf: 99, page: 0 } }),
      ev("add_venue"),
    ]);
    const plan = planImport(model, noBlobs, nothingExisting(), "merge", report);
    expect(plan.files).toHaveLength(0);
    expect(plan.venues).toHaveLength(0);
    expect(plan.works.map((w) => w.title)).toEqual(["Work 1"]);
    expect(report.report().problems).toEqual(
      expect.arrayContaining([
        '"Lost.pdf" has no bytes in the file, so it was left out',
        "A mark is on a score Hekate could not bring over, so it was left out",
        'The venue "4": Name the venue, so it was left out',
      ]),
    );
  });

  it("finds a free name", () => {
    expect(freeName("Endless Hall", [], 80)).toBe("Endless Hall");
    expect(freeName("Endless Hall", ["endless hall", "Endless Hall (2)"], 80)).toBe(
      "Endless Hall (3)",
    );
  });
});

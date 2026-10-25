import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { editNotation } from "./families/score-marks.ts";
import {
  croomFixtureBytes,
  type FixtureEvent,
  fixtureEvents,
  writeCroomFixture,
} from "./fixture.ts";
import { type Existing, freeName, nothingExisting, planImport } from "./plan.ts";
import { CroomError, CroomTooLarge, openCroom, withCroom } from "./reader.ts";
import { normalType, replay, replayFile, verbAndNoun } from "./replay.ts";

const scratch = mkdtempSync(join(tmpdir(), "hekate-croom-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let made = 0;
const fixtureAt = (options?: Parameters<typeof writeCroomFixture>[1]) => {
  made += 1;
  const path = join(scratch, `project-${made}.croom`);
  writeCroomFixture(path, options);
  return path;
};

const events = (list: FixtureEvent[]) =>
  list.map((e, i) => ({
    seq: i + 1,
    ts: null,
    type: e.type,
    payload: typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload,
  }));

describe("reading a .croom file", () => {
  it("opens the four tables, keeps the project's branch in order and counts what was undone", () => {
    const source = openCroom(fixtureAt());
    try {
      expect(source.file.schemaVersion).toBe(1);
      expect(source.file.undone).toBe(1);
      expect(source.file.viewState).toBe(2);
      expect(source.file.events.map((e) => e.seq)).toEqual(
        [...source.file.events.map((e) => e.seq)].sort((a, b) => a - b),
      );
      expect(source.file.events.some((e) => JSON.stringify(e.payload).includes("St John's"))).toBe(
        false,
      );
      expect([...source.file.blobs.keys()]).toEqual(["score-1"]);
      const bytes = source.blob("score-1");
      expect(
        Buffer.from(bytes ?? [])
          .subarray(0, 5)
          .toString(),
      ).toBe("%PDF-");
      expect(source.blob("nothing")).toBeNull();
    } finally {
      source.close();
    }
  });

  it("refuses a file missing a table, or not saying its schema, or not SQLite at all", () => {
    for (const without of ["meta", "events", "blobs"] as const)
      expect(() => openCroom(fixtureAt({ without }))).toThrow(CroomError);
    expect(() => openCroom(fixtureAt({ schemaVersion: null }))).toThrow(/schema/);
    expect(() => openCroom(fixtureAt({ schemaVersion: "soon" }))).toThrow(/schema/);
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
    // As a stream, counted as it arrives.
    const stream = new Blob([new Uint8Array(bytes)]).stream();
    await expect(withCroom(work, stream, 1024, async () => 0)).rejects.toThrow(CroomTooLarge);
    await expect(
      withCroom(work, new TextEncoder().encode("not a database at all"), 1024, async () => 0),
    ).rejects.toThrow(CroomError);
    expect(readdirSync(work)).toEqual([]);
  });
});

describe("replaying events", () => {
  it("rebuilds the fixture's project from its events", () => {
    const { model, report } = replayFile(openCroom(fixtureAt()).file);
    expect([...model.works.values()].map((w) => w.title)).toEqual(["Rags", "Opening titles"]);
    expect([...model.movements.values()].map((m) => [m.title, m.workId])).toEqual([
      ["Maple Leaf Rag", "5"],
      ["The Entertainer", "5"],
    ]);
    expect(model.works.get("5")?.pdfId).toBe("4");
    // Rated live, with a false start.
    expect(model.takes.get("14")).toMatchObject({ number: 2, rating: 5, falseStarts: 1 });
    // The take edit makes the note an edit point from take 1 into take 2 at bar 17.
    expect(model.marks.get("18")).toMatchObject({ kind: "edit", from: 1, to: 2, barFrom: 17 });
    expect(model.personnel.get("11")?.sections[0]).toMatchObject({
      name: "Violin I",
      count: 4,
      members: [{ name: "Tomas Varga" }],
    });
    expect(model.rows.get("22")).toMatchObject({
      kind: "slot",
      workIds: ["5"],
      personnel: "Ines Arlow",
    });
    expect(model.stageElements.get("42")).toMatchObject({ kind: "mic", boxId: "24", channel: 1 });
    // Undone, so never replayed.
    expect([...model.venues.values()].map((v) => v.name)).not.toContain("St John's");
    const shown = report.report();
    expect(shown.unknownEvents).toEqual([{ type: "frobnicate_widget", count: 1 }]);
    expect(shown.unknownFields).toEqual([{ type: "add_take", field: "mystery_field", count: 1 }]);
    expect(shown.ignored.map((i) => i.type)).toEqual(["add_view", "meta ui.*"]);
    expect(shown.problems).toEqual([]);
  });

  it("draws ids from one counter, moved on by the ids stage elements carry", () => {
    const { model } = replayFile(openCroom(fixtureAt()).file);
    // After elements 40 to 42, the next take is 43, and the rating that names it finds it.
    expect(model.takes.get("43")).toMatchObject({ number: 2, rating: 2 });
    const { model: again } = replay(
      events([
        { type: "add_venue", payload: { name: "Endless Hall" } },
        { type: "add_stage_element", payload: { id: 9, kind: "mic", x: 1, y: 1 } },
        { type: "add_venue", payload: { name: "Endless Hall Studio 2" } },
        { type: "add_venue", payload: { id: 4, name: "Given its own" } },
        { type: "add_venue", payload: { name: "After it" } },
      ]),
    );
    expect([...again.venues.keys()]).toEqual(["1", "10", "4", "11"]);
  });

  it("changes and removes what it added, and says what it could not find", () => {
    const { model, report } = replay(
      events([
        { type: "add_piece", payload: { title: "Rags" } },
        { type: "add_movement", payload: { piece_id: 1, title: "Maple Leaf Rag" } },
        { type: "update_piece", payload: { id: 1, composer: "Scott Joplin" } },
        { type: "add_venue", payload: { name: "Endless Hall" } },
        { type: "remove_venue", payload: { id: 3 } },
        { type: "update_take", payload: { id: 99, rating: 4 } },
        { type: "remove_piece", payload: { id: 1 } },
      ]),
    );
    expect(model.works.size).toBe(0);
    // Removing a piece takes its movements with it.
    expect(model.movements.size).toBe(0);
    expect(model.venues.size).toBe(0);
    const shown = report.report();
    expect(shown.problems).toEqual([
      "update_take: changes a take the file never added, so it was skipped",
    ]);
    // A skipped update's fields are not reported as unknown.
    expect(shown.unknownFields).toEqual([]);
  });

  it("is tolerant of missing fields, fields of the wrong kind and payloads that are not JSON", () => {
    const { model, report } = replay([
      { seq: 1, ts: null, type: "add_take", payload: {} },
      { seq: 2, ts: null, type: "add_take", payload: { rating: "loud", number: 3, extra: true } },
      {
        seq: 3,
        ts: null,
        type: "add_take",
        payload: undefined,
        payloadError: "its payload is not JSON",
      },
      { seq: 4, ts: null, type: "AddVenue", payload: { name: "Endless Hall" } },
      { seq: 5, ts: null, type: "venue.removed", payload: { id: 3 } },
    ]);
    expect(model.takes.get("1")).toMatchObject({ number: null, rating: 0, workId: null });
    expect(model.takes.get("2")).toMatchObject({ number: 3, rating: 0 });
    expect(model.venues.size).toBe(0);
    const shown = report.report();
    expect(shown.problems).toContain("add_take: rating is not a number, so it was left out");
    expect(shown.problems).toContain(
      "Event 3 (add_take): its payload is not JSON, so it was skipped",
    );
    expect(shown.unknownFields).toEqual([{ type: "add_take", field: "extra", count: 1 }]);
  });

  it("reads an event type in any of its likely forms", () => {
    expect(normalType("Take.Add")).toBe("take_add");
    expect(normalType("addStageElement")).toBe("add_stage_element");
    expect(verbAndNoun("add_stage_element")).toEqual({ verb: "add", noun: "stage_element" });
    expect(verbAndNoun("take_added")).toEqual({ verb: "add", noun: "take" });
    expect(verbAndNoun("delete_schedule_entry")).toEqual({
      verb: "remove",
      noun: "schedule_entry",
    });
    expect(verbAndNoun("frobnicate")).toBeNull();
  });

  it("reads edits written as Hekate writes them", () => {
    expect(editNotation("T7")).toEqual({ from: null, to: 7, bar: null, overdub: false });
    expect(editNotation("3T12 into T7")).toEqual({ from: 12, to: 7, bar: 3, overdub: false });
    expect(editNotation("T9 over 3T7")).toEqual({ from: 7, to: 9, bar: 3, overdub: true });
    expect(editNotation("3T4")).toBeNull();
  });
});

describe("planning the import", () => {
  const replayed = () => replayFile(openCroom(fixtureAt()).file);

  it("counts what it will create, every kind of the fixture's", () => {
    const { model, report } = replayed();
    const plan = planImport(
      model,
      new Map([["score-1", 1880]]),
      nothingExisting(),
      "merge",
      report,
    );
    const count = Object.fromEntries(plan.counts.map((c) => [c.kind, c.create]));
    expect(count).toEqual({
      work: 2,
      track: 3,
      score: 1,
      venue: 2,
      personnel: 3,
      session: 1,
      take: 5,
      category: 1,
      "score-mark": 3,
      "schedule-day": 1,
      "schedule-row": 3,
      "stage-plan": 1,
      "stage-item": 3,
      "stage-box": 1,
      "patch-row": 3,
    });
    // Movements become tracks of their work; a piece without them, a track of its own.
    expect(plan.works.map((w) => [w.title, w.tracks.map((t) => t.name)])).toEqual([
      ["Rags", ["Maple Leaf Rag", "The Entertainer"]],
      ["Opening titles", ["Opening titles"]],
    ]);
    expect(plan.works[0]?.scoreKey).toBe("4");
    expect(plan.sessions[0]?.trackKeys.sort()).toEqual(["6", "7", "work:8"]);
    expect(plan.stagePlans[0]?.items.find((i) => i.kind === "mic")?.patch).toEqual({
      boxKey: "24",
      channel: 1,
    });
    expect(plan.conflicts).toEqual([]);
  });

  it("merges into what the project has by name, or adds beside it under a free name", () => {
    const existing: Existing = {
      ...nothingExisting(),
      works: [
        { id: "w1", title: "rags", tracks: [{ id: "t1", name: "Maple Leaf Rag", takes: [1] }] },
      ],
      venues: [{ id: "v1", name: "Endless Hall" }],
      stageBoxes: [{ id: "b1", name: "Box A", inputs: [1], outputs: [] }],
    };
    const merged = (() => {
      const { model, report } = replayed();
      const plan = planImport(model, new Map([["score-1", 1]]), existing, "merge", report);
      return { plan, report: report.report() };
    })();
    expect(merged.plan.works[0]).toMatchObject({ existingId: "w1" });
    expect(merged.plan.works[0]?.tracks.map((t) => t.existingId)).toEqual(["t1", null]);
    expect(merged.plan.venues[0]).toMatchObject({ existingId: "v1", name: "Endless Hall" });
    expect(merged.plan.conflicts.map((c) => c.kind)).toEqual(["work", "venue", "stage-box"]);
    // Take 1 of Maple Leaf Rag is there already; the file's is left out, and channel 1 too.
    expect(merged.plan.takes.filter((t) => t.trackKey === "6").map((t) => t.number)).toEqual([2]);
    expect(merged.report.problems).toContain(
      'Take 1 of "Maple Leaf Rag" is there already, so the file\'s was left out',
    );
    expect(merged.plan.stageBoxes[0]?.inputs.map((i) => i.channel)).toEqual([2]);

    const { model, report } = replayed();
    const added = planImport(model, new Map([["score-1", 1]]), existing, "new", report);
    expect(added.works[0]?.existingId).toBeNull();
    expect(added.venues[0]).toMatchObject({ existingId: null, name: "Endless Hall (2)" });
    expect(added.stageBoxes[0]).toMatchObject({ existingId: null, name: "Box A (2)" });
  });

  it("leaves out what Hekate would refuse, and says so", () => {
    const { model, report } = replay(
      events([
        { type: "add_piece", payload: { title: "Rags" } },
        { type: "add_take", payload: { piece_id: 1, number: 1, bar_from: 9, bar_to: 3 } },
        { type: "add_take", payload: { number: 2 } },
        { type: "add_annotation", payload: { piece_id: 1, kind: "note", x: 0.5, y: 0.5 } },
        { type: "add_annotation", payload: { piece_id: 1, kind: "note", page: 1, x: 0.5, y: 0.5 } },
        { type: "add_annotation", payload: { piece_id: 1, kind: "laser", page: 1 } },
        { type: "add_pdf", payload: { name: "Lost.pdf", blob_id: "gone" } },
      ]),
    );
    const plan = planImport(model, new Map(), nothingExisting(), "merge", report);
    expect(plan.takes).toHaveLength(1);
    expect(plan.takes[0]).toMatchObject({ barFrom: null, barTo: null });
    expect(plan.marks).toHaveLength(0);
    expect(plan.scores).toHaveLength(0);
    expect(report.report().problems).toEqual(
      expect.arrayContaining([
        "Take 2 belongs to no piece in the file, so it was left out",
        "Take 1's bars run backwards, so they were left out",
        "A note mark has no page, so it was left out",
        "A note mark on page 1: Write what it says, so it was left out",
        'add_annotation: a "laser" annotation has no kind in Hekate, so it was left out',
        'The PDF "Lost.pdf" has no bytes in the file, so it was left out',
      ]),
    );
  });

  it("finds a free name", () => {
    expect(freeName("Endless Hall", [], 80)).toBe("Endless Hall");
    expect(freeName("Endless Hall", ["endless hall", "Endless Hall (2)"], 80)).toBe(
      "Endless Hall (3)",
    );
  });

  it("is built from the fixture's events alone", () => {
    expect(fixtureEvents().filter((e) => e.branch === 1)).toHaveLength(1);
  });
});

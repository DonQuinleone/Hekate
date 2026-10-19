import { describe, expect, it } from "vitest";
import {
  boardColumnOf,
  boardColumns,
  NO_STATUS,
  NO_VERSION,
  NOT_AT_A_STAGE,
  shiftWeeks,
  timelineBar,
  timelineWeeks,
} from "./board.ts";
import type { WorkflowDefinition } from "./workflows.ts";

const node = (id: string, type: string, name: string, status?: string) => ({
  id,
  type,
  name,
  x: 0,
  y: 0,
  config: status ? { status } : {},
});

// An album's review: the conductor's notes, the engineer's edit, the label's approval.
const album = {
  nodes: [
    node("start", "upload", "A version is uploaded"),
    node("fb", "feedback", "Conductor's notes", "With conductor"),
    node("edit", "task", "Engineer edits", "Editing"),
    node("label", "approval", "Label approval", "With label"),
    node("done", "finish", "Approved", "Approved"),
    node("tell", "notify", "Tell the producer"),
  ],
  connectors: [
    { id: "1", from: "start", outcome: "happened", to: "fb" },
    { id: "2", from: "fb", outcome: "done", to: "edit" },
    { id: "3", from: "edit", outcome: "done", to: "label" },
    { id: "4", from: "label", outcome: "approved", to: "done" },
    { id: "5", from: "label", outcome: "changes", to: "tell" },
  ],
} as WorkflowDefinition;

describe("a board's columns", () => {
  it("by status, in the order a run reaches them, with a finish's as done", () => {
    const columns = boardColumns([album], "status");
    expect(columns.map((c) => c.name)).toEqual([
      NO_VERSION,
      NO_STATUS,
      "With conductor",
      "Editing",
      "With label",
      "Approved",
    ]);
    expect(columns.find((c) => c.name === "Approved")?.category).toBe("done");
    expect(columns[0]?.category).toBe("todo");
  });

  it("count a status as done where a finish sets it, even if a step before sets it too", () => {
    const early = {
      ...album,
      nodes: album.nodes.map((n) =>
        n.id === "label" ? { ...n, config: { status: "Approved" } } : n,
      ),
    } as WorkflowDefinition;
    const columns = boardColumns([early], "status");
    expect(columns.filter((c) => c.name === "Approved")).toEqual([
      { id: "Approved", name: "Approved", category: "done" },
    ]);
    expect(
      boardColumns([album], "status", ["Approved"]).find((c) => c.name === "Approved"),
    ).toMatchObject({ category: "done" });
  });

  it("by stage, every step a track waits at", () => {
    expect(boardColumns([album], "stage").map((c) => c.name)).toEqual([
      NO_VERSION,
      NOT_AT_A_STAGE,
      "Conductor's notes",
      "Engineer edits",
      "Label approval",
    ]);
  });

  it("keep a status tracks still hold that no workflow sets now", () => {
    const names = boardColumns([album], "status", ["Mastering", "Editing"]).map((c) => c.name);
    expect(names).toContain("Mastering");
    expect(names.filter((n) => n === "Editing")).toHaveLength(1);
  });

  it("are the two fixed ones without a workflow", () => {
    expect(boardColumns([], "status").map((c) => c.name)).toEqual([NO_VERSION, NO_STATUS]);
  });
});

describe("where a card sits", () => {
  const card = { version: { number: 2 }, status: "Editing", stage: "Engineer edits" };
  it("follows the grouping, with no version first", () => {
    expect(boardColumnOf(card, "status")).toBe("Editing");
    expect(boardColumnOf(card, "stage")).toBe("Engineer edits");
    expect(boardColumnOf({ ...card, version: null }, "status")).toBe(NO_VERSION);
    expect(boardColumnOf({ ...card, status: null }, "status")).toBe(NO_STATUS);
    expect(boardColumnOf({ ...card, stage: null }, "stage")).toBe(NOT_AT_A_STAGE);
  });
});

describe("a board's timeline", () => {
  it("shows six weeks from the Monday two weeks before", () => {
    // A Wednesday.
    expect(timelineWeeks("2026-10-14")).toEqual([
      "2026-09-28",
      "2026-10-05",
      "2026-10-12",
      "2026-10-19",
      "2026-10-26",
      "2026-11-02",
    ]);
    // A Monday and a Sunday stay in their own week.
    expect(timelineWeeks("2026-10-12")[2]).toBe("2026-10-12");
    expect(timelineWeeks("2026-10-18")[2]).toBe("2026-10-12");
    expect(shiftWeeks("2026-10-14", -3)).toBe("2026-09-23");
  });

  const version = (createdAt: string) => ({ number: 2, fileId: null, createdAt });

  it("runs a bar from the latest version to the review's due date, both days included", () => {
    const bar = timelineBar(
      { version: version("2026-10-01T09:30:00Z"), dueAt: "2026-10-07T17:00:00Z" },
      "2026-09-28",
      42,
    );
    expect(bar).toEqual({
      left: expect.closeTo(3 / 42),
      width: expect.closeTo(7 / 42),
      from: "2026-10-01",
      to: "2026-10-07",
    });
  });

  it("gives a week where no review is due, and a day where one was due before", () => {
    expect(
      timelineBar({ version: version("2026-10-01T09:30:00Z"), dueAt: null }, "2026-09-28", 42)?.to,
    ).toBe("2026-10-08");
    expect(
      timelineBar(
        { version: version("2026-10-10T09:30:00Z"), dueAt: "2026-10-01T00:00:00Z" },
        "2026-09-28",
        42,
      ),
    ).toMatchObject({ width: expect.closeTo(1 / 42), from: "2026-10-10", to: "2026-10-10" });
  });

  it("cuts a bar to the span, and leaves out one wholly outside it or with no version", () => {
    expect(
      timelineBar(
        { version: version("2026-09-20T00:00:00Z"), dueAt: "2026-10-02T00:00:00Z" },
        "2026-09-28",
        42,
      ),
    ).toMatchObject({ left: 0, width: expect.closeTo(5 / 42) });
    expect(
      timelineBar({ version: version("2026-08-01T00:00:00Z"), dueAt: null }, "2026-09-28", 42),
    ).toBeNull();
    expect(timelineBar({ version: null, dueAt: null }, "2026-09-28", 42)).toBeNull();
  });
});

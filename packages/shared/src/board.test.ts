import { describe, expect, it } from "vitest";
import { boardColumnOf, boardColumns, NO_STATUS, NO_VERSION, NOT_AT_A_STAGE } from "./board.ts";
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

import { describe, expect, it } from "vitest";
import {
  boardColumnOf,
  boardColumns,
  boardDefaultInput,
  boardDisplayFor,
  defaultBoardDisplay,
  NO_STATUS,
  NO_VERSION,
  NOT_AT_A_STAGE,
  projectStatuses,
  sameBoardDisplay,
  shiftWeeks,
  timelineBar,
  timelineSpan,
  timelineWeeks,
  trackDeadline,
  workflowStatusesInput,
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

  it("runs to the track's own deadline over its review's (#505)", () => {
    expect(
      timelineBar(
        {
          version: version("2026-10-01T09:30:00Z"),
          dueAt: "2026-10-07T17:00:00Z",
          due: "2026-10-12T17:00:00Z",
        },
        "2026-09-28",
        42,
      ),
    ).toMatchObject({ from: "2026-10-01", to: "2026-10-12" });
    expect(trackDeadline({ dueAt: "2026-10-07T17:00:00Z", due: null })).toBe(
      "2026-10-07T17:00:00Z",
    );
  });

  it("places a range of days as an entry's bar, cut to the span (#505)", () => {
    expect(
      timelineSpan({ startsOn: "2026-10-01", endsOn: "2026-10-03" }, "2026-09-28", 42),
    ).toEqual({ left: expect.closeTo(3 / 42), width: expect.closeTo(3 / 42) });
    expect(timelineSpan({ startsOn: "2026-10-01", endsOn: null }, "2026-09-28", 42)).toEqual({
      left: expect.closeTo(3 / 42),
      width: expect.closeTo(1 / 42),
    });
    expect(
      timelineSpan({ startsOn: "2026-09-20", endsOn: "2026-09-29" }, "2026-09-28", 42),
    ).toEqual({ left: 0, width: expect.closeTo(2 / 42) });
    expect(timelineSpan({ startsOn: "2026-12-01", endsOn: null }, "2026-09-28", 42)).toBeNull();
  });
});

describe("a project's statuses", () => {
  it("are the set, in its order and categories, then those only a step sets", () => {
    const set = [
      { name: "Approved", category: "done" as const },
      { name: "Editing", category: "todo" as const },
      { name: "On hold", category: "todo" as const },
    ];
    expect(projectStatuses(set, [album])).toEqual([
      { name: "Approved", category: "done", steps: 1, kept: true },
      { name: "Editing", category: "todo", steps: 1, kept: true },
      { name: "On hold", category: "todo", steps: 0, kept: true },
      { name: "With conductor", category: "in_progress", steps: 1, kept: false },
      { name: "With label", category: "in_progress", steps: 1, kept: false },
    ]);
    // The board's columns follow them.
    expect(boardColumns([album], "status", [], set).map((c) => [c.name, c.category])).toEqual([
      [NO_VERSION, "todo"],
      [NO_STATUS, "todo"],
      ["Approved", "done"],
      ["Editing", "todo"],
      ["On hold", "todo"],
      ["With conductor", "in_progress"],
      ["With label", "in_progress"],
    ]);
  });

  it("take a step's status in another case as the set's own, spelt as the set spells it", () => {
    const set = [{ name: "EDITING", category: "todo" as const }];
    const statuses = projectStatuses(set, [album]);
    expect(statuses.filter((s) => s.name.toLowerCase() === "editing")).toEqual([
      { name: "EDITING", category: "todo", steps: 1, kept: true },
    ]);
    const names = boardColumns([album], "status", ["editing"], set).map((c) => c.name);
    expect(names.filter((n) => n.toLowerCase() === "editing")).toEqual(["EDITING"]);
  });

  it("with no set, are the ones the steps set", () => {
    expect(projectStatuses([], [album]).map((s) => [s.name, s.category, s.kept])).toEqual([
      ["With conductor", "in_progress", false],
      ["Editing", "in_progress", false],
      ["With label", "in_progress", false],
      ["Approved", "done", false],
    ]);
  });

  it("keep each name once in a set", () => {
    const twice = workflowStatusesInput.safeParse({
      statuses: [
        { name: "Mixing", category: "in_progress" },
        { name: "mixing", category: "done" },
      ],
    });
    expect(twice.success).toBe(false);
  });
});

describe("a board's arrangement", () => {
  const stage = { ...defaultBoardDisplay, groupBy: "stage" as const };
  const quiet = { ...defaultBoardDisplay, comments: false, hidden: ["Done", "Approved"] };

  it("is the person's own choice, else the project's default, else the built-in one", () => {
    expect(boardDisplayFor({ board: quiet, boardChosen: true }, stage)).toEqual(quiet);
    expect(boardDisplayFor({ board: quiet, boardChosen: false }, stage)).toEqual(stage);
    expect(boardDisplayFor({ board: quiet, boardChosen: false }, null)).toEqual(
      defaultBoardDisplay,
    );
    expect(boardDisplayFor({ board: quiet, boardChosen: false }, undefined)).toEqual(
      defaultBoardDisplay,
    );
  });

  it("is the same whatever order its hidden columns are in", () => {
    expect(sameBoardDisplay(quiet, { ...quiet, hidden: ["Approved", "Done"] })).toBe(true);
    expect(sameBoardDisplay(quiet, { ...quiet, hidden: ["Done"] })).toBe(false);
    expect(sameBoardDisplay(defaultBoardDisplay, stage)).toBe(false);
    expect(
      sameBoardDisplay(defaultBoardDisplay, {
        ...defaultBoardDisplay,
        fields: { ...defaultBoardDisplay.fields, due: false },
      }),
    ).toBe(false);
  });

  it("is set as a project's default whole, and nothing else", () => {
    expect(boardDefaultInput.safeParse({ display: stage }).success).toBe(true);
    expect(boardDefaultInput.safeParse({ display: { groupBy: "stage" } }).success).toBe(false);
    expect(boardDefaultInput.safeParse({ display: stage, everyone: true }).success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  filterTasks,
  isOverdue,
  type TaskSummary,
  taskChangeInput,
  taskEventText,
  taskInput,
  taskKey,
  taskRights,
  tasksCsv,
  taskTitleFromComment,
} from "./tasks.ts";

const viewer = (over: Partial<{ userId: string; comment: boolean; triage: boolean }> = {}) => ({
  userId: "u-mira",
  comment: true,
  triage: false,
  ...over,
});

describe("who may do what with a task", () => {
  const task = { createdById: "u-tomas", assigneeId: "u-mira", status: "pending" as const };

  it("lets its creator and triage run it", () => {
    for (const v of [viewer({ userId: "u-tomas" }), viewer({ userId: "u-alex", triage: true })]) {
      const r = taskRights(task, v);
      expect([r.edit, r.delete, r.note]).toEqual([true, true, true]);
      expect(r.statusTo).toEqual(["in_progress", "needs_approval", "done"]);
    }
  });

  it("lets whoever it is for move it along, but not approve their own", () => {
    const mine = taskRights(task, viewer());
    expect([mine.edit, mine.delete, mine.status]).toEqual([false, false, true]);
    expect(mine.statusTo).toContain("done");
    const waiting = taskRights({ ...task, status: "needs_approval" }, viewer());
    expect(waiting.statusTo).toEqual(["pending", "in_progress"]);
    const approver = taskRights(
      { ...task, status: "needs_approval" },
      viewer({ userId: "u-tomas" }),
    );
    expect(approver.statusTo).toContain("done");
    // Running it too changes nothing: nobody approves their own.
    const both = taskRights({ ...task, status: "needs_approval" }, viewer({ triage: true }));
    expect(both.statusTo).toEqual(["pending", "in_progress"]);
    expect(both.edit).toBe(true);
  });

  it("leaves anyone else, and anyone who cannot write, only to read", () => {
    const other = taskRights(task, viewer({ userId: "u-ines" }));
    expect([other.edit, other.status, other.delete, other.note]).toEqual([
      false,
      false,
      false,
      true,
    ]);
    const reader = taskRights(task, viewer({ userId: "u-tomas", triage: true, comment: false }));
    expect([reader.edit, reader.status, reader.delete, reader.note]).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("a task's key and title", () => {
  it("is the project's initials and its number", () => {
    expect(taskKey("Joplin Rags", 3)).toBe("JR-3");
    expect(taskKey("Opening titles", 12)).toBe("OT-12");
    expect(taskKey("Élégie pour violoncelle et orchestre", 1)).toBe("EPV-1");
    expect(taskKey("✓", 2)).toBe("T-2");
  });

  it("from a comment is its first line, cut to fit", () => {
    expect(taskTitleFromComment("\n  Clean the pedal noise at bar 5\nSecond line", "x")).toBe(
      "Clean the pedal noise at bar 5",
    );
    expect(taskTitleFromComment("   ", "Comment on Maple Leaf Rag")).toBe(
      "Comment on Maple Leaf Rag",
    );
    const long = taskTitleFromComment("word ".repeat(60), "x");
    expect(long.length).toBe(120);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("the list's filters", () => {
  const t = (status: TaskSummary["status"], assignee: string | null, dueOn: string | null) => ({
    status,
    assignee: assignee ? { id: assignee } : null,
    dueOn,
  });
  const tasks = [
    t("pending", "u-mira", "2026-10-18"),
    t("done", "u-mira", "2026-10-10"),
    t("in_progress", null, "2026-10-25"),
    t("needs_approval", "u-tomas", null),
  ];

  it("keeps what each says", () => {
    const today = "2026-10-19";
    expect(filterTasks(tasks, "open", "u-mira", today)).toHaveLength(3);
    expect(filterTasks(tasks, "mine", "u-mira", today)).toEqual([tasks[0]]);
    expect(filterTasks(tasks, "unassigned", "u-mira", today)).toEqual([tasks[2]]);
    expect(filterTasks(tasks, "overdue", "u-mira", today)).toEqual([tasks[0]]);
    expect(filterTasks(tasks, "all", "u-mira", today)).toHaveLength(4);
  });

  it("calls a task late only before today, and never once done", () => {
    expect(isOverdue({ dueOn: "2026-10-19", status: "pending" }, "2026-10-19")).toBe(false);
    expect(isOverdue({ dueOn: "2026-10-18", status: "done" }, "2026-10-19")).toBe(false);
  });
});

describe("a task's activity", () => {
  it("reads as what was done", () => {
    expect(taskEventText("assigned", { assignee: "Tomas Varga" })).toBe("gave it to Tomas Varga");
    expect(taskEventText("assigned", { assignee: null })).toBe("left it with nobody");
    expect(taskEventText("status", { from: "needs_approval", to: "done" })).toBe(
      "approved and closed it",
    );
    expect(taskEventText("status", { from: "needs_approval", to: "in_progress" })).toBe(
      "sent it back",
    );
    expect(taskEventText("status", { from: "in_progress", to: "needs_approval" })).toBe(
      "marked it done, waiting for approval",
    );
    expect(taskEventText("edited", { fields: ["title", "due date"] })).toBe(
      "changed the title and due date",
    );
  });
});

describe("what a task may be made with", () => {
  it("needs a title, and refuses a date that is not one", () => {
    expect(taskInput.safeParse({ title: "  " }).success).toBe(false);
    expect(taskInput.parse({ title: "Re-export" }).priority).toBe("normal");
    expect(taskChangeInput.safeParse({ dueOn: "21/10/2026" }).success).toBe(false);
    expect(taskChangeInput.safeParse({ status: "blocked" }).success).toBe(false);
  });
});

describe("tasks as a spreadsheet", () => {
  it("has a row each, quoted where needed, never a formula", () => {
    const row: TaskSummary = {
      id: "t1",
      projectId: "p1",
      number: 3,
      key: "JR-3",
      title: '=HYPERLINK("x"), then "fix"',
      notes: null,
      status: "needs_approval",
      priority: "high",
      assignee: { id: "u", name: "Ines Arlow" },
      dueOn: "2026-10-16",
      track: null,
      file: { id: "f", name: "Cover artwork.png" },
      commentId: "c1",
      fromWorkflow: false,
      createdBy: null,
      createdAt: "2026-10-12T09:00:00.000Z",
      doneAt: null,
      rights: { edit: false, status: false, statusTo: [], delete: false, note: false },
    };
    expect(tasksCsv([row]).split("\r\n")).toEqual([
      "Key,Title,Status,Priority,Owner,Due,About,From,Created",
      `JR-3,"'=HYPERLINK(""x""), then ""fix""",Needs approval,high,Ines Arlow,2026-10-16,Cover artwork.png,A comment,2026-10-12`,
      "",
    ]);
  });
});
